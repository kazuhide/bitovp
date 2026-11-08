import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	latest: vi.fn(),
	encoding: vi.fn(),
	status: vi.fn(),
	persist: vi.fn(),
}));
vi.mock("./aisa-live-sdk", () => ({
	aisaLiveClientForAccount: async () => ({
		get: mocks.get,
		latest: mocks.latest,
	}),
}));
vi.mock("./bitmovin", () => ({
	bitmovinClientForAccount: async () => ({
		encoding: { encodings: { get: mocks.encoding, status: mocks.status } },
	}),
}));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<typeof import("@bitovp/db")>()),
	persistFinalAisaImport: mocks.persist,
}));

import { importFinalAisaAnalysis } from "./aisa-live-import";

const ownerId = "11111111-1111-4111-8111-111111111111";
const owner = {
	actorUserId: ownerId,
	effectiveUserId: ownerId,
	actor: `user:${ownerId}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};

const context = () => ({ prisma: {}, tenant: owner });
const analysisId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const encodingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const bitmovinAccountId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const snapshot = {
	analysisId,
	encodingId,
	sequence: 2,
	producedAt: "2026-11-07T07:06:00Z",
	mediaTimeOriginUnixMs: 1794034800000,
	isFinal: true,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 300,
	metadata: { version: "synthetic", disclaimer: "Synthetic" },
	observations: [],
	keyMoments: [],
	sourceGaps: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", ownerId);
	mocks.get.mockResolvedValue({
		analysisId,
		encodingId,
		status: "FINISHED",
		name: "Verified final",
		createdAt: "2026-11-07T07:00:00Z",
		rtmpIngest: { streamKey: "SECRET" },
	});
	mocks.latest.mockResolvedValue(snapshot);
	mocks.encoding.mockResolvedValue({
		id: encodingId,
		type: "LIVE",
		startedAt: new Date("2026-11-07T07:01:00Z"),
		finishedAt: new Date("2026-11-07T07:05:00Z"),
	});
	mocks.status.mockResolvedValue({ status: "FINISHED" });
	mocks.persist.mockResolvedValue({
		channelId: "channel",
		runId: "run",
		imported: true,
	});
});
afterEach(() => vi.unstubAllEnvs());

it("denies a direct import call without the exact administrator before provider verification", async () => {
	await expect(
		importFinalAisaAnalysis({ prisma: {} } as never, {
			bitmovinAccountId,
			analysisId,
		}),
	).rejects.toMatchObject({ httpStatusCode: 404 });
	expect(mocks.get).not.toHaveBeenCalled();
	expect(mocks.latest).not.toHaveBeenCalled();
	expect(mocks.encoding).not.toHaveBeenCalled();
	expect(mocks.status).not.toHaveBeenCalled();
	expect(mocks.persist).not.toHaveBeenCalled();
});

it("independently verifies Analysis, exact Encoding terminal status and final snapshot before importing zero moments", async () => {
	const req = new Request("http://test/api/import", {
		headers: { "x-bitovp-actor": "user:fixture" },
	});
	await expect(
		importFinalAisaAnalysis(
			context() as never,
			{ bitmovinAccountId, analysisId },
			req,
		),
	).resolves.toEqual({ channelId: "channel", runId: "run", imported: true });
	expect(mocks.encoding).toHaveBeenCalledWith(encodingId);
	expect(mocks.status).toHaveBeenCalledWith(encodingId);
	expect(mocks.persist).toHaveBeenCalledOnce();
	const [, proof, actor] = mocks.persist.mock.calls[0] ?? [];
	expect(proof).toMatchObject({
		analysisId,
		encodingId,
		bitmovinAccountId,
		snapshot: { isFinal: true, keyMoments: [] },
	});
	expect(actor).toBe("user:fixture");
	expect(JSON.stringify(proof)).not.toContain("SECRET");
});
it.each([
	"RUNNING",
	"ERROR",
	"CANCELED",
])("does not import an Analysis in %s", async (status) => {
	mocks.get.mockResolvedValue({ analysisId, encodingId, status });
	await expect(
		importFinalAisaAnalysis(context() as never, {
			bitmovinAccountId,
			analysisId,
		}),
	).rejects.toMatchObject({ httpStatusCode: 409 });
	expect(mocks.persist).not.toHaveBeenCalled();
});
it("does not equate an Analysis final result with a finished backing Encoding", async () => {
	mocks.status.mockResolvedValue({ status: "RUNNING" });
	await expect(
		importFinalAisaAnalysis(context() as never, {
			bitmovinAccountId,
			analysisId,
		}),
	).rejects.toMatchObject({ httpStatusCode: 409 });
	expect(mocks.persist).not.toHaveBeenCalled();
});
it.each([
	{ ...snapshot, isFinal: false },
	{ ...snapshot, encodingId: "dddddddd-dddd-4ddd-addd-dddddddddddd" },
])("rejects a nonfinal or foreign result", async (value) => {
	mocks.latest.mockResolvedValue(value);
	await expect(
		importFinalAisaAnalysis(context() as never, {
			bitmovinAccountId,
			analysisId,
		}),
	).rejects.toBeInstanceOf(Error);
	expect(mocks.persist).not.toHaveBeenCalled();
});
