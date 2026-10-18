import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const findUnique = vi.fn();

const scheduledList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: { liveChannel: { findUnique } },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			encodings: {
				live: { insertableContent: { scheduled: { list: scheduledList } } },
			},
		};
	},
}));

import { GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	findUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
	});
});

describe("GET /api/live-channels/[id]/insertable-content/scheduled", () => {
	it("clamps limit to 100 (C6)", async () => {
		scheduledList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/scheduled?bitmovinAccountId=${ACCOUNT_ID}&limit=250`,
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(scheduledList).toHaveBeenCalledWith(ENCODING_ID, {
			offset: 0,
			limit: 100,
		});
	});

	it("keeps contentId on each row (the de-schedule DELETE needs it)", async () => {
		scheduledList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "sched-1",
					contentId: "content-1",
					runAt: "2026-08-06T20:00:00Z",
					durationInSeconds: 15,
					status: "SCHEDULED",
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(`http://test/scheduled?bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
		};
		expect(body.items[0]?.contentId).toBe("content-1");
		expect(body.items[0]).not.toHaveProperty("internalTrace");
	});

	it("is a reservation list, not playback evidence: a SCHEDULED row whose runAt has passed comes back verbatim, with no synthesized active/current field (row #277)", async () => {
		scheduledList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "sched-past",
					contentId: "content-1",
					// Long past by any clock this test runs under.
					runAt: "2020-01-01T00:00:00Z",
					durationInSeconds: 15,
					status: "SCHEDULED",
				},
			],
		});
		const res = await GET(
			new Request(`http://test/scheduled?bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		// Exactly the provider's fields — `status` untouched, and no `active`,
		// `current` or `onAir` derived from the timestamp. The provider model
		// has no ACTIVE state, so an "active" here could only ever be a guess.
		expect(body.items[0]).toEqual({
			id: "sched-past",
			contentId: "content-1",
			runAt: "2020-01-01T00:00:00Z",
			durationInSeconds: 15,
			status: "SCHEDULED",
		});
		expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
			"contentId",
			"durationInSeconds",
			"id",
			"runAt",
			"status",
		]);
	});

	it("400s a non-UUID bitmovinAccountId", async () => {
		const res = await GET(
			new Request("http://test/scheduled?bitmovinAccountId=main"),
			params,
		);
		expect(res.status).toBe(400);
	});
});
