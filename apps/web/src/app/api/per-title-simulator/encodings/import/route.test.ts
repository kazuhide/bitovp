import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	admin: vi.fn(),
	context: vi.fn(),
	accountGet: vi.fn(),
	accountReveal: vi.fn(),
	httpPort: vi.fn(),
	load: vi.fn(),
	project: vi.fn(),
}));

vi.mock("@/lib/auth/tenancy", () => ({
	requireOrganizationAdmin: mocks.admin,
	AuthContextError: class AuthContextError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
		}
	},
}));
vi.mock("@/lib/server/context", () => ({
	contextForOrganization: mocks.context,
}));
vi.mock("@/lib/server/per-title-encoding-http", () => ({
	createPerTitleEncodingHttpPort: mocks.httpPort,
}));
vi.mock("@/lib/server/per-title-encoding-loader", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/server/per-title-encoding-loader")
	>()),
	loadPerTitleEncodingSnapshot: mocks.load,
}));
vi.mock("@bitmovin/api-sdk", () => ({
	default: class BitmovinApi {
		constructor() {
			throw new Error(
				"SDK model deserialization is forbidden for raw settings import",
			);
		}
	},
}));
vi.mock("@/app/vod/new/per-title-encoding-import", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/app/vod/new/per-title-encoding-import")
	>()),
	projectPerTitleEncodingImport: mocks.project,
}));

import { AuthContextError } from "@/lib/auth/tenancy";
import { POST } from "./route";

const encodingId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const tenantOrgId = "00000000-0000-4000-8000-000000000003";
const apiKey = "ephemeral-test-api-key";
const snapshot = { startRequest: {}, streams: [] };
const projected = { configurations: [], issues: [] };
const tenant = {
	organizationId: "app-organization",
	role: "ADMIN",
	isImpersonating: false,
};
const context = {
	bitmovinAccounts: {
		get: mocks.accountGet,
		revealApiKey: mocks.accountReveal,
	},
};
const readPort = { source: "raw-http-read-port" };

function request(
	body: unknown = { encodingId, bitmovinAccountId: accountId },
	init: RequestInit = {},
) {
	return new Request(
		"http://localhost:3100/api/per-title-simulator/encodings/import",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...init,
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.admin.mockResolvedValue(tenant);
	mocks.context.mockReturnValue(context);
	mocks.accountGet.mockResolvedValue({ tenantOrgId });
	mocks.accountReveal.mockResolvedValue("stored-fixture-api-key");
	mocks.httpPort.mockReturnValue(readPort);
	mocks.load.mockResolvedValue(snapshot);
	mocks.project.mockReturnValue(projected);
});

afterEach(() => vi.restoreAllMocks());

describe("POST Per-Title encoding import", () => {
	it("binds stored account access to the independently verified organization and projects its reads", async () => {
		const res = await POST(request());
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(await res.json()).toEqual(projected);
		expect(mocks.admin).toHaveBeenCalledWith(expect.any(Headers));
		expect(mocks.context).toHaveBeenCalledWith(
			tenant.organizationId,
			false,
			tenant,
		);
		expect(mocks.accountGet).toHaveBeenCalledWith(accountId);
		expect(mocks.accountReveal).toHaveBeenCalledWith(accountId);
		expect(mocks.httpPort).toHaveBeenCalledWith({
			apiKey: "stored-fixture-api-key",
			tenantOrgId,
			signal: expect.any(AbortSignal),
		});
		expect(mocks.load).toHaveBeenCalledWith(readPort, encodingId, {
			signal: expect.any(AbortSignal),
		});
		expect(mocks.project).toHaveBeenCalledExactlyOnceWith(snapshot);
	});

	it("uses a temporary key only in the read port and does not save or reveal an account", async () => {
		const res = await POST(request({ encodingId, apiKey, tenantOrgId }));
		expect(res.status).toBe(200);
		expect(mocks.httpPort).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey,
				tenantOrgId,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(mocks.context).not.toHaveBeenCalled();
		expect(mocks.accountGet).not.toHaveBeenCalled();
		expect(mocks.accountReveal).not.toHaveBeenCalled();
		expect(JSON.stringify(await res.json())).not.toContain(apiKey);
	});

	it("does not invent a tenant organization when the stored account has none", async () => {
		mocks.accountGet.mockResolvedValue({ tenantOrgId: null });
		const res = await POST(request());
		expect(res.status).toBe(200);
		expect(mocks.httpPort).toHaveBeenCalledWith({
			apiKey: "stored-fixture-api-key",
			signal: expect.any(AbortSignal),
		});
	});

	it("rejects an unauthorized direct handler invocation before any body or provider work", async () => {
		mocks.admin.mockRejectedValue(
			new AuthContextError(403, "Administrator required"),
		);
		const res = await POST(request());
		expect(res.status).toBe(403);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(mocks.load).not.toHaveBeenCalled();
		expect(mocks.accountGet).not.toHaveBeenCalled();
	});

	it.each([
		{ encodingId, bitmovinAccountId: accountId, apiKey },
		{ encodingId, bitmovinAccountId: accountId, tenantOrgId },
		{ encodingId },
		{ encodingId: "../encoding", apiKey },
		{ encodingId, apiKey, other: true },
	])("rejects an invalid or ambiguous import request (%j)", async (body) => {
		const res = await POST(request(body));
		expect(res.status).toBe(400);
		expect(mocks.load).not.toHaveBeenCalled();
		expect(mocks.accountGet).not.toHaveBeenCalled();
		expect(JSON.stringify(await res.json())).not.toContain(apiKey);
	});

	it("requires JSON and bounds declared and streamed request bodies", async () => {
		expect(
			(await POST(request({}, { headers: { "content-type": "text/plain" } })))
				.status,
		).toBe(415);
		const oversized = await POST(
			request(
				{},
				{
					headers: {
						"content-type": "application/json",
						"content-length": "9000",
					},
				},
			),
		);
		expect(oversized.status).toBe(413);
		expect((await POST(request({ padding: "x".repeat(9000) }))).status).toBe(
			413,
		);
		expect(mocks.load).not.toHaveBeenCalled();
	});

	it("does not use an account outside the selected organization", async () => {
		mocks.accountGet.mockResolvedValue(null);
		const res = await POST(request());
		expect(res.status).toBe(404);
		expect(mocks.load).not.toHaveBeenCalled();
		expect(mocks.accountReveal).not.toHaveBeenCalled();
		expect(mocks.httpPort).not.toHaveBeenCalled();
	});

	it.each([
		401, 403, 404, 429, 500,
	])("curates an upstream %s without logging or reflecting SDK errors", async (httpStatusCode) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.load.mockRejectedValue(
			Object.assign(
				new Error(`API key ${apiKey} tenant ${tenantOrgId} raw request body`),
				{ httpStatusCode, shortMessage: apiKey },
			),
		);
		const res = await POST(request());
		expect(res.status).toBe(httpStatusCode === 404 ? 404 : 502);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		const body = JSON.stringify(await res.json());
		expect(body).not.toContain(apiKey);
		expect(body).not.toContain(tenantOrgId);
		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not log an unclassified SDK failure", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.load.mockRejectedValue(new Error(`private ${apiKey}`));
		const res = await POST(request());
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain(apiKey);
		expect(error).not.toHaveBeenCalled();
	});

	it("stops an already canceled browser request before creating a provider client", async () => {
		const controller = new AbortController();
		controller.abort();
		const res = await POST(request(undefined, { signal: controller.signal }));
		expect(res.status).toBe(408);
		expect(mocks.accountGet).not.toHaveBeenCalled();
		expect(mocks.load).not.toHaveBeenCalled();
	});

	it("reports a shared deadline without exposing its underlying failure", async () => {
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		mocks.load.mockImplementation(async () => {
			deadline.abort(new Error(apiKey));
			throw new Error(apiKey);
		});
		const res = await POST(request());
		expect(res.status).toBe(504);
		expect(JSON.stringify(await res.json())).not.toContain(apiKey);
	});
});
