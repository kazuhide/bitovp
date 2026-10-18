import { describe, expect, it } from "vitest";
import { normalizeLiveToVod } from "@/app/live/live-shared";
import { LIVE_TO_VOD_PUBLIC_PROJECTION } from "@/lib/live-to-vod-public";
import { liveToVodForRole } from "./live-to-vod-view";

const identity = {
	attemptId: "attempt-1",
	encodingId: "enc-1",
	outputId: "out-1",
	outputPath: "archive",
	manifestName: "vod.m3u8",
};

const raw = {
	status: "ERROR",
	attemptId: "attempt-1",
	revision: 7,
	queueJobId: "queue-job-1",
	liveChannelRunId: "run-1",
	outputId: "out-1",
	outputKey: "origin",
	path: "archive/private-provider-path",
	priorManifests: [
		{ type: "HLS", manifestId: "prior-hls", url: "archive/vod.m3u8" },
	],
	errorCode: "L2V_PROVIDER_STATUS_FAILED",
	technicalDetail:
		"provider stack /private/path\nAuthorization: Basic should-not-leak\ntoken=plain-secret\nhttps://edge.example/vod.m3u8?apiKey=query-secret\nCookie: sid=cookie-secret",
	error: "legacy provider stack",
	manifests: [],
	families: [
		{
			type: "DASH",
			status: "ERROR",
			errorCode: "L2V_PROVIDER_LOOKUP_FAILED",
			providerIdentity: { ...identity, manifestName: "vod.mpd" },
			createIntent: {
				ownerToken: "owner-secret",
				status: "LOOKUP_UNKNOWN",
				requestedAt: "2026-08-31T00:00:00Z",
				technicalDetail: "lookup /private/provider/path failed",
			},
		},
		{
			type: "HLS",
			status: "ERROR",
			errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
			technicalDetail: "delete 403 provider English",
			error: "legacy delete English",
			providerIdentity: identity,
			createIntent: {
				ownerToken: "owner-error-secret",
				status: "LOOKUP_UNKNOWN",
				requestedAt: "2026-08-31T00:00:00Z",
				technicalDetail: "error intent /private/provider/path",
			},
			manifestId: "manifest-1",
			cleanup: {
				providerId: "manifest-1",
				status: "DELETE_PENDING",
				requestedAt: "2026-08-31T00:00:00Z",
				errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
				technicalDetail: "403 raw response",
			},
		},
	],
};

describe("liveToVodForRole", () => {
	it("does not turn a legacy families-absent record into a new empty-family record", () => {
		const legacy = liveToVodForRole(
			{
				status: "FINISHED",
				manifests: [
					{ type: "HLS", manifestId: "legacy-hls", url: "archive/vod.m3u8" },
				],
			},
			false,
		);
		expect(legacy).not.toHaveProperty("families");
		expect(legacy?.manifests).toHaveLength(1);
	});

	it("replaces legacy provider prose with a stable customer error code", () => {
		const legacy = liveToVodForRole(
			{
				status: "ERROR",
				manifests: [],
				error: "raw provider English /private/provider/path",
			},
			false,
		);

		expect(legacy).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_PROVIDER_STATUS_FAILED",
		});
		expect(JSON.stringify(legacy)).not.toMatch(
			/raw provider|private\/provider/,
		);
		expect(normalizeLiveToVod(legacy)).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_PROVIDER_STATUS_FAILED",
		});
	});

	it("round-trips a redacted VIEWER FINISHED family without the client downgrading it", () => {
		const viewer = liveToVodForRole(
			{
				status: "FINISHED",
				attemptId: "attempt-1",
				liveChannelRunId: "run-1",
				finishedAt: "2026-08-31T00:01:00Z",
				manifests: [
					{ type: "HLS", manifestId: "manifest-1", url: "archive/vod.m3u8" },
				],
				families: [
					{
						type: "HLS",
						status: "FINISHED",
						providerIdentity: identity,
						manifestId: "manifest-1",
						url: "archive/vod.m3u8",
					},
				],
			},
			false,
		);

		expect(normalizeLiveToVod(viewer)).toMatchObject({
			status: "FINISHED",
			families: [
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-1",
					url: "archive/vod.m3u8",
				},
			],
			manifests: [
				{ type: "HLS", manifestId: "manifest-1", url: "archive/vod.m3u8" },
			],
		});
		expect(viewer).toHaveProperty("projection", LIVE_TO_VOD_PUBLIC_PROJECTION);
	});

	it.each([
		{
			name: "null",
			families: [
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-1",
					url: "archive/vod.m3u8",
				},
				null,
			],
		},
		{
			name: "unknown type",
			families: [
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-1",
					url: "archive/vod.m3u8",
				},
				{ type: "SMOOTH", status: "FINISHED", manifestId: "x", url: "x" },
			],
		},
		{
			name: "duplicate",
			families: [
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-1",
					url: "archive/vod.m3u8",
				},
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-2",
					url: "archive/vod-2.m3u8",
				},
			],
		},
	])("fails closed on a $name family in the new public shape and reprojects manifests", ({
		families,
	}) => {
		const normalized = normalizeLiveToVod({
			projection: LIVE_TO_VOD_PUBLIC_PROJECTION,
			status: "FINISHED",
			finishedAt: "2026-08-31T00:01:00Z",
			families,
			manifests: [
				{ type: "HLS", manifestId: "manifest-1", url: "archive/vod.m3u8" },
				{
					type: "DASH",
					manifestId: "raw-extra",
					url: "archive/raw-extra.mpd",
				},
			],
		});

		expect(normalized).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
		});
		expect(normalized?.manifests).toEqual([
			{
				type: "HLS",
				manifestId: "manifest-1",
				url: "archive/vod.m3u8",
			},
		]);
		expect(normalized?.manifests).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ manifestId: "raw-extra" }),
			]),
		);
	});

	it("does not promote a public terminal status that contradicts its valid family", () => {
		const normalized = normalizeLiveToVod({
			projection: LIVE_TO_VOD_PUBLIC_PROJECTION,
			status: "ERROR",
			finishedAt: "2026-08-31T00:01:00Z",
			families: [
				{
					type: "HLS",
					status: "FINISHED",
					manifestId: "manifest-1",
					url: "archive/vod.m3u8",
				},
			],
			manifests: [],
		});

		expect(normalized).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_RECORD_INVALID",
		});
		expect(normalized?.manifests).toHaveLength(1);
	});

	it("keeps an exact server-projected active claim RUNNING after private queue fields are removed", () => {
		const viewer = liveToVodForRole(
			{
				status: "RUNNING",
				attemptId: "attempt-1",
				revision: 0,
				queueJobId: "queue-job-1",
				liveChannelRunId: "run-1",
				families: [
					{
						type: "HLS",
						status: "FINISHED",
						providerIdentity: identity,
						manifestId: "manifest-1",
						url: "archive/vod.m3u8",
					},
				],
				manifests: [
					{
						type: "HLS",
						manifestId: "manifest-1",
						url: "archive/vod.m3u8",
					},
				],
			},
			false,
		);

		expect(normalizeLiveToVod(viewer)).toMatchObject({
			status: "RUNNING",
			attemptId: "attempt-1",
			liveChannelRunId: "run-1",
		});
	});

	it("removes raw diagnostics from the non-admin HTTP DTO", () => {
		const viewer = liveToVodForRole(raw, false);
		expect(JSON.stringify(viewer)).not.toMatch(
			/provider stack|private\/path|delete English|403 raw/,
		);
		expect(viewer).toMatchObject({
			errorCode: "L2V_PROVIDER_STATUS_FAILED",
			attemptId: "attempt-1",
			liveChannelRunId: "run-1",
			outputKey: "origin",
			path: "archive/private-provider-path",
		});
		expect(viewer?.families).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					errorCode: "L2V_PROVIDER_DELETE_UNCONFIRMED",
					manifestId: "manifest-1",
					cleanup: expect.objectContaining({ status: "DELETE_PENDING" }),
				}),
			]),
		);
		expect(JSON.stringify(viewer)).not.toMatch(
			/providerIdentity|providerId|createIntent|priorManifests|prior-hls|owner-secret|owner-error-secret|queue-job-1|enc-1|out-1/,
		);
	});

	it("returns bounded, sanitized diagnostics for an ADMIN response", () => {
		const admin = liveToVodForRole(raw, true);
		const technicalDetail =
			admin && "technicalDetail" in admin ? admin.technicalDetail : undefined;
		expect(technicalDetail).toContain("provider stack [PATH_REDACTED]");
		expect(technicalDetail).toContain("Authorization: [REDACTED]");
		expect(technicalDetail).toContain("token=[REDACTED]");
		expect(technicalDetail).toContain("apiKey=[REDACTED]");
		expect(technicalDetail).toContain("Cookie: [REDACTED]");
		expect(admin?.families).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					technicalDetail: "delete 403 provider English",
				}),
			]),
		);
		expect(JSON.stringify(admin)).not.toMatch(
			/private\/path|should-not-leak|plain-secret|query-secret|cookie-secret|legacy provider stack|legacy delete English/,
		);
		expect(JSON.stringify(admin)).not.toMatch(/private\/provider\/path/);
		expect(JSON.stringify(admin)).toContain("[PATH_REDACTED]");
	});
});
