import { webcrypto } from "node:crypto";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CREATE_SESSION_HEADER } from "@/lib/creation-submission-contract";
import { renderWithQuery } from "@/test/render";
import { NativeOperationClient } from "./native-operation-client";

const account = "00000000-0000-4000-8000-000000000001";
const scope = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";
const inputId = "00000000-0000-4000-8000-000000000004";
const outputId = "00000000-0000-4000-8000-000000000005";
const endpoint = "/api/encoding-native/operations";

vi.mock("@/lib/tenant-fetch", () => ({ installTenantFetch: vi.fn() }));

const transport = vi.fn<typeof fetch>();
const operation = vi.fn<(init: RequestInit) => Response>();
beforeEach(() => {
	sessionStorage.clear();
	operation.mockReset();
	transport.mockImplementation(async (input, init) => {
		const path = new URL(String(input), "https://fixture.invalid").pathname;
		if (path === "/api/auth/session")
			return Response.json({
				mode: "users",
				configured: true,
				authenticated: true,
				organizationId: account,
				effectiveUserId: actor,
				role: "ADMIN",
			});
		if (path === "/api/bitmovin-accounts")
			return Response.json([{ id: account, label: "Studio" }]);
		if (path !== endpoint) throw new Error("Unexpected request");
		if (init?.method === "POST") return operation(init);
		return Response.json({ scopeVersion: scope, rows: [] });
	});
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("fetch", transport);
});
afterEach(() => {
	sessionStorage.clear();
	transport.mockReset();
	vi.unstubAllGlobals();
});

function fill(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function select(action: string) {
	const rendering = renderWithQuery(<NativeOperationClient />);
	await screen.findByRole("option", { name: "Studio" });
	fill("Bitmovin account", account);
	fill("Operation", action);
	await screen.findByRole("button", { name: "Submit operation" });
	return rendering;
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Submit operation" }));
}

it("replays the verified storage pair after reopening Watch Folder setup without starting it", async () => {
	const copiedIds = [
		["Name", "Watch smoke"],
		["Akamai NetStorage input ID", inputId],
		["Amazon S3 output ID", outputId],
		["Input path", "incoming"],
		["Output folder prefix", "renders"],
	] as const;
	operation
		.mockImplementationOnce(() => {
			throw new TypeError("lost response");
		})
		.mockReturnValueOnce(
			Response.json({ state: "ACCEPTED", providerId: outputId }),
		);

	const first = await select("create-watch-folder");
	for (const [label, value] of copiedIds) fill(label, value);
	expect(
		screen.queryByRole("checkbox", { name: /Allow this billable operation/ }),
	).toBeNull();
	submit();
	await screen.findByText(/Refresh the operation history/);
	first.unmount();

	await select("create-watch-folder");
	for (const [label, value] of copiedIds) fill(label, value);
	submit();
	expect(await screen.findByText("Accepted by Bitmovin")).toBeInTheDocument();
	expect(operation).toHaveBeenCalledTimes(2);
	const replayed = operation.mock.calls.map(([init]) => ({
		key: new Headers(init.headers).get("Idempotency-Key"),
		body: JSON.parse(String(init.body)),
	}));
	expect(replayed[0]?.key).toBeTruthy();
	expect(replayed[1]).toEqual(replayed[0]);
	expect(replayed[0]?.body).toEqual({
		bitmovinAccountId: account,
		scopeVersion: scope,
		action: "create-watch-folder",
		name: "Watch smoke",
		inputId,
		outputId,
		inputPath: "incoming",
		outputPath: "renders",
	});
});

it("binds a paid run to the selected account, output and explicit consent", async () => {
	operation.mockImplementation((init) => {
		const headers = new Headers(init.headers);
		expect(headers.get(CREATE_SESSION_HEADER)).toBe(
			JSON.stringify([account, actor]),
		);
		expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.parse(String(init.body))).toEqual({
			bitmovinAccountId: account,
			scopeVersion: scope,
			action: "start-template",
			name: "Preview",
			inputId,
			inputPath: "source/clip.mp4",
			outputId,
			outputPath: "renders",
			confirmId: outputId,
			acceptCharges: true,
		});
		return Response.json({ state: "ACCEPTED", providerId: outputId });
	});
	await select("start-template");
	for (const [field, value] of [
		["Name", "Preview"],
		["Input ID", inputId],
		["Input path", "source/clip.mp4"],
		["Output ID", outputId],
		["Output folder prefix", "renders"],
		["Confirm output ID", inputId],
	] as const)
		fill(field, value);
	submit();
	expect(operation).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("checkbox", { name: /Allow this billable operation/ }),
	);
	submit();
	expect(operation).not.toHaveBeenCalled();
	expect(
		await screen.findByText("Check the fields and the confirmation."),
	).toBeInTheDocument();
	fill("Confirm output ID", outputId);
	submit();
	expect(await screen.findByText("Accepted by Bitmovin")).toBeInTheDocument();
	expect(operation).toHaveBeenCalledTimes(1);
});

it("reuses the request ID after losing a response without retaining the Azure key", async () => {
	const secret = "azure-only-secret";
	operation
		.mockImplementationOnce(() => {
			throw new TypeError("lost response");
		})
		.mockReturnValueOnce(
			Response.json({ state: "ACCEPTED", providerId: inputId }),
		);
	await select("create-azure-captions");
	for (const [field, value] of [
		["Name", "Japanese captions"],
		["Speech region", "japaneast"],
		["Language tag", "ja-JP"],
		["Azure Speech key", secret],
	] as const)
		fill(field, value);
	submit();
	expect(
		await screen.findByText(/Refresh the operation history/),
	).toBeInTheDocument();
	expect(JSON.stringify(sessionStorage)).not.toContain(secret);
	submit();
	expect(await screen.findByText("Accepted by Bitmovin")).toBeInTheDocument();
	await waitFor(() => {
		const ids = operation.mock.calls.map(([init]) =>
			new Headers(init.headers).get("Idempotency-Key"),
		);
		expect(ids[0]).toBeTruthy();
		expect(ids).toEqual([ids[0], ids[0]]);
		expect(screen.getByLabelText("Azure Speech key")).toHaveValue("");
	});
});

it("lets a different command start explicitly after a lost response and reload without reusing the old key", async () => {
	operation
		.mockImplementationOnce(() => {
			throw new TypeError("lost response");
		})
		.mockReturnValueOnce(
			Response.json(
				{
					error: "This request already identifies a different operation.",
					details: { code: "NATIVE_OPERATION_KEY_CONFLICT" },
				},
				{ status: 409 },
			),
		)
		.mockReturnValueOnce(
			Response.json({ state: "ACCEPTED", providerId: inputId }),
		);
	const first = await select("create-http-input");
	fill("Name", "Old source");
	fill("Host", "old.example.test");
	submit();
	await screen.findByText(/Refresh the operation history/);
	const original = new Headers(operation.mock.calls[0]?.[0].headers).get(
		"Idempotency-Key",
	);
	expect(original).toBeTruthy();
	first.unmount();

	await select("create-http-input");
	fill("Name", "New source");
	fill("Host", "new.example.test");
	submit();
	const review = await screen.findByRole("button", {
		name: "Prepare a new operation after checking Bitmovin",
	});
	expect(
		new Headers(operation.mock.calls[1]?.[0].headers).get("Idempotency-Key"),
	).toBe(original);
	expect(JSON.stringify(sessionStorage)).toContain(original);
	fireEvent.click(review);
	expect(operation).toHaveBeenCalledTimes(2);
	expect(screen.getByText("Earlier request ID")).toBeInTheDocument();
	submit();
	expect(await screen.findByText("Accepted by Bitmovin")).toBeInTheDocument();
	expect(
		new Headers(operation.mock.calls[2]?.[0].headers).get("Idempotency-Key"),
	).not.toBe(original);
	expect(JSON.stringify(sessionStorage)).toContain(original);
});
