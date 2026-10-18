import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const poolsGet = vi.fn();
const poolsPatch = vi.fn();
const poolsDelete = vi.fn();

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
					standbyPools: {
						get: poolsGet,
						patch: poolsPatch,
						delete: poolsDelete,
					},
				},
			};
		},
		LiveStandbyPoolUpdate: Resource,
	};
});

import { DELETE, GET, PATCH } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const TEMPLATE = "encodings:\n  - name: standby-live\n";
const TEMPLATE_B64 = Buffer.from(TEMPLATE, "utf8").toString("base64");

const params = { params: Promise.resolve({ poolId: POOL_ID }) };

function patchRequest(body: unknown): Request {
	return new Request(`http://test/api/live/standby-pools/${POOL_ID}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/live/standby-pools/[poolId]", () => {
	it("decodes the base64 template for display, keeping the raw value too", async () => {
		poolsGet.mockResolvedValueOnce({
			id: POOL_ID,
			name: "breaking-news",
			targetPoolSize: 2,
			poolStatus: "HEALTHY",
			encodingTemplate: TEMPLATE_B64,
		});
		const res = await GET(
			new Request(
				`http://test/api/live/standby-pools/${POOL_ID}?bitmovinAccountId=${ACCOUNT_ID}`,
			),
			params,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.encodingTemplate).toBe(TEMPLATE_B64);
		expect(body.encodingTemplateText).toBe(TEMPLATE);
	});

	it("omits encodingTemplateText when the payload is not decodable text", async () => {
		poolsGet.mockResolvedValueOnce({
			id: POOL_ID,
			// Valid base64 whose bytes are not UTF-8 text.
			encodingTemplate: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
		});
		const res = await GET(
			new Request(
				`http://test/api/live/standby-pools/${POOL_ID}?bitmovinAccountId=${ACCOUNT_ID}`,
			),
			params,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("encodingTemplateText");
	});

	it("400s a non-UUID poolId", async () => {
		const res = await GET(
			new Request(
				`http://test/api/live/standby-pools/x?bitmovinAccountId=${ACCOUNT_ID}`,
			),
			{ params: Promise.resolve({ poolId: "x" }) },
		);
		expect(res.status).toBe(400);
		expect(poolsGet).not.toHaveBeenCalled();
	});
});

describe("PATCH /api/live/standby-pools/[poolId]", () => {
	it("rejects an empty update and an out-of-range targetPoolSize", async () => {
		for (const pool of [{}, { targetPoolSize: 0 }, { targetPoolSize: 101 }]) {
			const res = await PATCH(
				patchRequest({ bitmovinAccountId: ACCOUNT_ID, pool }),
				params,
			);
			expect(res.status).toBe(400);
		}
		expect(poolsPatch).not.toHaveBeenCalled();
	});

	it("sends ONLY the supplied fields and base64-encodes the template", async () => {
		poolsPatch.mockResolvedValueOnce({
			id: POOL_ID,
			targetPoolSize: 5,
			encodingTemplate: TEMPLATE_B64,
		});
		const res = await PATCH(
			patchRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { targetPoolSize: 5, encodingTemplate: TEMPLATE },
			}),
			params,
		);
		expect(res.status).toBe(200);
		const [poolIdArg, payload] = poolsPatch.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(poolIdArg).toBe(POOL_ID);
		expect(payload).toEqual({
			targetPoolSize: 5,
			encodingTemplate: TEMPLATE_B64,
		});
	});

	it("audits as PATCH with the template SIZE, never its body", async () => {
		poolsPatch.mockResolvedValueOnce({ id: POOL_ID });
		await PATCH(
			patchRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { encodingTemplate: TEMPLATE },
			}),
			params,
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("PATCH");
		expect(entry.statusCode).toBe(200);
		expect(entry.request).toEqual({ encodingTemplateChars: TEMPLATE.length });
		expect(JSON.stringify(entry)).not.toContain("standby-live");
	});
});

describe("DELETE /api/live/standby-pools/[poolId]", () => {
	it("deletes and audits", async () => {
		poolsDelete.mockResolvedValueOnce({ id: POOL_ID });
		const res = await DELETE(
			new Request(
				`http://test/api/live/standby-pools/${POOL_ID}?bitmovinAccountId=${ACCOUNT_ID}`,
				{ method: "DELETE" },
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(poolsDelete).toHaveBeenCalledWith(POOL_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(`/encoding/live/standby-pools/${POOL_ID}`);
	});

	it("passes through a 409 while the pool still holds encodings", async () => {
		poolsDelete.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 409,
				shortMessage: "Pool still has active encodings",
			}),
		);
		const res = await DELETE(
			new Request(
				`http://test/api/live/standby-pools/${POOL_ID}?bitmovinAccountId=${ACCOUNT_ID}`,
				{ method: "DELETE" },
			),
			params,
		);
		expect(res.status).toBe(409);
		expect(JSON.stringify(await res.json())).not.toContain("SHOULD_NOT_LEAK");
	});
});
