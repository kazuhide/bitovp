import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const accountList = vi.fn();
const encodingList = vi.fn();
const encodingCreate = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => {
	class Resource {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	}
	return {
		default: class MockBitmovinApi {
			encoding = {
				live: {
					dnsMappings: { list: accountList },
					encodings: {
						dnsMappings: {
							list: encodingList,
							create: encodingCreate,
							delete: vi.fn(),
						},
					},
				},
			};
		},
		DnsMappingRequest: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";

function postRequest(body: unknown): Request {
	return new Request("http://test/api/live/dns-mappings", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/live/dns-mappings", () => {
	it("uses the ACCOUNT-level list when no encodingId is given, clamped to 100 (C6)", async () => {
		accountList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/live/dns-mappings?bitmovinAccountId=${ACCOUNT_ID}&limit=400`,
			),
		);
		expect(res.status).toBe(200);
		expect(accountList).toHaveBeenCalledWith({ offset: 0, limit: 100 });
		expect(encodingList).not.toHaveBeenCalled();
	});

	it("switches to the per-encoding list when encodingId is given", async () => {
		encodingList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/live/dns-mappings?bitmovinAccountId=${ACCOUNT_ID}&encodingId=${ENCODING_ID}`,
			),
		);
		expect(res.status).toBe(200);
		expect(encodingList).toHaveBeenCalledWith(ENCODING_ID, {
			offset: 0,
			limit: 25,
		});
		expect(accountList).not.toHaveBeenCalled();
	});

	it("400s a non-UUID encodingId", async () => {
		const res = await GET(
			new Request(
				`http://test/api/live/dns-mappings?bitmovinAccountId=${ACCOUNT_ID}&encodingId=live-1`,
			),
		);
		expect(res.status).toBe(400);
	});

	it("sanitizes rows to the allowlist", async () => {
		accountList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "dns-1",
					subdomain: "studio-a",
					hostname: "studio-a.live.bitmovin.com",
					ip: "203.0.113.5",
					encodingId: ENCODING_ID,
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/live/dns-mappings?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("studio-a.live.bitmovin.com");
		expect(body).not.toContain("internalTrace");
	});
});

describe("POST /api/live/dns-mappings", () => {
	it("requires an encodingId — there is no account-level create in the SDK", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				dnsMapping: { subdomain: "studio-a" },
			}),
		);
		expect(res.status).toBe(400);
		expect(encodingCreate).not.toHaveBeenCalled();
	});

	it.each([
		["uppercase", "Studio-A"],
		["underscore", "studio_a"],
		["dot", "studio.a"],
		["too long", "a".repeat(64)],
	])("rejects a subdomain with %s", async (_label, subdomain) => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				dnsMapping: { encodingId: ENCODING_ID, subdomain },
			}),
		);
		expect(res.status).toBe(400);
		expect(encodingCreate).not.toHaveBeenCalled();
	});

	it("creates on the per-encoding endpoint, without leaking encodingId into the body", async () => {
		encodingCreate.mockResolvedValueOnce({
			id: "dns-1",
			subdomain: "studio-a",
			hostname: "studio-a.live.bitmovin.com",
			encodingId: ENCODING_ID,
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				dnsMapping: {
					encodingId: ENCODING_ID,
					subdomain: "studio-a",
					name: "Studio A ingest",
				},
			}),
		);
		expect(res.status).toBe(201);
		const [encodingIdArg, payload] = encodingCreate.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(encodingIdArg).toBe(ENCODING_ID);
		expect(payload).toEqual({
			subdomain: "studio-a",
			name: "Studio A ingest",
		});
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/live/encodings/${ENCODING_ID}/dns-mappings`,
		);
	});

	it("passes through the 409 for a taken subdomain", async () => {
		encodingCreate.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 409,
				shortMessage: "Subdomain is already in use",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				dnsMapping: { encodingId: ENCODING_ID, subdomain: "studio-a" },
			}),
		);
		expect(res.status).toBe(409);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("already in use");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
	});
});
