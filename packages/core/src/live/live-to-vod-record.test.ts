import { describe, expect, it } from "vitest";
import {
	deriveLiveToVodStatus,
	isRetryableLiveToVod,
	type LiveToVodFamilyRecord,
	liveToVodClaim,
	liveToVodFamilyPlan,
	liveToVodManifestsOf,
	normalizeLiveToVodRecord,
} from "./live-to-vod-record";
import type { LiveToVodFamilySupport } from "./vod-manifest-target";

/** What `liveToVodFamilySupport` answers for the two recordings that matter. */
const TS_ONLY: LiveToVodFamilySupport = {
	supported: ["HLS"],
	unsupported: [{ family: "DASH", reason: "TS recording — HLS only" }],
};
const FMP4: LiveToVodFamilySupport = {
	supported: ["HLS", "DASH"],
	unsupported: [],
};

const providerIdentity = {
	attemptId: "attempt-1",
	encodingId: "encoding-1",
	outputId: "output-1",
	outputPath: "out",
	manifestName: "vod.m3u8",
};

const finishedHls: LiveToVodFamilyRecord = {
	type: "HLS",
	status: "FINISHED",
	providerIdentity,
	manifestId: "bm-hls",
	url: "out/vod.m3u8",
};
const failedDash: LiveToVodFamilyRecord = {
	type: "DASH",
	status: "ERROR",
	errorCode: "L2V_PROVIDER_STATUS_FAILED",
	providerIdentity: { ...providerIdentity, manifestName: "vod.mpd" },
	manifestId: "bm-dash",
	url: "out/vod.mpd",
	error: "ended ERROR",
};

describe("deriveLiveToVodStatus — the overall status is a function of the families", () => {
	it("RUNNING while any family is in flight, FINISHED when every outcome finished", () => {
		expect(
			deriveLiveToVodStatus([finishedHls, { type: "DASH", status: "PENDING" }]),
		).toBe("RUNNING");
		expect(
			deriveLiveToVodStatus([
				finishedHls,
				{
					type: "DASH",
					status: "CREATED",
					providerIdentity: { ...providerIdentity, manifestName: "vod.mpd" },
					manifestId: "bm-dash",
				},
			]),
		).toBe("RUNNING");
		expect(
			deriveLiveToVodStatus([
				finishedHls,
				{
					type: "DASH",
					status: "RUNNING",
					providerIdentity: { ...providerIdentity, manifestName: "vod.mpd" },
					manifestId: "bm-dash",
				},
			]),
		).toBe("RUNNING");
		expect(deriveLiveToVodStatus([finishedHls])).toBe("FINISHED");
	});

	it("PARTIAL keeps a finished family visible beside a failed one; ERROR only when nothing finished", () => {
		// The audit's case: HLS delivered, DASH refused — never ERROR.
		expect(deriveLiveToVodStatus([finishedHls, failedDash])).toBe("PARTIAL");
		expect(
			deriveLiveToVodStatus([{ ...failedDash, type: "HLS" }, failedDash]),
		).toBe("ERROR");
		expect(deriveLiveToVodStatus([])).toBe("ERROR");
	});

	it("SKIPPED_UNSUPPORTED is not an outcome — a TS-only roll with HLS done is FINISHED", () => {
		expect(
			deriveLiveToVodStatus([
				finishedHls,
				{
					type: "DASH",
					status: "SKIPPED_UNSUPPORTED",
					reasonCode: "L2V_UNSUPPORTED_FAMILY",
					reason: "TS",
				},
			]),
		).toBe("FINISHED");
	});
});

describe("liveToVodManifestsOf — manifests[] is the FINISHED projection", () => {
	it("lists finished families only, and only when they carry id + url", () => {
		expect(
			liveToVodManifestsOf([
				finishedHls,
				failedDash,
				{ type: "DASH", status: "PENDING" },
			]),
		).toEqual([{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }]);
	});
});

describe("normalizeLiveToVodRecord — the boundary over the real column population", () => {
	it("downgrades impossible status shapes instead of promoting an unproven provider outcome", () => {
		const record = normalizeLiveToVodRecord({
			status: "FINISHED",
			attemptId: "attempt-1",
			liveChannelRunId: "run-1",
			manifests: [],
			families: [
				{ type: "HLS", status: "FINISHED", manifestId: "provider-hls" },
				{ type: "DASH", status: "CREATED" },
			],
		});

		expect(record?.status).toBe("ERROR");
		expect(record?.manifests).toEqual([]);
		expect(record?.families).toEqual([
			{
				type: "HLS",
				status: "ERROR",
				errorCode: "L2V_RECORD_INVALID",
				manifestId: "provider-hls",
			},
			{
				type: "DASH",
				status: "ERROR",
				errorCode: "L2V_RECORD_INVALID",
			},
		]);
	});

	it("requires a reason code for SKIPPED and a provider identity from CREATED onward", () => {
		const record = normalizeLiveToVodRecord({
			status: "RUNNING",
			manifests: [],
			families: [
				{ type: "HLS", status: "RUNNING", manifestId: "provider-hls" },
				{ type: "DASH", status: "SKIPPED_UNSUPPORTED", reason: "raw English" },
			],
		});
		expect(record?.status).toBe("ERROR");
		expect(record?.families).toEqual([
			expect.objectContaining({
				type: "HLS",
				status: "ERROR",
				errorCode: "L2V_RECORD_INVALID",
			}),
			expect.objectContaining({
				type: "DASH",
				status: "ERROR",
				errorCode: "L2V_RECORD_INVALID",
			}),
		]);
	});

	it("requires a PENDING provider identity and durable create intent as one unit", () => {
		const record = normalizeLiveToVodRecord({
			status: "RUNNING",
			families: [
				{
					type: "HLS",
					status: "PENDING",
					providerIdentity,
				},
			],
			manifests: [],
		});
		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_RECORD_INVALID",
					providerIdentity,
				},
			],
		});
	});

	it("rejects status-incompatible legacy fields instead of silently stripping provider state", () => {
		const record = normalizeLiveToVodRecord({
			status: "RUNNING",
			families: [
				{
					type: "HLS",
					status: "PENDING",
					manifestId: "provider-id-that-must-not-be-lost",
				},
			],
			manifests: [],
		});
		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_RECORD_INVALID",
					manifestId: "provider-id-that-must-not-be-lost",
				},
			],
		});
	});

	it("rejects cleanup intent that could lose its exact provider id or identity", () => {
		const record = normalizeLiveToVodRecord({
			status: "ERROR",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
					cleanup: {
						providerId: "orphan-id",
						status: "DELETE_PENDING",
						requestedAt: "2026-08-31T00:00:00Z",
					},
				},
			],
			manifests: [],
		});
		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_RECORD_INVALID",
					manifestId: "orphan-id",
				},
			],
		});
	});

	it("rejects DELETE_CONFIRMED without the provider readback timestamp", () => {
		const record = normalizeLiveToVodRecord({
			status: "ERROR",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
					providerIdentity,
					manifestId: "manifest-hls",
					cleanup: {
						providerId: "manifest-hls",
						status: "DELETE_CONFIRMED",
						requestedAt: "2026-08-31T00:00:00Z",
					},
				},
			],
			manifests: [],
		});

		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_RECORD_INVALID",
					providerIdentity,
					manifestId: "manifest-hls",
					cleanup: {
						providerId: "manifest-hls",
						status: "DELETE_PENDING",
						requestedAt: "2026-08-31T00:00:00Z",
					},
				},
			],
		});
	});

	it("invalid, unknown and duplicate family entries invalidate the new record and manifests are reprojected only from FINISHED families", () => {
		const record = normalizeLiveToVodRecord({
			status: "FINISHED",
			families: [
				finishedHls,
				null,
				{ type: "SMOOTH", status: "FINISHED" },
				finishedHls,
			],
			manifests: [
				{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" },
				{ type: "DASH", manifestId: "raw-extra", url: "out/unproven.mpd" },
			],
		});
		expect(record?.status).toBe("ERROR");
		expect(record?.errorCode).toBe("L2V_RECORD_INVALID");
		expect(record?.manifests).toEqual([
			{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" },
		]);
		expect(record?.manifests).not.toContainEqual(
			expect.objectContaining({ manifestId: "raw-extra" }),
		);
	});

	it("only a record with families absent gets legacy manifest compatibility", () => {
		const legacy = normalizeLiveToVodRecord({
			status: "FINISHED",
			manifests: [
				{ type: "HLS", manifestId: "legacy", url: "out/legacy.m3u8" },
			],
		});
		expect(legacy?.status).toBe("FINISHED");
		expect(legacy?.manifests).toHaveLength(1);

		const malformedNew = normalizeLiveToVodRecord({
			status: "FINISHED",
			families: null,
			manifests: [
				{ type: "HLS", manifestId: "unproven", url: "out/unproven.m3u8" },
			],
		});
		expect(malformedNew).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
			manifests: [],
		});
	});
	it("rejects a bare {} and an unknown status, and accepts PARTIAL", () => {
		expect(normalizeLiveToVodRecord({})).toBeNull();
		expect(normalizeLiveToVodRecord(null)).toBeNull();
		expect(normalizeLiveToVodRecord("RUNNING")).toBeNull();
		expect(
			normalizeLiveToVodRecord({ status: "DONE", manifests: [] }),
		).toBeNull();
		expect(normalizeLiveToVodRecord({ status: "PARTIAL" })?.status).toBe(
			"PARTIAL",
		);
	});

	it("preserves a LEGACY record's absent families marker without promoting its manifests (§14.6 item 6)", () => {
		const legacy = normalizeLiveToVodRecord({
			status: "ERROR",
			requestedAt: "2026-08-30T00:00:00.000Z",
			outputId: "bm-out",
			path: "out",
			manifests: [{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }],
			error: "DASH failed",
			technicalDetail: "DASH failed",
		});
		expect(legacy).toEqual({
			status: "ERROR",
			requestedAt: "2026-08-30T00:00:00.000Z",
			outputId: "bm-out",
			path: "out",
			error: "DASH failed",
			technicalDetail: "DASH failed",
			manifests: [{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }],
		});
		expect(legacy).not.toHaveProperty("families");
		// No per-family state was INFERRED from manifests[] — so nothing to retry from.
		expect(isRetryableLiveToVod(legacy)).toBe(false);
	});

	it("fails a new-format record closed when any family is invalid or duplicated", () => {
		const record = normalizeLiveToVodRecord({
			status: "PARTIAL",
			manifests: [
				null,
				{ type: "HLS" },
				{ type: "HLS", manifestId: "h", url: "u" },
			],
			families: [
				failedDash,
				{ type: "DASH", status: "FINISHED", manifestId: "dup" },
				{ type: "HLS", status: "NOPE" },
				"junk",
			],
		});
		// Raw manifests are never evidence for a new-format record. Only a valid
		// FINISHED family can project a customer-visible manifest.
		expect(record?.manifests).toEqual([]);
		expect(record?.families).toEqual([
			failedDash,
			{
				type: "HLS",
				status: "ERROR",
				errorCode: "L2V_RECORD_INVALID",
			},
		]);
		expect(record?.status).toBe("ERROR");
	});

	it("rejects an empty new-format family set instead of treating it as an active or successful roll", () => {
		const record = normalizeLiveToVodRecord({
			status: "ERROR",
			families: [],
			manifests: [],
		});
		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
		});
	});

	it("never promotes a terminal raw ERROR whose family outcome claims FINISHED", () => {
		const record = normalizeLiveToVodRecord({
			status: "ERROR",
			families: [finishedHls],
			manifests: [],
		});
		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
		});
		// The valid family identity remains available for reconciliation, but the
		// contradictory record cannot become a successful overall verdict.
		expect(record?.manifests).toEqual([
			{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" },
		]);
	});
});

describe("liveToVodFamilyPlan — what a roll starts from", () => {
	it("a TS-only DEFAULT plans HLS and records DASH as SKIPPED_UNSUPPORTED with the reason", () => {
		expect(
			liveToVodFamilyPlan({
				requested: TS_ONLY.supported,
				explicit: false,
				support: TS_ONLY,
				carried: [],
			}),
		).toEqual([
			{ type: "HLS", status: "PENDING" },
			{
				type: "DASH",
				status: "SKIPPED_UNSUPPORTED",
				reasonCode: "L2V_UNSUPPORTED_FAMILY",
				reason: "TS recording — HLS only",
				technicalDetail: "TS recording — HLS only",
			},
		]);
	});

	it("an EXPLICIT narrower request leaves the other family absent, not skipped", () => {
		expect(
			liveToVodFamilyPlan({
				requested: ["HLS"],
				explicit: true,
				support: FMP4,
				carried: [],
			}),
		).toEqual([{ type: "HLS", status: "PENDING" }]);
	});

	it("a retry keeps the FINISHED family verbatim and carries a failed family's id for readback", () => {
		const plan = liveToVodFamilyPlan({
			requested: ["HLS", "DASH"],
			explicit: false,
			support: FMP4,
			carried: [finishedHls, failedDash],
		});
		expect(plan).toEqual([finishedHls, failedDash]);
	});

	it("a carried failure WITHOUT an id restarts PENDING when requested, and is kept as history when not", () => {
		const bareFailure: LiveToVodFamilyRecord = {
			type: "DASH",
			status: "ERROR",
			errorCode: "L2V_PROVIDER_CREATE_FAILED",
			error: "create refused",
		};
		expect(
			liveToVodFamilyPlan({
				requested: ["DASH"],
				explicit: true,
				support: FMP4,
				carried: [finishedHls, bareFailure],
			}),
		).toEqual([finishedHls, { type: "DASH", status: "PENDING" }]);
		expect(
			liveToVodFamilyPlan({
				requested: ["HLS"],
				explicit: true,
				support: FMP4,
				carried: [bareFailure],
			}),
		).toEqual([{ type: "HLS", status: "PENDING" }, bareFailure]);
	});
});

describe("liveToVodClaim", () => {
	it("starts an identified attempt at revision zero", () => {
		expect(
			liveToVodClaim({
				existing: null,
				requested: ["HLS"],
				explicit: true,
				support: FMP4,
				requestedAt: "2026-08-31T00:00:00Z",
				attemptId: "attempt-1",
			}),
		).toMatchObject({ attemptId: "attempt-1", revision: 0 });
	});

	it("keeps an exact retry claim RUNNING even when all carried families are terminal", () => {
		const claim = liveToVodClaim({
			existing: {
				status: "PARTIAL",
				families: [finishedHls, failedDash],
				manifests: [{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }],
			},
			requested: ["HLS", "DASH"],
			explicit: true,
			support: FMP4,
			requestedAt: "2026-08-31T00:00:00Z",
			attemptId: "attempt-retry",
			queueJobId: "channel-live-to-vod-attempt-retry",
			liveChannelRunId: "run-1",
			outputKey: "origin",
		});

		expect(normalizeLiveToVodRecord(claim)).toMatchObject({
			status: "RUNNING",
			attemptId: "attempt-retry",
			queueJobId: "channel-live-to-vod-attempt-retry",
			liveChannelRunId: "run-1",
			revision: 0,
		});
	});

	it.each([
		["missing queue identity", { queueJobId: undefined }],
		["missing run identity", { liveChannelRunId: undefined }],
		[
			"terminal timestamp on an active claim",
			{ finishedAt: "2026-08-31T00:01:00Z" },
		],
	])("invalidates a RUNNING new-format record with %s", (_label, override) => {
		const record = normalizeLiveToVodRecord({
			status: "RUNNING",
			attemptId: "attempt-1",
			queueJobId: "job-1",
			liveChannelRunId: "run-1",
			revision: 0,
			requestedAt: "2026-08-31T00:00:00Z",
			outputKey: "origin",
			families: [finishedHls, failedDash],
			manifests: [],
			...override,
		});

		expect(record).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
		});
	});
});

describe("liveToVodClaim — what the route writes before enqueueing", () => {
	it("a fresh roll claims RUNNING with the planned families and no destination", () => {
		expect(
			liveToVodClaim({
				existing: null,
				requested: ["HLS"],
				explicit: false,
				support: TS_ONLY,
				requestedAt: "2026-08-31T00:00:00.000Z",
			}),
		).toEqual({
			status: "RUNNING",
			requestedAt: "2026-08-31T00:00:00.000Z",
			families: [
				{ type: "HLS", status: "PENDING" },
				{
					type: "DASH",
					status: "SKIPPED_UNSUPPORTED",
					reasonCode: "L2V_UNSUPPORTED_FAMILY",
					reason: "TS recording — HLS only",
					technicalDetail: "TS recording — HLS only",
				},
			],
			manifests: [],
		});
	});

	it("a retry over PARTIAL carries the families, destination and the finished manifests forward", () => {
		const claim = liveToVodClaim({
			existing: {
				status: "PARTIAL",
				outputId: "bm-out",
				path: "out",
				families: [finishedHls, failedDash],
				manifests: [{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }],
			},
			requested: ["HLS", "DASH"],
			explicit: false,
			support: FMP4,
			requestedAt: "2026-08-31T00:00:00.000Z",
		});
		expect(claim).toEqual({
			status: "RUNNING",
			requestedAt: "2026-08-31T00:00:00.000Z",
			outputId: "bm-out",
			path: "out",
			priorManifests: [
				{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" },
			],
			families: [finishedHls, failedDash],
			manifests: [{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" }],
		});
	});

	it("a roll over a FINISHED record, or a legacy ERROR, is new work but retains exact filename history", () => {
		for (const existing of [
			{
				status: "FINISHED" as const,
				outputId: "bm-out",
				path: "out",
				families: [finishedHls],
				manifests: [
					{ type: "HLS" as const, manifestId: "bm-hls", url: "out/vod.m3u8" },
				],
			},
			{
				status: "ERROR" as const,
				outputId: "bm-out",
				path: "out",
				manifests: [
					{ type: "HLS" as const, manifestId: "bm-hls", url: "out/vod.m3u8" },
				],
			},
		]) {
			const claim = liveToVodClaim({
				existing,
				requested: ["HLS", "DASH"],
				explicit: false,
				support: FMP4,
				requestedAt: "2026-08-31T00:00:00.000Z",
			});
			expect(claim.families).toEqual([
				{ type: "HLS", status: "PENDING" },
				{ type: "DASH", status: "PENDING" },
			]);
			expect(claim.manifests).toEqual([]);
			expect(claim.priorManifests).toEqual([
				{ type: "HLS", manifestId: "bm-hls", url: "out/vod.m3u8" },
			]);
			expect(claim).not.toHaveProperty("path");
		}
	});
});
