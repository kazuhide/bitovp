import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();

const rtmpList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = { inputs: { rtmp: { list: rtmpList } } };
	},
}));

import { GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/live/rtmp-inputs", () => {
	it("clamps limit to 100 (C6)", async () => {
		rtmpList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/live/rtmp-inputs?bitmovinAccountId=${ACCOUNT_ID}&limit=250`,
			),
		);
		expect(res.status).toBe(200);
		expect(rtmpList).toHaveBeenCalledWith({ offset: 0, limit: 100 });
	});

	it("honours offset for paging", async () => {
		rtmpList.mockResolvedValueOnce({ totalCount: 140, items: [] });
		await GET(
			new Request(
				`http://test/api/live/rtmp-inputs?bitmovinAccountId=${ACCOUNT_ID}&offset=100&limit=100`,
			),
		);
		expect(rtmpList).toHaveBeenCalledWith({ offset: 100, limit: 100 });
	});

	it("projects to {id, name} only", async () => {
		rtmpList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "rtmp-1",
					name: "studio-a",
					description: "not needed by the picker",
					type: "RTMP",
					createdAt: "2026-08-06T12:00:00Z",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/live/rtmp-inputs?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items).toEqual([{ id: "rtmp-1", name: "studio-a" }]);
	});

	it("400s a missing bitmovinAccountId and 404s an unknown one", async () => {
		expect(
			(await GET(new Request("http://test/api/live/rtmp-inputs"))).status,
		).toBe(400);
		getAccount.mockResolvedValueOnce(null);
		expect(
			(
				await GET(
					new Request(
						`http://test/api/live/rtmp-inputs?bitmovinAccountId=${ACCOUNT_ID}`,
					),
				)
			).status,
		).toBe(404);
	});

	it("maps an upstream 429 to 502 (our quota standing, not the browser's)", async () => {
		rtmpList.mockRejectedValueOnce(
			Object.assign(new Error("slow down"), {
				httpStatusCode: 429,
				shortMessage: "Too many requests",
			}),
		);
		const res = await GET(
			new Request(
				`http://test/api/live/rtmp-inputs?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		expect(res.status).toBe(502);
	});
});
