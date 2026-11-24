import { describe, expect, it } from "vitest";
import { safeHeartbeatReceipt } from "./heartbeat-receipt-value";
import {
	hasObservedHlsOutput,
	projectSafeHeartbeat,
	projectSafeHeartbeatReception,
} from "./safe-heartbeat-projection";

const at = "2026-11-07T00:00:05.000Z";
const born = new Date("2026-11-07T00:00:00Z");
const now = new Date("2026-11-07T00:00:10Z");
const raw = {
	timestamp: at,
	ingest: {
		status: "CONNECTED",
		healthy: true,
		droppedPacketsVideo: 2,
		streams: [
			{
				mediaType: "VIDEO",
				width: 1280,
				rate: 30,
				incomingBitrate: 1000,
				streamKey: "private",
				encoderIp: "private",
			},
		],
	},
	output: {
		manifests: {
			hls: [
				{
					url: "private",
					manifestUpdates: [
						{ manifestUpdateWallClockTime: at, path: "private" },
					],
				},
			],
		},
		segments: {
			totalProcessingStatsMs: { mean: 1, min: 0, max: 2, secret: "private" },
		},
	},
	message: "private",
};

describe("safe heartbeat projection", () => {
	it("preserves bounded first-connection metadata through poll, push and receipt projections", () => {
		const streams = [
			{ mediaType: "VIDEO", aspectRatio: "16:9" },
			{
				mediaType: "AUDIO",
				numberOfAudioChannels: 6,
				audioChannelFormat: "5.1(side)",
			},
		];
		const raw = { timestamp: at, ingest: { status: "CONNECTED", streams } };
		expect(
			projectSafeHeartbeat({ at, raw }, now, born)?.raw.ingest?.streams,
		).toEqual(streams);
		const push = projectSafeHeartbeatReception(
			{
				state: "available",
				runId: "run",
				latest: { sampledAt: at, receivedAt: at, raw },
			},
			"run",
			now,
			born,
		);
		expect(push.state === "available" && push.latest?.raw).toMatchObject({
			ingest: { streams },
		});
		const encodingId = "11111111-1111-4111-8111-111111111111";
		expect(
			safeHeartbeatReceipt(
				{
					eventType: "LIVE_ENCODING_HEARTBEAT",
					webhookId: "22222222-2222-4222-8222-222222222222",
					encoding: { id: encodingId },
					value: raw,
				},
				encodingId,
			)?.ingest?.streams,
		).toEqual(streams);
	});

	it("retains the largest REST int32 channel count", () => {
		const projected = projectSafeHeartbeat(
			{
				at,
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [{ numberOfAudioChannels: 2_147_483_647 }],
					},
				},
			},
			now,
			born,
		);
		expect(projected?.raw.ingest?.streams?.[0]?.numberOfAudioChannels).toBe(
			2_147_483_647,
		);
	});
	it.each([
		{
			aspectRatio: null,
			numberOfAudioChannels: null,
			audioChannelFormat: null,
		},
		{
			aspectRatio: "0:0",
			numberOfAudioChannels: 0,
			audioChannelFormat: "unknown",
		},
		{
			aspectRatio: "16:0",
			numberOfAudioChannels: -1,
			audioChannelFormat: "private-token",
		},
		{
			aspectRatio: "16:9\n",
			numberOfAudioChannels: 1.5,
			audioChannelFormat: "stereo\n",
		},
		{
			aspectRatio: "1".repeat(22),
			numberOfAudioChannels: Number.NaN,
			audioChannelFormat: "stereo".repeat(20),
		},
		{
			aspectRatio: "https://private.test",
			numberOfAudioChannels: Number.POSITIVE_INFINITY,
			audioChannelFormat: "https://private.test",
		},
		{
			aspectRatio: { ratio: "16:9" },
			numberOfAudioChannels: "2",
			audioChannelFormat: ["stereo"],
		},
		{
			aspectRatio: "16:9 private",
			numberOfAudioChannels: 2_147_483_648,
			audioChannelFormat: "FL@private+FR",
		},
	])("withholds malformed or unrecognized first-connection metadata %#", (metadata) => {
		const projected = projectSafeHeartbeat(
			{ at, raw: { ingest: { status: "CONNECTED", streams: [metadata] } } },
			now,
			born,
		);
		expect(projected?.raw.ingest?.streams).toEqual([{}]);
	});

	it("retains finite metrics, known enums and timestamps without mutating or copying aliases", () => {
		const original = JSON.stringify(raw);
		const result = projectSafeHeartbeat(
			{
				at,
				raw,
				deltas: {
					droppedPacketsVideo: 1,
					droppedPacketsAudio: -1,
					corruptPacketsVideo: Number.NaN,
					alias: "private",
				},
			},
			now,
			born,
		);
		expect(result).toMatchObject({
			at,
			raw: {
				ingest: {
					status: "CONNECTED",
					healthy: true,
					streams: [{ width: 1280, rate: 30 }],
				},
				output: {
					segments: { totalProcessingStatsMs: { mean: 1, min: 0, max: 2 } },
				},
			},
			deltas: { droppedPacketsVideo: 1 },
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(result?.deltas?.droppedPacketsAudio).toBeUndefined();
		expect(result?.deltas?.corruptPacketsVideo).toBeUndefined();
		expect(JSON.stringify(raw)).toBe(original);
	});

	it.each([
		null,
		{
			at,
			raw: {
				ingest: {
					streams: [
						{
							aspectRatio: "16:9",
							numberOfAudioChannels: 2,
							audioChannelFormat: "stereo",
						},
					],
				},
			},
		},
		{ at: "bad", raw },
		{ at: "2026-11-06T00:00:00Z", raw },
		{ at: "2026-11-08T00:00:00Z", raw },
		{
			at,
			raw: {
				ingest: {
					status: "private",
					healthy: "true",
					streams: [{ rate: Number.NaN }],
				},
			},
		},
		{ at, raw: { message: "private" } },
	])("keeps invalid or unbound measurements unknown rather than inventing zero/healthy %#", (value) => {
		expect(projectSafeHeartbeat(value, now, born)).toBeNull();
	});

	it("does not fill in absent counters or turn malformed streams into measurements", () => {
		const result = projectSafeHeartbeat(
			{
				at,
				raw: { ingest: { status: "DISCONNECTED", streams: "private" } },
				deltas: "private",
			},
			now,
			born,
		);
		expect(result?.raw.ingest?.status).toBe("DISCONNECTED");
		expect(result?.raw.ingest?.streams).toBeUndefined();
		expect(result?.deltas).toBeUndefined();
	});

	it("preserves exact-run Push measurements and fixed event types only", () => {
		const result = projectSafeHeartbeatReception(
			{
				state: "available",
				runId: "run",
				configuredIntervalS: 2,
				latest: { sampledAt: at, receivedAt: at, raw },
				previous: null,
				previousReceivedAt: "private",
				timeline: {
					events: [
						{
							kind: "FIRST_CONNECT",
							eventAt: at,
							observedReceivedAt: at,
							message: "private",
						},
					],
					coverage: "recent-receipts",
					truncated: false,
				},
				futureAlias: "private",
			},
			"run",
			now,
			born,
		);
		expect(result).toMatchObject({
			state: "available",
			runId: "run",
			latest: { sampledAt: at, raw: { ingest: { status: "CONNECTED" } } },
			previousReceivedAt: null,
			timeline: { events: [{ kind: "FIRST_CONNECT", eventAt: at }] },
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it.each([
		"other-run",
		null,
	])("rejects Push data without the exact current run identity: %s", (runId) => {
		expect(
			projectSafeHeartbeatReception(
				{
					state: "available",
					runId,
					latest: { sampledAt: at, receivedAt: at, raw },
				},
				"run",
				now,
				born,
			),
		).toEqual({ state: "unavailable", runId: "run" });
	});

	it("rejects malformed Push samples and unknown events without claiming empty healthy evidence", () => {
		const result = projectSafeHeartbeatReception(
			{
				state: "available",
				runId: "run",
				latest: { sampledAt: "bad", receivedAt: at, raw },
				previousReceivedAt: at,
				timeline: {
					events: [{ kind: "private", eventAt: at, observedReceivedAt: at }],
					coverage: "recent-receipts",
					truncated: false,
				},
			},
			"run",
			now,
			born,
		);
		expect(result).toMatchObject({
			state: "available",
			latest: null,
			previousReceivedAt: null,
		});
		expect(result.state === "available" && result.timeline).toBeUndefined();
	});

	it("marks HLS observable only when a valid update timestamp was actually retained", () => {
		expect(hasObservedHlsOutput(raw)).toBe(true);
		expect(hasObservedHlsOutput({ output: { manifests: { hls: [{}] } } })).toBe(
			false,
		);
		expect(
			hasObservedHlsOutput({
				output: {
					manifests: {
						hls: [
							{ manifestUpdates: [{ manifestUpdateWallClockTime: "private" }] },
						],
					},
				},
			}),
		).toBe(false);
	});
});
