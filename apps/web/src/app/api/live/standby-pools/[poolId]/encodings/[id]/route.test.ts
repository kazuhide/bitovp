import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const encodingsDelete = vi.fn();

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
			live: { standbyPools: { encodings: { delete: encodingsDelete } } },
		};
	},
}));

import { DELETE } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENC_ROW_ID = "22223333-4444-4555-8666-777788889999";

const params = {
	params: Promise.resolve({ poolId: POOL_ID, id: ENC_ROW_ID }),
};

function deleteRequest(qs: string): Request {
	return new Request(`http://test/encodings/${ENC_ROW_ID}?${qs}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("DELETE /api/live/standby-pools/[poolId]/encodings/[id]", () => {
	it("400s when either route id is not a UUID", async () => {
		for (const bad of [
			{ poolId: "x", id: ENC_ROW_ID },
			{ poolId: POOL_ID, id: "y" },
		]) {
			const res = await DELETE(
				deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
				{ params: Promise.resolve(bad) },
			);
			expect(res.status).toBe(400);
		}
		expect(encodingsDelete).not.toHaveBeenCalled();
	});

	it("deletes with the (poolId, id) pair and audits", async () => {
		encodingsDelete.mockResolvedValueOnce({ id: ENC_ROW_ID });
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(200);
		expect(encodingsDelete).toHaveBeenCalledWith(POOL_ID, ENC_ROW_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/live/standby-pools/${POOL_ID}/encodings/${ENC_ROW_ID}`,
		);
	});
});
