import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		constructor(readonly configuration: unknown) {}
	},
}));

const writeAuditLog = vi.fn<
	(ctx: unknown, entry: unknown, req?: Request) => Promise<void>
>(async () => {});
vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (ctx: unknown, entry: unknown, req?: Request) =>
		writeAuditLog(ctx, entry, req),
}));

import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinErrorMessage,
	bitmovinProxyError,
} from "./bitmovin";

it("binds provider fetches to the selected account and request abort signal", async () => {
	const signal = new AbortController().signal;
	const get = vi.fn(async () => ({ tenantOrgId: "test-tenant" }));
	const revealApiKey = vi.fn(async () => "test-api-key");
	const ctx = { bitmovinAccounts: { get, revealApiKey } } as never;
	const api = (await bitmovinClientForAccount(
		ctx,
		"selected-account",
		signal,
	)) as unknown as {
		configuration: { apiKey: string; tenantOrgId: string; fetch: typeof fetch };
	};
	const transport = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("{}"));
	await api.configuration.fetch("https://api.bitmovin.com/v1/test", {
		method: "GET",
	});
	expect(get).toHaveBeenCalledWith("selected-account");
	expect(revealApiKey).toHaveBeenCalledWith("selected-account");
	expect(api.configuration.tenantOrgId).toBe("test-tenant");
	expect(transport).toHaveBeenCalledWith("https://api.bitmovin.com/v1/test", {
		method: "GET",
		signal,
	});
});

function sdkError(httpStatusCode: number, shortMessage = "upstream said no") {
	return Object.assign(
		new Error("request:\n method: POST\n body: {SHOULD_NOT_LEAK}"),
		{ httpStatusCode, shortMessage },
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("audited infrastructure mutations", () => {
	it.each([
		"/encoding/encodings/enc/reschedule",
		"/encoding/infrastructure/aws",
		"/encoding/infrastructure/static-ips",
		"/encoding/infrastructure/prewarmed-encoder-pools/pool/start",
		"/encoding/infrastructure/prewarmed-encoder-pools/pool/schedules",
		"/encoding/live/standby-pools",
	])("permits %s and audits the provider mutation", async (path) => {
		const call = vi.fn(async () => ({ id: "created" }));
		const result = await auditedBitmovinCall({
			ctx: { prisma: {} } as never,
			bitmovinAccountId: "account",
			method: "POST",
			path,
			call,
			req: new Request("http://test/api/x"),
		});
		expect(result).toEqual({ ok: true, result: { id: "created" } });
		expect(call).toHaveBeenCalledOnce();
		expect(writeAuditLog).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ path, method: "POST", statusCode: 201 }),
			expect.any(Request),
		);
	});
	it.each([
		["DELETE", "/encoding/infrastructure/aws/id"],
		["POST", "/encoding/infrastructure/prewarmed-encoder-pools/pool/stop"],
		["POST", "/encoding/encodings/enc/live/stop"],
	] as const)("preserves cleanup %s %s", async (method, path) => {
		const call = vi.fn(async () => ({ id: "stopped" }));
		expect(
			(
				await auditedBitmovinCall({
					ctx: { prisma: {} } as never,
					bitmovinAccountId: "account",
					method,
					path,
					call,
					req: new Request("http://test/api/x"),
				})
			).ok,
		).toBe(true);
		expect(call).toHaveBeenCalledOnce();
	});
});

describe("bitmovinProxyError", () => {
	it.each([
		404, 409, 422,
	])("passes actionable upstream %s through", async (status) => {
		const res = bitmovinProxyError(sdkError(status));
		expect(res.status).toBe(status);
		expect(JSON.stringify(await res.json())).not.toContain("SHOULD_NOT_LEAK");
	});

	it.each([
		400, 401, 403, 429, 500, 503,
	])("maps upstream %s to 502 (never reflected as our own status)", async (status) => {
		const res = bitmovinProxyError(sdkError(status));
		expect(res.status).toBe(502);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("upstream said no");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
	});

	it("answers 500 with a generic body and logs when the error has no httpStatusCode", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const res = bitmovinProxyError(new TypeError("boom from our own code"));
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body).toEqual({ error: "Internal error calling Bitmovin" });
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(String(consoleError.mock.calls[0])).toContain(
			"boom from our own code",
		);
	});
});

describe("bitmovinErrorMessage", () => {
	it("prefers the API's own shortMessage, truncated", () => {
		expect(bitmovinErrorMessage(sdkError(409, "x".repeat(400)))).toBe(
			`Bitmovin: ${"x".repeat(300)}`,
		);
	});

	it("falls back to the status code, never the raw SDK string", () => {
		const err = Object.assign(new Error("raw {SHOULD_NOT_LEAK}"), {
			httpStatusCode: 418,
		});
		expect(bitmovinErrorMessage(err)).toBe("Bitmovin API error (418)");
	});

	it("labels non-HTTP failures unreachable (proxy mapping logs the detail)", () => {
		expect(bitmovinErrorMessage(new Error("ECONNREFUSED"))).toBe(
			"Bitmovin API unreachable",
		);
	});
});

/**
 *  — the HANDLER's request must reach the audit row, not merely
 * "a Request".
 *
 * The type this PR added forces an argument to EXIST; it cannot force it to
 * be the right one. security-review-212 proved that gap by replacing `req`
 * here with `new Request("https://mutant.invalid/")` — a Request carrying no
 * actor header — and all 2,416 web tests stayed green. That is the same 33
 * route files the original defect covered, one refactor away, silently.
 */
describe("auditedBitmovinCall forwards the HANDLER's request (ledger #81)", () => {
	const ACTOR = "token:00000000-0000-4000-8000-0000000000ac";
	const ctx = { prisma: {} } as never;

	function req() {
		return new Request("https://x/api/infrastructure/static-ips/abc", {
			method: "DELETE",
			headers: { "x-bitovp-actor": ACTOR },
		});
	}

	it("passes it on the SUCCESS path", async () => {
		writeAuditLog.mockClear();
		await auditedBitmovinCall({
			req: req(),
			ctx,
			bitmovinAccountId: "acct",
			method: "POST",
			path: "/encoding/thing",
			call: async () => ({ id: "made" }),
		});
		const forwarded = writeAuditLog.mock.calls[0]?.[2] as Request | undefined;
		expect(forwarded?.headers.get("x-bitovp-actor")).toBe(ACTOR);
	});

	it("passes it on the FAILURE path too — the audit row an incident is read from", async () => {
		writeAuditLog.mockClear();
		await auditedBitmovinCall({
			req: req(),
			ctx,
			bitmovinAccountId: "acct",
			method: "DELETE",
			path: "/encoding/thing",
			call: async () => {
				throw sdkError(404);
			},
		});
		const forwarded = writeAuditLog.mock.calls[0]?.[2] as Request | undefined;
		expect(forwarded?.headers.get("x-bitovp-actor")).toBe(ACTOR);
	});
});
