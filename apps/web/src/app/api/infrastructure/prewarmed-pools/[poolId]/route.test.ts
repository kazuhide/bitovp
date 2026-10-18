import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const poolsGet = vi.fn();
const poolsDelete = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			infrastructure: {
				prewarmedEncoderPools: {
					create: vi.fn(),
					get: poolsGet,
					delete: poolsDelete,
					list: vi.fn(),
					start: vi.fn(),
					stop: vi.fn(),
				},
			},
		};
	},
	PrewarmedEncoderPool: class {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	},
}));

import { DELETE, GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

function params(poolId = POOL_ID) {
	return { params: Promise.resolve({ poolId }) };
}

function request(method = "GET"): Request {
	return new Request(`http://test/x?bitmovinAccountId=${ACCOUNT_ID}`, {
		method,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/infrastructure/prewarmed-pools/[poolId]", () => {
	it("returns allowlist-sanitized pool details", async () => {
		poolsGet.mockResolvedValueOnce({
			id: POOL_ID,
			cloudRegion: "AWS_EU_WEST_1",
			status: "STOPPED",
			internalField: "GET_ECHO_CANARY",
		});
		const res = await GET(request(), params());
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("AWS_EU_WEST_1");
		expect(text).not.toContain("GET_ECHO_CANARY");
	});
});

describe("DELETE /api/infrastructure/prewarmed-pools/[poolId]", () => {
	it("deletes the pool, audits, and never echoes upstream response fields", async () => {
		poolsDelete.mockResolvedValueOnce({
			id: POOL_ID,
			// Defensive: the route answers {id} only — nothing else may leak.
			internalToken: "DELETE_ECHO_CANARY",
		});
		const res = await DELETE(request("DELETE"), params());
		expect(res.status).toBe(200);
		expect(poolsDelete).toHaveBeenCalledWith(POOL_ID);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ id: POOL_ID });
		expect(JSON.stringify(body)).not.toContain("DELETE_ECHO_CANARY");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(
			`/encoding/infrastructure/prewarmed-encoder-pools/${POOL_ID}`,
		);
		expect(entry.statusCode).toBe(200);
		expect(JSON.stringify(entry)).not.toContain("DELETE_ECHO_CANARY");
	});

	it("rejects a non-uuid pool id before any SDK call", async () => {
		const res = await DELETE(request("DELETE"), params("../sneaky"));
		expect(res.status).toBe(400);
		expect(poolsDelete).not.toHaveBeenCalled();
	});
});
