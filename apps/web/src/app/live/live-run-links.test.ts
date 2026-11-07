import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findRun: vi.fn(),
	enabled: true,
}));
vi.mock("@/lib/i18n/metadata", () => ({ localizedTitle: () => () => ({}) }));
vi.mock("@/lib/server/aisa-live-sdk", () => ({
	aisaLivePreviewEnabled: () => mocks.enabled,
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		prisma: { liveChannelRun: { findFirst: mocks.findRun } },
	}),
}));
vi.mock("@/lib/server/player-config", () => ({
	readPlayerClientConfig: async () => undefined,
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
	redirect: (url: string) => {
		throw new Error(`REDIRECT:${url}`);
	},
}));
vi.mock("./[id]/channel-detail", () => ({ ChannelDetail: () => null }));

import LiveChannelDetailPage from "./[id]/page";
import AisaAnalysisPage from "./analyses/[analysisId]/page";

const channelId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000002";
const runId = "10000000-0000-4000-8000-000000000003";
const analysisId = "10000000-0000-4000-8000-000000000004";
const encodingId = "10000000-0000-4000-8000-000000000005";
const historicalRun = {
	id: runId,
	liveChannelId: channelId,
	seq: 1,
	aisaAnalysisId: analysisId,
	bitmovinEncodingId: encodingId,
	aisaStatus: "FINISHED",
	aisaSnapshot: {
		analysisId,
		encodingId,
		sequence: 4,
		isFinal: true,
		producedAt: "2026-11-07T00:00:00.000Z",
		mediaTimeOriginUnixMs: 1794009600000,
		analyzedStartTimeSeconds: 0,
		analyzedEndTimeSeconds: 0,
		metadata: { version: "fixture", disclaimer: "Fixture" },
		observations: [],
		keyMoments: [],
		sourceGaps: [],
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.enabled = true;
	mocks.findRun.mockResolvedValue(historicalRun);
});

describe("exact run identity in existing Live deep links", () => {
	it("keeps an old Analysis bookmark bound to its actual run after a re-air", async () => {
		await expect(
			AisaAnalysisPage({
				params: Promise.resolve({ analysisId }),
				searchParams: Promise.resolve({ bitmovinAccountId: accountId }),
			}),
		).rejects.toThrow(`REDIRECT:/live/${channelId}?runId=${runId}`);
		expect(mocks.findRun).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					aisaAnalysisId: analysisId,
					liveChannel: { bitmovinAccountId: accountId },
				},
				select: { id: true, liveChannelId: true },
			}),
		);
	});
	it("fails explicitly for a legacy Analysis not bound to the selected account", async () => {
		mocks.findRun.mockResolvedValue(null);
		await expect(
			AisaAnalysisPage({
				params: Promise.resolve({ analysisId }),
				searchParams: Promise.resolve({ bitmovinAccountId: accountId }),
			}),
		).rejects.toThrow("NOT_FOUND");
	});
	it("resolves a selected historical run through the same channel before rendering", async () => {
		const page = await LiveChannelDetailPage({
			params: Promise.resolve({ id: channelId }),
			searchParams: Promise.resolve({ runId }),
		});
		expect(page.props.initialAisaRun).toEqual(historicalRun);
		expect(mocks.findRun).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: runId, liveChannelId: channelId },
			}),
		);
	});
	it.each([
		null,
		{ ...historicalRun, liveChannelId: accountId },
		{ ...historicalRun, aisaAnalysisId: null },
	])("does not fall back to latest for an unknown, foreign, or non-AISA run (%j)", async (row) => {
		mocks.findRun.mockResolvedValue(row);
		await expect(
			LiveChannelDetailPage({
				params: Promise.resolve({ id: channelId }),
				searchParams: Promise.resolve({ runId }),
			}),
		).rejects.toThrow("NOT_FOUND");
	});
	it.each([
		{ label: "malformed", value: "invalid" },
		{ label: "repeated", value: [runId, runId] },
	])("rejects $label run selection before a DB read", async ({ value }) => {
		await expect(
			LiveChannelDetailPage({
				params: Promise.resolve({ id: channelId }),
				searchParams: Promise.resolve({ runId: value }),
			}),
		).rejects.toThrow("NOT_FOUND");
		expect(mocks.findRun).not.toHaveBeenCalled();
	});
	it("keeps normal channel URLs on their existing path without a historical run lookup", async () => {
		const page = await LiveChannelDetailPage({
			params: Promise.resolve({ id: channelId }),
		});
		expect(page.props.id).toBe(channelId);
		expect(page.props.initialAisaRun).toBeUndefined();
		expect(mocks.findRun).not.toHaveBeenCalled();
	});
	it("sends only a validated matching snapshot in the selected server view", async () => {
		mocks.findRun.mockResolvedValue({
			...historicalRun,
			hiddenCredential: "SENTINEL",
			aisaSnapshot: {
				...historicalRun.aisaSnapshot,
				hiddenCredential: "SENTINEL",
			},
		});
		const page = await LiveChannelDetailPage({
			params: Promise.resolve({ id: channelId }),
			searchParams: Promise.resolve({ runId }),
		});
		expect(JSON.stringify(page.props.initialAisaRun)).not.toContain("SENTINEL");
		expect(page.props.initialAisaRun?.aisaSnapshot).toEqual(
			historicalRun.aisaSnapshot,
		);
		mocks.findRun.mockResolvedValue({
			...historicalRun,
			aisaSnapshot: { ...historicalRun.aisaSnapshot, encodingId: accountId },
		});
		const mismatch = await LiveChannelDetailPage({
			params: Promise.resolve({ id: channelId }),
			searchParams: Promise.resolve({ runId }),
		});
		expect(mismatch.props.initialAisaRun?.aisaSnapshot).toBeNull();
	});
});
