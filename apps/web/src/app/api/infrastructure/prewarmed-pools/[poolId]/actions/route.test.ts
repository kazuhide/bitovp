import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const poolsStart = vi.fn();
const poolsStop = vi.fn();

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
				prewarmedEncoderPools: { start: poolsStart, stop: poolsStop },
			},
		};
	},
}));

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const params = { params: Promise.resolve({ poolId: POOL_ID }) };

function postRequest(body: unknown): Request {
	return new Request("http://test/actions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("POST /api/infrastructure/prewarmed-pools/[poolId]/actions", () => {
	it("rejects unknown actions", async () => {
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "restart" }),
			params,
		);
		expect(res.status).toBe(400);
		expect(poolsStart).not.toHaveBeenCalled();
		expect(poolsStop).not.toHaveBeenCalled();
	});

	it("starts a pool and audits the action-specific Bitmovin path", async () => {
		poolsStart.mockResolvedValueOnce({ id: POOL_ID });
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "start" }),
			params,
		);
		expect(res.status).toBe(200);
		expect(poolsStart).toHaveBeenCalledWith(POOL_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/infrastructure/prewarmed-encoder-pools/${POOL_ID}/start`,
		);
	});

	it("stops a pool", async () => {
		poolsStop.mockResolvedValueOnce({ id: POOL_ID });
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "stop" }),
			params,
		);
		expect(res.status).toBe(200);
		expect(poolsStop).toHaveBeenCalledWith(POOL_ID);
		expect((await res.json()).action).toBe("stop");
	});

	it("surfaces upstream failure as a curated error, still audited", async () => {
		poolsStop.mockRejectedValueOnce(
			Object.assign(new Error("request body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 409,
				shortMessage: "Pool is not running",
			}),
		);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "stop" }),
			params,
		);
		expect(res.status).toBe(409);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("Pool is not running");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.statusCode).toBe(409);
		expect(JSON.stringify(entry)).not.toContain("SHOULD_NOT_LEAK");
	});
});
