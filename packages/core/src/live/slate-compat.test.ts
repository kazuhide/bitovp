import { describe, expect, it } from "vitest";
import {
	compareMediaAttributes,
	describeMediaDifferences,
	evaluateMediaAttributes,
	heartbeatIngestMedia,
	MEDIA_ATTRIBUTE,
	MEDIA_ATTRIBUTE_NAMES,
	type MediaAttributes,
	type ProbeResult,
	type ProbeStream,
} from "./media-attributes";
import {
	classifySlateMedia,
	compareSlateCompatibility,
	normalizeSlateInputPath,
	SLATE_ALLOW_IMAGES,
	SLATE_BLOCKING_ATTRIBUTES,
	SLATE_CONTAINER_ALLOWLIST,
	SLATE_CONTAINER_ATTRIBUTE,
	SLATE_KIND_ATTRIBUTE,
	SLATE_POSITION_ATTRIBUTE,
	slateContainer,
	slateImageDifference,
	slatePositionDifference,
} from "./slate-compat";

/**
 * The ingest measured on 2026-09-02 (channel 0645c2f1): 1280×720 @ 30 fps
 * H.264, AAC 48 kHz stereo — and the clip that failed against it.
 */
const INGEST: MediaAttributes = {
	video: {
		codec: "h264",
		width: 1280,
		height: 720,
		frameRate: 30,
		frameRateText: "30/1",
		profile: "High",
		level: 31,
		pixelFormat: "yuv420p",
	},
	audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
};

const MATCHING: ProbeResult = {
	format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			profile: "High",
			level: 31,
			pix_fmt: "yuv420p",
			width: 1280,
			height: 720,
			r_frame_rate: "30/1",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "48000",
			channels: 2,
		},
	],
};

/** AWOLNATION_muxed.mkv as ffprobe reported it. */
const MEASURED_FAILURE: ProbeResult = {
	format: { format_name: "matroska,webm" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			profile: "High",
			level: 31,
			pix_fmt: "yuv420p",
			width: 1280,
			height: 720,
			r_frame_rate: "24000/1001",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "44100",
			channels: 2,
		},
	],
};

const MATCHING_VIDEO = MATCHING.streams?.[0] as ProbeStream;
const MATCHING_AUDIO = MATCHING.streams?.[1] as ProbeStream;

function withVideo(patch: Record<string, unknown>): ProbeResult {
	return {
		...MATCHING,
		streams: [{ ...MATCHING_VIDEO, ...patch }, MATCHING_AUDIO],
	};
}

function withAudio(patch: Record<string, unknown>): ProbeResult {
	return {
		...MATCHING,
		streams: [MATCHING_VIDEO, { ...MATCHING_AUDIO, ...patch }],
	};
}

describe("compareMediaAttributes — the table, one attribute at a time", () => {
	const cases: {
		attribute: string;
		probe: ProbeResult;
		reference: string;
		candidate: string;
	}[] = [
		{
			attribute: MEDIA_ATTRIBUTE.videoCodec,
			probe: withVideo({ codec_name: "hevc" }),
			reference: "h264",
			candidate: "hevc",
		},
		{
			attribute: MEDIA_ATTRIBUTE.resolution,
			probe: withVideo({ width: 1920, height: 1080 }),
			reference: "1280×720",
			candidate: "1920×1080",
		},
		{
			attribute: MEDIA_ATTRIBUTE.frameRate,
			probe: withVideo({ r_frame_rate: "24000/1001" }),
			reference: "30/1",
			candidate: "24000/1001",
		},
		{
			attribute: MEDIA_ATTRIBUTE.h264Profile,
			probe: withVideo({ profile: "Main" }),
			reference: "High",
			candidate: "Main",
		},
		{
			attribute: MEDIA_ATTRIBUTE.h264Level,
			probe: withVideo({ level: 41 }),
			reference: "31",
			candidate: "41",
		},
		{
			attribute: MEDIA_ATTRIBUTE.pixelFormat,
			probe: withVideo({ pix_fmt: "yuv420p10le" }),
			reference: "yuv420p",
			candidate: "yuv420p10le",
		},
		{
			attribute: MEDIA_ATTRIBUTE.audioCodec,
			probe: withAudio({ codec_name: "mp3" }),
			reference: "aac",
			candidate: "mp3",
		},
		{
			attribute: MEDIA_ATTRIBUTE.audioSampleRate,
			probe: withAudio({ sample_rate: "44100" }),
			reference: "48000 Hz",
			candidate: "44100 Hz",
		},
		{
			attribute: MEDIA_ATTRIBUTE.audioChannels,
			probe: withAudio({ channels: 6 }),
			reference: "2",
			candidate: "6",
		},
	];

	for (const c of cases) {
		it(`reports ${c.attribute} and nothing else`, () => {
			const result = compareSlateCompatibility(INGEST, c.probe);
			expect(result.differences).toEqual([
				{
					attribute: c.attribute,
					reference: c.reference,
					candidate: c.candidate,
					blocking: true,
				},
			]);
			expect(result.ok).toBe(false);
		});
	}

	it("the table covers every attribute name it advertises", () => {
		// Every name in MEDIA_ATTRIBUTE_NAMES is produced by SOME arm above or by
		// the two structural rows below — a row added to the table without a
		// case here would pass silently otherwise.
		const produced = new Set([
			...cases.map((c) => c.attribute),
			MEDIA_ATTRIBUTE.videoStream,
			MEDIA_ATTRIBUTE.audioStreams,
		]);
		expect([...produced].sort()).toEqual([...MEDIA_ATTRIBUTE_NAMES].sort());
	});

	it("a matching clip yields no difference", () => {
		expect(compareMediaAttributes(INGEST, INGEST)).toEqual([]);
		const result = compareSlateCompatibility(INGEST, MATCHING);
		expect(result).toMatchObject({
			ok: true,
			kind: "movie",
			container: "mp4",
			standDown: null,
			checked: { container: true, attributes: true },
			differences: [],
		});
	});

	it("an attribute missing on either side is never a difference", () => {
		// A heartbeat-derived reference knows numbers only — no codec, no
		// profile, no sample rate.
		const heartbeat: MediaAttributes = {
			video: { width: 1280, height: 720, frameRate: 30 },
			audio: [{ channels: 2 }],
		};
		expect(compareSlateCompatibility(heartbeat, MATCHING).differences).toEqual(
			[],
		);
	});

	it("frame rates within a hundredth of a frame are the same rate", () => {
		const ntsc: MediaAttributes = {
			video: { frameRate: 30000 / 1001 },
			audio: [],
		};
		expect(
			compareMediaAttributes(ntsc, {
				video: { frameRate: 29.97 },
				audio: [],
			}),
		).toEqual([]);
		expect(
			compareMediaAttributes(ntsc, {
				video: { frameRate: 30 },
				audio: [],
			}),
		).toHaveLength(1);
	});

	it("yuvj420p is yuv420p", () => {
		expect(
			compareSlateCompatibility(INGEST, withVideo({ pix_fmt: "yuvj420p" }))
				.differences,
		).toEqual([]);
	});

	it("a missing video stream and an audio-count mismatch are structural rows", () => {
		const noVideo: ProbeResult = {
			...MATCHING,
			streams: (MATCHING.streams ?? []).slice(1),
		};
		const result = compareSlateCompatibility(INGEST, noVideo);
		expect(result.differences.map((d) => d.attribute)).toEqual([
			// Audio at position 0 is the positional rule, then the absence.
			SLATE_POSITION_ATTRIBUTE,
			MEDIA_ATTRIBUTE.videoStream,
		]);
		const twoAudio: ProbeResult = {
			...MATCHING,
			streams: [
				...(MATCHING.streams ?? []),
				{
					codec_type: "audio",
					codec_name: "aac",
					sample_rate: "48000",
					channels: 2,
				},
			],
		};
		expect(compareSlateCompatibility(INGEST, twoAudio).differences).toEqual([
			{
				attribute: MEDIA_ATTRIBUTE.audioStreams,
				reference: "1",
				candidate: "2",
				blocking: true,
			},
		]);
	});

	it("describes differences one line per attribute", () => {
		const text = describeMediaDifferences([
			{ attribute: "frame rate", reference: "30/1", candidate: "24000/1001" },
			{
				attribute: "resolution",
				reference: "1280×720",
				candidate: "1920×1080",
				blocking: false,
			},
		]);
		expect(text).toBe(
			"frame rate 30/1 → 24000/1001\nresolution 1280×720 → 1920×1080 (will be re-encoded to match)",
		);
	});
});

describe("the measured 2026-09-02 failure (WP-0 A/B, four arms)", () => {
	it("is refused on frame rate and sample rate; the container is listed LAST and blocks too (row #330)", () => {
		const result = compareSlateCompatibility(INGEST, MEASURED_FAILURE);
		expect(result.ok).toBe(false);
		expect(result.kind).toBe("movie");
		expect(result.container).toBe("matroska");
		expect(result.differences).toEqual([
			{
				attribute: MEDIA_ATTRIBUTE.frameRate,
				reference: "30/1",
				candidate: "24000/1001",
				blocking: true,
			},
			{
				attribute: MEDIA_ATTRIBUTE.audioSampleRate,
				reference: "48000 Hz",
				candidate: "44100 Hz",
				blocking: true,
			},
			{
				attribute: SLATE_CONTAINER_ATTRIBUTE,
				reference: "mp4/mpegts",
				candidate: "matroska",
				blocking: true,
			},
		]);
	});

	it("arm 3: the same attributes in an MP4 fail identically — the container is not the cause", () => {
		const mp4 = {
			...MEASURED_FAILURE,
			format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
		};
		const result = compareSlateCompatibility(INGEST, mp4);
		expect(result.ok).toBe(false);
		expect(result.differences.map((d) => d.attribute)).toEqual([
			MEDIA_ATTRIBUTE.frameRate,
			MEDIA_ATTRIBUTE.audioSampleRate,
		]);
	});

	it("arm 2: the matching MP4 passes", () => {
		expect(compareSlateCompatibility(INGEST, MATCHING).ok).toBe(true);
	});

	it("an MKV whose attributes match is REFUSED on the container alone (row #330: it reaches READY and never airs)", () => {
		const mkv = { ...MATCHING, format: { format_name: "matroska,webm" } };
		const result = compareSlateCompatibility(INGEST, mkv);
		expect(result.ok).toBe(false);
		expect(result.differences).toEqual([
			{
				attribute: SLATE_CONTAINER_ATTRIBUTE,
				reference: "mp4/mpegts",
				candidate: "matroska",
				blocking: true,
			},
		]);
	});
});

/**
 * rev406 R1 — the reference most channels actually have. 72 of the owner's
 * 116 runs (all three of the measured channel's) carry no recorded
 * `ingestMedia`, so the reference is the heartbeat; its audio stream carries
 * the sample rate as `rate`, and the reader threw it away — the preflight
 * answered "OK" for a 30 fps / 44.1 kHz clip on the very channel the failure
 * was measured on. These are the reviewer's probes, on the REAL sample shape.
 */
describe("a heartbeat-derived reference (rev406 R1)", () => {
	const heartbeat = heartbeatIngestMedia({
		at: "2026-09-02T13:40:00.000Z",
		raw: {
			ingest: {
				streams: [
					{
						mediaType: "video",
						codec: "h264",
						width: 1280,
						height: 720,
						rate: 30,
					},
					{
						mediaType: "audio",
						codec: "aac",
						rate: 48000,
						numberOfAudioChannels: null,
					},
				],
			},
		},
	});

	it("sees the audio sample rate: the MKV arm lists frame rate, sample rate AND the container", () => {
		expect(heartbeat?.audio).toEqual([{ codec: "aac", sampleRate: 48000 }]);
		const result = compareSlateCompatibility(heartbeat, MEASURED_FAILURE);
		expect(result.ok).toBe(false);
		expect(result.differences.map((d) => d.attribute)).toEqual([
			MEDIA_ATTRIBUTE.frameRate,
			MEDIA_ATTRIBUTE.audioSampleRate,
			SLATE_CONTAINER_ATTRIBUTE,
		]);
	});

	it("refuses an MP4 at 30 fps / 44.1 kHz — the arm that answered OK before", () => {
		const result = compareSlateCompatibility(
			heartbeat,
			withAudio({ sample_rate: "44100" }),
		);
		expect(result.ok).toBe(false);
		expect(result.standDown).toBeNull();
		expect(result.differences).toEqual([
			{
				attribute: MEDIA_ATTRIBUTE.audioSampleRate,
				reference: "48000 Hz",
				candidate: "44100 Hz",
				blocking: true,
			},
		]);
	});

	it("an OK verdict names what it compared and what it could not", () => {
		const result = compareSlateCompatibility(heartbeat, MATCHING);
		expect(result.ok).toBe(true);
		expect(result.standDown).toBeNull();
		expect(result.compared).toEqual([
			SLATE_KIND_ATTRIBUTE,
			SLATE_POSITION_ATTRIBUTE,
			MEDIA_ATTRIBUTE.videoStream,
			MEDIA_ATTRIBUTE.videoCodec,
			MEDIA_ATTRIBUTE.resolution,
			MEDIA_ATTRIBUTE.frameRate,
			MEDIA_ATTRIBUTE.audioStreams,
			MEDIA_ATTRIBUTE.audioCodec,
			MEDIA_ATTRIBUTE.audioSampleRate,
			SLATE_CONTAINER_ATTRIBUTE,
		]);
		// The heartbeat knows no profile, level, pixel format or channel count.
		expect(result.notComparable).toEqual([
			MEDIA_ATTRIBUTE.h264Profile,
			MEDIA_ATTRIBUTE.h264Level,
			MEDIA_ATTRIBUTE.pixelFormat,
			MEDIA_ATTRIBUTE.audioChannels,
		]);
	});

	it("evaluateMediaAttributes: an attribute compared on any audio pair is compared, not both", () => {
		const evaluation = evaluateMediaAttributes(
			{
				video: { width: 1280, height: 720 },
				audio: [{ sampleRate: 48000 }, {}],
			},
			{
				video: { width: 1280, height: 720 },
				audio: [{ sampleRate: 48000 }, { sampleRate: 48000 }],
			},
		);
		expect(evaluation.differences).toEqual([]);
		expect(evaluation.compared).toContain(MEDIA_ATTRIBUTE.audioSampleRate);
		expect(evaluation.notComparable).not.toContain(
			MEDIA_ATTRIBUTE.audioSampleRate,
		);
		expect(evaluation.notComparable).toContain(MEDIA_ATTRIBUTE.frameRate);
	});
});

describe("container allowlist", () => {
	it("admits the QuickTime demuxer family under either token", () => {
		expect(
			slateContainer({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }),
		).toBe("mp4");
		expect(slateContainer({ format: { format_name: "mp4" } })).toBe("mp4");
		expect(slateContainer({ format: { format_name: "MOV" } })).toBe("mp4");
		expect(SLATE_CONTAINER_ALLOWLIST).toEqual(["mov", "mp4"]);
	});

	it("names matroska and mpegts by their first token; MPEG-TS is admitted with no container difference", () => {
		expect(slateContainer({ format: { format_name: "matroska,webm" } })).toBe(
			"matroska",
		);
		expect(slateContainer({ format: { format_name: "mpegts" } })).toBe(
			"mpegts",
		);
		const ts = compareSlateCompatibility(null, {
			...MATCHING,
			format: { format_name: "mpegts" },
		});
		expect(ts.ok).toBe(true);
		expect(ts.differences).toEqual([]);
	});

	it("a probe without a format name is no opinion on the container", () => {
		const bare: ProbeResult = { streams: MATCHING.streams };
		expect(slateContainer(bare)).toBeNull();
		expect(classifySlateMedia(bare)).toBe("unknown");
		const result = compareSlateCompatibility(INGEST, bare);
		expect(result.ok).toBe(true);
		expect(result.container).toBeNull();
		expect(result.differences).toEqual([]);
	});

	it("the container still refuses when the ingest reference is missing", () => {
		const result = compareSlateCompatibility(null, MEASURED_FAILURE);
		// No reference → the attribute table stands down; the container needs
		// no reference, and an MKV blocks on its own .
		expect(result.ok).toBe(false);
		expect(result.standDown).toBe("NO_INGEST_REFERENCE");
		expect(result.checked).toEqual({ container: true, attributes: false });
		expect(result.differences).toEqual([
			{
				attribute: SLATE_CONTAINER_ATTRIBUTE,
				reference: "mp4/mpegts",
				candidate: "matroska",
				blocking: true,
			},
		]);
	});
});

describe("image content", () => {
	const png: ProbeResult = {
		format: { format_name: "png_pipe" },
		streams: [
			{
				codec_type: "video",
				codec_name: "png",
				width: 1920,
				height: 1080,
				r_frame_rate: "25/1",
			},
		],
	};

	it("is ADMITTED as a kind — the attribute table stands down for a still (row #329)", () => {
		expect(SLATE_ALLOW_IMAGES).toBe(true);
		expect(classifySlateMedia(png)).toBe("image");
		const result = compareSlateCompatibility(INGEST, png);
		expect(result).toMatchObject({
			ok: true,
			kind: "image",
			container: "png_pipe",
			// The attribute table does not apply to a still, so it never ran.
			checked: { container: true, attributes: false },
			differences: [],
		});
		expect(slateImageDifference(result)).toBeUndefined();
	});

	it("is admitted even without an ingest reference — a still needs nothing to match (row #329)", () => {
		const result = compareSlateCompatibility(null, png);
		expect(result.ok).toBe(true);
		expect(result.kind).toBe("image");
		expect(result.differences).toEqual([]);
	});
});

describe("stand-downs", () => {
	it("no probe: nothing can be checked, and the verdict says so", () => {
		expect(compareSlateCompatibility(INGEST, null)).toEqual({
			ok: true,
			checked: { container: false, attributes: false },
			standDown: "NO_PROBE",
			kind: "unknown",
			container: null,
			differences: [],
			compared: [],
			notComparable: [],
		});
	});

	it("a reference with nothing substantive to compare stands down as NO_COMPARABLE_ATTRIBUTE, never OK", () => {
		// A heartbeat that reported a video stream with no geometry or rate and
		// no audio numbers: stream presence alone is not a comparison.
		const hollow: MediaAttributes = { video: {}, audio: [{}] };
		const result = compareSlateCompatibility(hollow, MATCHING);
		expect(result.standDown).toBe("NO_COMPARABLE_ATTRIBUTE");
		expect(result.checked.attributes).toBe(false);
		expect(result.ok).toBe(true);
		expect(result.differences).toEqual([]);
		// A structural difference still refuses: two audio streams against one.
		const twoAudio: ProbeResult = {
			...MATCHING,
			streams: [...(MATCHING.streams ?? []), MATCHING_AUDIO],
		};
		const refused = compareSlateCompatibility(hollow, twoAudio);
		expect(refused.ok).toBe(false);
		expect(refused.standDown).toBeNull();
	});

	it("no ingest reference: the attribute table stands down, ok by absence of evidence", () => {
		const result = compareSlateCompatibility(
			null,
			withVideo({ r_frame_rate: "25/1" }),
		);
		expect(result.ok).toBe(true);
		expect(result.standDown).toBe("NO_INGEST_REFERENCE");
		expect(result.checked.attributes).toBe(false);
		expect(result.differences).toEqual([]);
	});
});

describe("video at stream position 0", () => {
	it("an audio-first layout is refused positionally, with what sits there", () => {
		const result = compareSlateCompatibility(INGEST, {
			...MATCHING,
			streams: [MATCHING_AUDIO, MATCHING_VIDEO],
		});
		expect(result.ok).toBe(false);
		expect(slatePositionDifference(result)).toEqual({
			attribute: SLATE_POSITION_ATTRIBUTE,
			reference: "video",
			candidate: "audio",
			blocking: true,
		});
		// Attributes all match, so the layout is the only difference.
		expect(result.differences).toHaveLength(1);
	});
});

describe("the rule set is data", () => {
	it("every table attribute plus position, kind and (since row #330) the container block", () => {
		expect([...SLATE_BLOCKING_ATTRIBUTES].sort()).toEqual(
			[
				SLATE_POSITION_ATTRIBUTE,
				SLATE_KIND_ATTRIBUTE,
				SLATE_CONTAINER_ATTRIBUTE,
				...MEDIA_ATTRIBUTE_NAMES,
			].sort(),
		);
		expect(SLATE_BLOCKING_ATTRIBUTES.has(SLATE_CONTAINER_ATTRIBUTE)).toBe(true);
	});

	it("a difference outside the blocking set is reported, not refused", () => {
		// The verdict reads the set at call time, so demoting an attribute is
		// the one-line change the rule was built for. Simulated by checking the
		// derivation rather than mutating a frozen set: `ok` is exactly "no
		// blocking difference".
		const result = compareSlateCompatibility(INGEST, withVideo({ level: 41 }));
		expect(result.ok).toBe(!result.differences.some((d) => d.blocking));
		expect(result.differences[0]?.blocking).toBe(
			SLATE_BLOCKING_ATTRIBUTES.has(MEDIA_ATTRIBUTE.h264Level),
		);
	});
});

describe("normalizeSlateInputPath", () => {
	it("strips a leading slash and records the original", () => {
		expect(normalizeSlateInputPath("/slates/brb.mp4")).toEqual({
			path: "slates/brb.mp4",
			original: "/slates/brb.mp4",
			stripped: true,
		});
		expect(normalizeSlateInputPath("//slates/brb.mp4").path).toBe(
			"slates/brb.mp4",
		);
	});

	it("leaves a bare key alone", () => {
		expect(normalizeSlateInputPath("slates/brb.mp4")).toEqual({
			path: "slates/brb.mp4",
			original: "slates/brb.mp4",
			stripped: false,
		});
	});

	it("trims whitespace without counting it as a strip", () => {
		expect(normalizeSlateInputPath("  slates/brb.mp4 ")).toEqual({
			path: "slates/brb.mp4",
			original: "  slates/brb.mp4 ",
			stripped: false,
		});
	});
});
