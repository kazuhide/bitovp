import { describe, expect, it } from "vitest";
import { heartbeatLogView, incomingMbps, parseHeartbeat } from "./heartbeat";

describe("incomingMbps — provider bytes/sec, display-only conversion", () => {
	// Live Heartbeat's official guide says bytes/sec. SDK 1.278.0's pull-model
	// comment says bits/sec, contradicted by these Sep 7 run 7/8 pull samples:
	// normalized ingest was ~4.55 Mbps video / ~132 kbps audio, not ~0.57 Mbps.
	it.each([
		[571_298.7702733343, "4.57"],
		[568_148.8767848341, "4.55"],
		[16_878.01734422213, "0.14"],
		[16_875.22341853048, "0.14"],
		[0, "0.00"],
		[null, "—"],
		[undefined, "—"],
		[Number.NaN, "—"],
		[Number.POSITIVE_INFINITY, "—"],
		["571298.77", "—"],
	])("formats %s bytes/sec as %s Mbps", (raw, expected) => {
		expect(incomingMbps(raw)).toBe(expected);
	});

	it("leaves parsed raw rates and nominal bitrate unchanged", () => {
		const stream = {
			mediaType: "video",
			bitrate: 4_549_632,
			incomingBitrate: 571_298.7702733343,
		};
		const raw = { ingest: { streams: [stream] } };
		const view = parseHeartbeat({ at: "2026-09-07T03:18:00.875Z", raw });
		expect.assert(view !== null);
		expect(incomingMbps(view.streams[0]?.incomingBitrate)).toBe("4.57");
		expect(view.streams[0]?.incomingBitrate).toBe(stream.incomingBitrate);
		expect(view.streams[0]?.bitrate).toBe("4549632");
		expect(
			heartbeatLogView(
				{ id: "poll", at: "2026-09-07T03:18:00.875Z", raw, deltas: null },
				null,
			).incomingBitrate,
		).toBe(stream.incomingBitrate);
	});
});

describe("heartbeatLogView — one log-table row from a persisted sample", () => {
	const at = "2026-09-02T09:31:01.000Z";
	const KEYFRAME =
		"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
	const raw = {
		ingest: {
			status: "CONNECTED",
			healthy: true,
			streams: [
				{
					streamId: "1",
					mediaType: "audio",
					rate: 48_000,
					bitrate: 163_840,
					incomingBitrate: 20_314.07,
				},
				{
					streamId: "0",
					mediaType: "video",
					width: 1280,
					height: 720,
					rate: 30,
					bitrate: 6_144_000,
					incomingBitrate: 754_499.56,
					keyFrameIntervalAvg: 3956.93,
					keyFrameIntervalMax: 8334,
				},
			],
		},
		output: {
			segments: { totalProcessingStatsMs: { mean: 3841, max: 4659 } },
			manifests: {
				hls: [
					{
						manifestUpdates: [
							{ manifestUpdateWallClockTime: "2026-09-02T09:30:29.938Z" },
							{ manifestUpdateWallClockTime: "2026-09-02T09:30:28.938Z" },
						],
					},
				],
			},
		},
		events: [
			{
				time: "2026-09-02T07:49:49.000Z",
				details: { eventType: "FIRST_CONNECT", message: null },
			},
			{
				time: "2026-09-02T07:49:51.000Z",
				details: { eventType: "WARNING", message: KEYFRAME },
			},
		],
	};

	it("reads the VIDEO stream (not the first stream) for bitrate/fps/keyframe, manifest age from the newest update, segment mean, and only the events that APPEARED", () => {
		const previousRaw = { ...raw, events: [raw.events[0]] };
		const view = heartbeatLogView(
			{ id: "row-1", at, raw, deltas: { droppedPacketsAudio: 2 } },
			previousRaw,
		);
		expect(view).toEqual({
			id: "row-1",
			at,
			ingestStatus: "CONNECTED",
			healthy: true,
			incomingBitrate: 754_499.56,
			fps: 30,
			keyframeAvg: 3956.93,
			keyframeMax: 8334,
			deltas: { droppedPacketsAudio: 2 },
			manifestAgeMs: Date.parse(at) - Date.parse("2026-09-02T09:30:29.938Z"),
			segmentMeanMs: 3841,
			events: [
				expect.objectContaining({ eventType: "WARNING", message: KEYFRAME }),
			],
		});
	});

	it("no previous sample: every event of the row is new; no delivery block: manifest age and segment mean are null", () => {
		const view = heartbeatLogView(
			{
				id: "row-0",
				at,
				raw: {
					ingest: { status: "WAITING_FOR_FIRST_CONNECT" },
					events: raw.events,
				},
				deltas: {},
			},
			undefined,
		);
		expect(view.events).toHaveLength(2);
		expect(view.manifestAgeMs).toBeNull();
		expect(view.segmentMeanMs).toBeNull();
		expect(view.incomingBitrate).toBeNull();
		expect(view.fps).toBeNull();
		expect(view.ingestStatus).toBe("WAITING_FOR_FIRST_CONNECT");
		expect(view.healthy).toBeNull();
	});

	it("survives a malformed row", () => {
		const view = heartbeatLogView(
			{ id: "x", at: "n/a", raw: "junk", deltas: 3 },
			7,
		);
		expect(view).toMatchObject({
			ingestStatus: "UNKNOWN",
			deltas: {},
			events: [],
			manifestAgeMs: null,
		});
	});
});

describe("parseHeartbeat ({ at, raw, deltas } persisted shape)", () => {
	it("returns null when the channel has never been polled", () => {
		expect(parseHeartbeat(null)).toBeNull();
		expect(parseHeartbeat(undefined)).toBeNull();
		expect(parseHeartbeat([])).toBeNull();
	});

	it("maps status, per-poll deltas and cumulative totals separately", () => {
		const view = parseHeartbeat({
			at: "2026-06-13T10:00:00.000Z",
			raw: {
				ingest: {
					status: "CONNECTED",
					healthy: true,
					droppedPacketsVideo: 17,
					droppedPacketsAudio: 0,
					corruptPacketsVideo: 2,
					streams: [],
				},
				events: [],
			},
			deltas: { droppedPacketsVideo: 3, droppedPacketsAudio: 0 },
		});
		expect(view).not.toBeNull();
		expect(view?.at).toBe("2026-06-13T10:00:00.000Z");
		expect(view?.ingestStatus).toBe("CONNECTED");
		expect(view?.healthy).toBe(true);
		// Deltas (this poll) and totals (cumulative since start) stay distinct.
		expect(view?.deltas.droppedPacketsVideo).toBe(3);
		expect(view?.totals.droppedPacketsVideo).toBe(17);
		expect(view?.deltas.droppedPacketsAudio).toBe(0);
		expect(view?.totals.corruptPacketsVideo).toBe(2);
		expect(view?.deltas.corruptPacketsVideo).toBeUndefined();
	});

	/**
	 * The stream shape is the PERSISTED one (LiveHeartbeat rows read on
	 * 2026-09-02): `streamId`, `keyFrameIntervalAvg/Max` and the
	 * `…LastMinute` pair. The earlier revision of this test hand-built a
	 * `keyFrameInterval` field the wire never carries, so the column rendered
	 * "—" in production while the test stayed green.
	 */
	it("maps per-stream rows (codec / resolution / rate / bitrate / the four keyframe figures)", () => {
		const view = parseHeartbeat({
			at: "2026-06-13T10:00:00.000Z",
			raw: {
				ingest: {
					status: "CONNECTED",
					streams: [
						{
							streamId: "0",
							mediaType: "video",
							codec: "h264",
							width: 1280,
							height: 720,
							rate: 30,
							bitrate: 6_144_000,
							incomingBitrate: 754_499.55,
							keyFrameIntervalAvg: 3956.932247557003,
							keyFrameIntervalMax: 8334,
							keyFrameIntervalAvgLastMinute: 7418.222222222223,
							keyFrameIntervalMaxLastMinute: 8334,
						},
						{
							streamId: "1",
							mediaType: "audio",
							codec: "aac",
							rate: 48_000,
							bitrate: 163_840,
							keyFrameIntervalAvg: null,
							keyFrameIntervalMax: null,
							keyFrameIntervalAvgLastMinute: null,
							keyFrameIntervalMaxLastMinute: null,
						},
						{ codec: "aac", samplingRate: 48_000, bitrate: 128_000 },
					],
				},
			},
			deltas: {},
		});
		expect(view?.streams).toHaveLength(3);
		expect(view?.streams[0]).toEqual({
			id: "0",
			mediaType: "video",
			codec: "h264",
			resolution: "1280×720",
			rate: "30",
			bitrate: "6144000",
			incomingBitrate: 754_499.55,
			keyframeAvg: "3957",
			keyframeMax: "8334",
			keyframeLastMinute: "7418 / 8334",
		});
		// Audio: the provider sends null for every keyframe figure.
		expect(view?.streams[1]).toEqual(
			expect.objectContaining({
				id: "1",
				keyframeAvg: "—",
				keyframeMax: "—",
				keyframeLastMinute: "—",
			}),
		);
		expect(view?.streams[2]).toEqual(
			expect.objectContaining({
				id: "stream 3",
				codec: "aac",
				resolution: "—",
				rate: "48000",
			}),
		);
	});

	it("the last-minute pair renders whichever half is present, absent until the rolling window has a sample", () => {
		const view = parseHeartbeat({
			at: "2026-06-13T10:00:00.000Z",
			raw: {
				ingest: {
					status: "CONNECTED",
					streams: [
						{ streamId: "0", keyFrameIntervalAvg: 2000.4 },
						{ streamId: "1", keyFrameIntervalMaxLastMinute: 2167 },
					],
				},
			},
			deltas: {},
		});
		expect(view?.streams[0]).toEqual(
			expect.objectContaining({ keyframeAvg: "2000", keyframeLastMinute: "—" }),
		);
		expect(view?.streams[1]).toEqual(
			expect.objectContaining({
				keyframeAvg: "—",
				keyframeLastMinute: "— / 2167",
			}),
		);
	});

	/**
	 * Events are `{ time, details: { eventType, message } }` on the wire
	 * (SDK LiveEncodingHeartbeatEvent; measured). The earlier test fed a
	 * top-level `message`, so the production rendering of a real WARNING was
	 * the JSON of its `details` object.
	 */
	it("maps events from details.eventType / details.message, and tolerates the older and unknown shapes", () => {
		const KEYFRAME =
			"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
		const view = parseHeartbeat({
			at: "x",
			raw: {
				ingest: { status: "CONNECTED" },
				events: [
					{
						time: "2026-09-02T07:49:49.000Z",
						details: { eventType: "FIRST_CONNECT", message: null },
					},
					{
						time: "2026-09-02T07:49:51.000Z",
						details: { eventType: "WARNING", message: KEYFRAME },
					},
					{ time: "2026-06-13T09:59:00.000Z", message: "ingest connected" },
					{ type: "WARNING", detail: "jitter" },
					"plain string",
				],
			},
			deltas: {},
		});
		expect(view?.events[0]).toEqual({
			time: "2026-09-02T07:49:49.000Z",
			eventType: "FIRST_CONNECT",
			text: "FIRST_CONNECT",
		});
		expect(view?.events[1]).toEqual({
			time: "2026-09-02T07:49:51.000Z",
			eventType: "WARNING",
			text: KEYFRAME,
		});
		expect(view?.events[2]).toEqual({
			time: "2026-06-13T09:59:00.000Z",
			eventType: "—",
			text: "ingest connected",
		});
		expect(view?.events[3]?.text).toContain("WARNING");
		expect(view?.events[4]).toEqual({
			time: "—",
			eventType: "—",
			text: "plain string",
		});
	});

	it("degrades to UNKNOWN status on malformed samples instead of throwing", () => {
		const view = parseHeartbeat({ at: 42, raw: "garbage", deltas: 7 });
		expect(view).not.toBeNull();
		expect(view?.ingestStatus).toBe("UNKNOWN");
		expect(view?.at).toBeNull();
		expect(view?.streams).toEqual([]);
		expect(view?.events).toEqual([]);
	});
});
