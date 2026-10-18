import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();

const encodingsList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			live: { standbyPools: { encodings: { list: encodingsList } } },
		};
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

describe("GET /api/live/standby-pools/[poolId]/encodings", () => {
	it("clamps limit to 100 (C6) — this sub-list DOES take query params", async () => {
		encodingsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/encodings?bitmovinAccountId=${ACCOUNT_ID}&limit=999`,
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(encodingsList).toHaveBeenCalledWith(POOL_ID, {
			offset: 0,
			limit: 100,
		});
	});

	it("forwards a valid status filter and rejects an invalid one", async () => {
		encodingsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		await GET(
			new Request(
				`http://test/encodings?bitmovinAccountId=${ACCOUNT_ID}&status=ACQUIRED`,
			),
			params,
		);
		expect(encodingsList).toHaveBeenCalledWith(POOL_ID, {
			offset: 0,
			limit: 25,
			status: "ACQUIRED",
		});

		const bad = await GET(
			new Request(
				`http://test/encodings?bitmovinAccountId=${ACCOUNT_ID}&status=RUNNING`,
			),
			params,
		);
		expect(bad.status).toBe(400);
	});

	it("sanitizes rows, keeping ingest points and manifests", async () => {
		encodingsList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "pool-enc-1",
					encodingId: "11112222-3333-4444-8555-666677778888",
					status: "READY",
					ingestPoints: [
						{ streamBaseUrl: "rtmps://x/live", streamKey: "sk-1", extra: 1 },
					],
					manifests: [{ url: "https://cdn/m.m3u8", type: "HLS" }],
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(`http://test/encodings?bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items[0]?.status).toBe("READY");
		const serialized = JSON.stringify(body);
		expect(serialized).toContain("sk-1");
		expect(serialized).not.toContain("internalTrace");
		expect(serialized).not.toContain('"extra"');
	});
});
