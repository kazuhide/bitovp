import { webcrypto } from "node:crypto";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageAccessGate } from "@/components/page-access-gate";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import type { NativeCodecReceipt } from "@/lib/native-codec-configurations";
import { renderWithQuery } from "@/test/render";
import { NativeCodecClient } from "./native-codec-client";

const account = "00000000-0000-4000-8000-000000000001";
const scope = "00000000-0000-4000-8000-000000000002";
const providerId = "00000000-0000-4000-8000-000000000003";
const actor = "00000000-0000-4000-8000-000000000004";
const otherActor = "00000000-0000-4000-8000-000000000005";
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

function sessionResponse(effectiveUserId = actor) {
	return Response.json({
		mode: "users",
		configured: true,
		authenticated: true,
		organizationId: account,
		effectiveUserId,
		role: "ADMIN",
	});
}

function installFixture({
	loseFirstReply = false,
	canResumeCreate = false,
} = {}) {
	let receipt: NativeCodecReceipt | undefined;
	let loseReply = loseFirstReply;
	let nextSession: Promise<Response> | undefined;
	transport.mockImplementation(async (input, init) => {
		const url = new URL(String(input), "https://test.invalid");
		if (url.pathname === "/api/auth/session") {
			const response = nextSession ?? sessionResponse();
			nextSession = undefined;
			return response;
		}
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
						canResumeCreate: !previous && canResumeCreate,
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
				expect(JSON.parse(String(init.body))).toEqual({
					id: receipt.id,
					bitmovinAccountId: account,
					scopeVersion: scope,
					...(receipt.canResumeCreate && { resume: true }),
				});
				receipt = {
					...receipt,
					state: "ACTIVE",
					providerId,
					canResumeCreate: false,
				};
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
		deferSession(reply: Promise<Response>) {
			nextSession = reply;
		},
		reconcileElsewhere() {
			if (!receipt) throw new Error("Missing receipt");
			receipt = {
				...receipt,
				state: "ACTIVE",
				providerId,
				canResumeCreate: false,
			};
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

function renderRestrictedEditor() {
	return renderWithQuery(
		<PageAccessGate pathname="/settings/encoding-native/codecs">
			<NativeCodecClient />
		</PageAccessGate>,
	);
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

it("keeps a same-admin draft mounted and gates submission throughout session verification", async () => {
	const fixture = installFixture();
	const user = userEvent.setup();
	const { client } = renderRestrictedEditor();
	await selectAccount(user);
	await enterConfiguration(user);

	const refresh = Promise.withResolvers<Response>();
	fixture.deferSession(refresh.promise);
	act(() => {
		void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
	});
	await waitFor(() => expect(createButton()).toBeDisabled());
	expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(configName);
	expect(screen.getByRole("spinbutton", { name: "Bitrate (bps)" })).toHaveValue(
		128000,
	);
	await user.click(createButton());
	expect(posts()).toHaveLength(0);

	await act(async () => refresh.resolve(sessionResponse()));
	await waitFor(() => expect(createButton()).toBeEnabled());
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Creation pending",
	);
	expect(posts()).toHaveLength(1);
	expect(posts()[0]?.body).toMatchObject({ name: configName, bitrate: 128000 });
});

it("discards the old draft when refreshed session belongs to a different admin", async () => {
	const fixture = installFixture();
	const user = userEvent.setup();
	const { client } = renderRestrictedEditor();
	await selectAccount(user);
	await enterConfiguration(user);

	fixture.deferSession(Promise.resolve(sessionResponse(otherActor)));
	await act(async () => {
		await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
	});
	await waitFor(() =>
		expect(
			screen.getByRole("combobox", { name: "Bitmovin account" }),
		).toHaveValue(""),
	);
	expect(
		screen.queryByRole("textbox", { name: "Name" }),
	).not.toBeInTheDocument();
	await selectAccount(user);
	expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
	expect(posts()).toHaveLength(0);
});

it("withholds the POST if session verification is invalidated during key preparation", async () => {
	installFixture();
	const user = userEvent.setup();
	const { client } = renderRestrictedEditor();
	await selectAccount(user);
	await enterConfiguration(user);

	const digest = Promise.withResolvers<ArrayBuffer>();
	const prepare = vi.fn(() => digest.promise);
	vi.stubGlobal("crypto", {
		subtle: { digest: prepare },
		randomUUID: () => webcrypto.randomUUID(),
	});
	await user.click(createButton());
	await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
	await act(async () => {
		await client.invalidateQueries({
			queryKey: SESSION_QUERY_KEY,
			refetchType: "none",
		});
		digest.resolve(new ArrayBuffer(32));
	});
	await screen.findByRole("alert");
	expect(posts()).toHaveLength(0);
});

it("sends the selected H.262 profile with the required target bitrate", async () => {
	installFixture();
	const user = userEvent.setup();
	renderWithQuery(<NativeCodecClient />);
	await selectAccount(user);
	await user.selectOptions(
		screen.getByRole("combobox", { name: "Codec" }),
		"h262",
	);
	expect(screen.getByRole("combobox", { name: "Profile" })).toHaveValue(
		"MPEG2_422",
	);
	const bitrate = screen.getByRole("spinbutton", {
		name: "Target bitrate (bps)",
	});
	expect(bitrate).toBeRequired();
	await user.type(screen.getByRole("textbox", { name: "Name" }), "Broadcast");
	await user.type(bitrate, "50000000");
	await user.click(createButton());
	await screen.findByRole("status");
	expect(posts()).toHaveLength(1);
	expect(posts()[0]?.body).toMatchObject({
		codec: "h262",
		name: "Broadcast",
		bitrate: 50000000,
		profile: "MPEG2_422",
	});
});

it("takes an explicit resume action for a reserved codec creation", async () => {
	installFixture({ canResumeCreate: true });
	const user = userEvent.setup();
	renderWithQuery(<NativeCodecClient />);
	await selectAccount(user);
	await enterConfiguration(user);
	await user.click(createButton());
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Creation pending",
	);
	const resume = await screen.findByRole("button", { name: "Resume creation" });
	await waitFor(() => expect(resume).toBeEnabled());
	await user.click(resume);
	expect(await screen.findByRole("status")).toHaveTextContent("Active");
	expect(
		transport.mock.calls.filter(([, init]) => init?.method === "PATCH"),
	).toHaveLength(1);
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
