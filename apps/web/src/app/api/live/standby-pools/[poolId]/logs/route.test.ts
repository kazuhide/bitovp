import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();

const logsList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = { live: { standbyPools: { logs: { list: logsList } } } };
	},
}));

import { GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const params = { params: Promise.resolve({ poolId: POOL_ID }) };

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/live/standby-pools/[poolId]/logs", () => {
	it("clamps limit to 100 (C6) and defaults to newest-first", async () => {
		logsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(`http://test/logs?bitmovinAccountId=${ACCOUNT_ID}&limit=101`),
			params,
		);
		expect(res.status).toBe(200);
		expect(logsList).toHaveBeenCalledWith(POOL_ID, {
			offset: 0,
			limit: 100,
			sort: "createdAt:DESC",
		});
	});

	it("forwards an eventType filter and rejects an unknown one", async () => {
		logsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		await GET(
			new Request(
				`http://test/logs?bitmovinAccountId=${ACCOUNT_ID}&eventType=ERROR`,
			),
			params,
		);
		expect(logsList).toHaveBeenCalledWith(
			POOL_ID,
			expect.objectContaining({ eventType: "ERROR" }),
		);

		const bad = await GET(
			new Request(
				`http://test/logs?bitmovinAccountId=${ACCOUNT_ID}&eventType=DEBUG`,
			),
			params,
		);
		expect(bad.status).toBe(400);
	});

	it("sanitizes log rows to the allowlist", async () => {
		logsList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "log-1",
					eventType: "ERROR",
					message: "Encoding failed to prepare",
					details: "quota exceeded",
					createdAt: "2026-08-06T12:00:00Z",
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(`http://test/logs?bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("Encoding failed to prepare");
		expect(body).not.toContain("internalTrace");
	});
});
