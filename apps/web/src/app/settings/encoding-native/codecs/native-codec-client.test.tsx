import { webcrypto } from "node:crypto";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeCodecReceipt } from "@/lib/native-codec-configurations";
import { renderWithQuery } from "@/test/render";
import { NativeCodecClient } from "./native-codec-client";

const account = "00000000-0000-4000-8000-000000000001";
const scope = "00000000-0000-4000-8000-000000000002";
const providerId = "00000000-0000-4000-8000-000000000003";
const actor = "00000000-0000-4000-8000-000000000004";
const endpoint = "/api/encoding-native/codecs";
const configName = "Studio MP3";

vi.mock("@/lib/tenant-fetch", () => ({ installTenantFetch: vi.fn() }));

const transport = vi.fn<typeof fetch>();

beforeEach(() => {
	sessionStorage.clear();
	transport.mockReset();
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("fetch", transport);
});

afterEach(() => {
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

function installFixture({ loseFirstReply = false } = {}) {
	let receipt: NativeCodecReceipt | undefined;
	let loseReply = loseFirstReply;
	transport.mockImplementation(async (input, init) => {
		const url = new URL(String(input), "https://test.invalid");
		if (url.pathname === "/api/auth/session")
			return Response.json({
				mode: "users",
				configured: true,
				authenticated: true,
				organizationId: account,
				effectiveUserId: actor,
				role: "ADMIN",
			});
		if (url.pathname === "/api/bitmovin-accounts")
			return Response.json([{ id: account, label: "Studio" }]);
		if (url.pathname !== endpoint) throw new Error("Unexpected request");

		switch (init?.method) {
			case "POST": {
				const key = new Headers(init.headers).get("Idempotency-Key");
				if (!key) throw new Error("Missing idempotency key");
				if (receipt?.id === key && receipt.state === "REMOVED")
					return Response.json(
						{ error: "Configuration removed" },
						{ status: 410 },
					);
				if (receipt?.id !== key) {
					const previous = receipt !== undefined;
					receipt = {
						id: key,
						codec: "mp3",
						name: configName,
						state: previous ? "ACTIVE" : "CREATING",
						providerId: previous ? providerId : null,
						canAct: true,
						canRetryDelete: false,
					};
				}
				if (loseReply) {
					loseReply = false;
					throw new TypeError("Network error");
				}
				return Response.json(receipt, {
					status: receipt.state === "CREATING" ? 202 : 201,
				});
			}
			case "PATCH": {
				if (!receipt) throw new Error("Missing receipt");
				expect(JSON.parse(String(init.body)).id).toBe(receipt.id);
				receipt = { ...receipt, state: "ACTIVE", providerId };
				return Response.json(receipt);
			}
			case "DELETE": {
				if (!receipt) throw new Error("Missing receipt");
				expect(JSON.parse(String(init.body))).toMatchObject({
					id: receipt.id,
					confirmProviderId: providerId,
				});
				receipt = { ...receipt, state: "REMOVED" };
				return Response.json(receipt);
			}
			default:
				return Response.json({
					rows: receipt ? [receipt] : [],
					hasMore: false,
					scopeVersion: scope,
				});
		}
	});
	return {
		reconcileElsewhere() {
			if (!receipt) throw new Error("Missing receipt");
			receipt = { ...receipt, state: "ACTIVE", providerId };
		},
		removeElsewhere() {
			if (!receipt) throw new Error("Missing receipt");
			receipt = { ...receipt, state: "REMOVED", providerId };
		},
	};
}

function createButton() {
	return screen.getByRole("button", { name: "Create configuration" });
}

async function selectAccount(user: ReturnType<typeof userEvent.setup>) {
	await screen.findByRole("option", { name: "Studio" });
	await user.selectOptions(
		screen.getByRole("combobox", { name: "Bitmovin account" }),
		account,
	);
	await screen.findByRole("button", { name: "Create configuration" });
}

async function enterConfiguration(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByRole("textbox", { name: "Name" }), configName);
	await user.type(
		screen.getByRole("spinbutton", { name: "Bitrate (bps)" }),
		"128000",
	);
}

function posts() {
	return transport.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.map(([, init]) => ({
			key: new Headers(init?.headers).get("Idempotency-Key"),
			body: JSON.parse(String(init?.body)),
		}));
}

it.each([
	"this tab",
	"another tab",
])("recreates the same configuration after reconciliation in %s and removal", async (reconciledIn) => {
	const fixture = installFixture({ loseFirstReply: true });
	const user = userEvent.setup();
	const firstView = renderWithQuery(<NativeCodecClient />);
	await selectAccount(user);
	await enterConfiguration(user);
	await user.click(createButton());
	await screen.findByRole("alert");
	await waitFor(() => expect(createButton()).toBeEnabled());
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Creation pending",
	);
	const [first, retry] = posts();
	expect(first).toBeDefined();
	expect(retry).toEqual(first);

	if (reconciledIn === "another tab") fixture.reconcileElsewhere();
	firstView.unmount();
	renderWithQuery(<NativeCodecClient />);
	await selectAccount(user);
	if (reconciledIn === "this tab") {
		await user.click(
			await screen.findByRole("button", { name: "Check provider" }),
		);
		expect(await screen.findByRole("status")).toHaveTextContent("Active");
		expect(sessionStorage.length).toBe(0);
	}
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled(),
	);
	await user.click(screen.getByRole("button", { name: "Remove" }));
	await user.type(
		screen.getByRole("textbox", { name: "Confirm provider ID" }),
		providerId,
	);
	const [, confirmRemove] = screen.getAllByRole("button", { name: "Remove" });
	if (!confirmRemove) throw new Error("Missing removal confirmation");
	await user.click(confirmRemove);
	expect(await screen.findByRole("status")).toHaveTextContent("Removed");
	await waitFor(() => expect(createButton()).toBeEnabled());
	await enterConfiguration(user);
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent("Active");
	expect(posts()).toHaveLength(3);
	expect(posts()[2]?.body).toEqual(first?.body);
	expect(posts()[2]?.key).not.toBe(first?.key);
});

it("retires a definitively removed submission key and waits for an explicit resubmit", async () => {
	const fixture = installFixture();
	const user = userEvent.setup();
	renderWithQuery(<NativeCodecClient />);
	await selectAccount(user);
	await enterConfiguration(user);
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Creation pending",
	);
	fixture.removeElsewhere();

	await waitFor(() => expect(createButton()).toBeEnabled());
	await user.click(createButton());
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Submit again to create it.",
	);
	await waitFor(() => expect(createButton()).toBeEnabled());
	expect(posts()).toHaveLength(2);
	expect(posts()[1]).toEqual(posts()[0]);
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent("Active");
	expect(posts()).toHaveLength(3);
	expect(posts()[2]?.body).toEqual(posts()[0]?.body);
	expect(posts()[2]?.key).not.toBe(posts()[0]?.key);
});
