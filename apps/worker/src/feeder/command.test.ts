import { describe, expect, it } from "vitest";
import {
	AAC_FRAME_SAMPLES,
	buildFeederCommand,
	buildLineRedactor,
	buildNormalizeCommand,
	type CodecDecision,
	checkSourceSatisfiesIngest,
	compareSourceCompatibility,
	decideCodecMode,
	describeSourceDifferences,
	expectedIngestMedia,
	heartbeatIngestMedia,
	loopProfileFromProbe,
	type MediaAttributes,
	normalisationTargets,
	normalizedAudioSamples,
	normalizedSpoolPath,
	type ProbeResult,
	type ProbeStream,
	parseFrameRate,
	parseMediaAttributes,
	parseProbeJson,
	probeArgs,
	pushedMediaAttributes,
	sourceDurationSec,
	sourceMediaAttributes,
} from "./command";

const h264 = {
	codec_type: "video",
	codec_name: "h264",
	pix_fmt: "yuv420p",
};
const aac = { codec_type: "audio", codec_name: "aac" };

function probe(
	streams: ProbeResult["streams"],
	duration = "30.5",
): ProbeResult {
	return { streams, format: { duration } };
}

describe("decideCodecMode (copy vs transcode table)", () => {
	const cases: [string, ProbeResult, CodecDecision["mode"], RegExp?][] = [
		["h264+aac 4:2:0", probe([h264, aac]), "copy", undefined],
		//  (leading hypothesis until the single-variable re-run):
		// >2ch audio must not ride FLV. Copy-perfect otherwise ⇒ the
		// video-copying AUDIO-ONLY downmix, never the 0.998x full transcode
		// (review-227 I2).
		[
			"5.1 audio, copy-perfect otherwise ⇒ audio-only downmix mode",
			probe([h264, { ...aac, channels: 6 }]),
			"transcode-audio",
			/6 channels — RTMP\/FLV ingest is the never-binds class/,
		],
		[
			"stereo audio stays copyable",
			probe([h264, { ...aac, channels: 2 }]),
			"copy",
			undefined,
		],
		// review-227 S1: mono is ≤2 — copyable; kills the `!== 2` boundary
		// mutation that survived the first round.
		[
			"mono audio stays copyable",
			probe([h264, { ...aac, channels: 1 }]),
			"copy",
			undefined,
		],
		[
			"5.1 WITH a video nonconformance takes the FULL transcode, reasons merged",
			probe([
				{ ...h264, codec_name: "hevc" },
				{ ...aac, channels: 6 },
			]),
			"transcode",
			// review-227 S4: BOTH halves of the name pinned — dropping the
			// ...audioOnlyReasons merge survived 45/45 until this regex
			// demanded the downmix reason alongside the video one.
			/not h264[\s\S]*6 channels|6 channels[\s\S]*not h264/,
		],
		["h264 video-only", probe([h264]), "copy", undefined],
		[
			"full-range yuvj420p stays copyable",
			probe([{ ...h264, pix_fmt: "yuvj420p" }, aac]),
			"copy",
			undefined,
		],
		[
			"hevc video",
			probe([{ ...h264, codec_name: "hevc" }, aac]),
			"transcode",
			/not h264/,
		],
		[
			"10-bit High10",
			probe([{ ...h264, pix_fmt: "yuv420p10le" }, aac]),
			"transcode",
			/not 8-bit 4:2:0/,
		],
		[
			"4:2:2 chroma",
			probe([{ ...h264, pix_fmt: "yuv422p" }, aac]),
			"transcode",
			/not 8-bit 4:2:0/,
		],
		[
			"missing pix_fmt (unknown is non-copyable)",
			probe([{ codec_type: "video", codec_name: "h264" }, aac]),
			"transcode",
			/pixel format unknown/,
		],
		[
			"mp3 audio",
			probe([h264, { codec_type: "audio", codec_name: "mp3" }]),
			"transcode",
			/not aac/,
		],
		[
			"second audio track non-aac",
			probe([h264, aac, { codec_type: "audio", codec_name: "ac3" }]),
			"transcode",
			/ac3 is not aac/,
		],
		["no video stream", probe([aac]), "transcode", /no video stream/],
		["two video streams", probe([h264, h264]), "transcode", /2 video streams/],
		["empty probe", {}, "transcode", /no video stream/],
	];

	it.each(cases)("%s → %s", (_name, input, mode, reason) => {
		const decision = decideCodecMode(input);
		expect(decision.mode).toBe(mode);
		if (reason) {
			expect(decision.reasons.join("; ")).toMatch(reason);
		}
	});
});

describe("probe helpers", () => {
	it("builds JSON ffprobe args ending in the source path", () => {
		const args = probeArgs("/spool/x.mp4");
		expect(args.at(-1)).toBe("/spool/x.mp4");
		expect(args).toContain("-show_streams");
		expect(args).toContain("-show_format");
	});

	it("parses duration and rejects garbage JSON loudly", () => {
		expect(sourceDurationSec(probe([h264], "12.000000"))).toBeCloseTo(12);
		expect(sourceDurationSec(probe([h264], "0"))).toBeUndefined();
		expect(sourceDurationSec({})).toBeUndefined();
		expect(parseProbeJson('{"streams":[]}')).toEqual({ streams: [] });
		expect(() => parseProbeJson("ffprobe: command not found")).toThrow(
			/no parseable JSON/,
		);
	});
});

const copy: CodecDecision = { mode: "copy", reasons: ["fixture"] };

describe("buildFeederCommand", () => {
	it("RTMP copy: -re -stream_loop -1 before -i, flv mux, key joined onto the url", () => {
		const { argv, redactedArgv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: copy,
			target: {
				protocol: "RTMP",
				url: "rtmp://203.0.113.7/live/",
				streamKey: "sk-secret-1",
			},
		});
		expect(argv).toEqual([
			"-hide_banner",
			"-nostdin",
			"-re",
			"-ignore_editlist",
			"1",
			"-stream_loop",
			"-1",
			"-i",
			"/spool/s.mp4",
			"-c",
			"copy",
			"-progress",
			"pipe:1",
			"-f",
			"flv",
			"rtmp://203.0.113.7/live/sk-secret-1",
		]);
		// The stream key never appears in the loggable form.
		expect(redactedArgv.join(" ")).not.toContain("sk-secret-1");
		expect(redactedArgv.at(-1)).toBe("rtmp://203.0.113.7/live/[REDACTED]");
	});

	it("transcode fallback carries the live x264/aac defaults", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: { mode: "transcode", reasons: ["hevc"] },
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
		});
		const joined = argv.join(" ");
		expect(joined).toContain("-c:v libx264 -preset veryfast -tune zerolatency");
		expect(joined).toContain("-pix_fmt yuv420p");
		expect(joined).toContain("-g 60 -sc_threshold 0");
		// #99: stereo rides the RTMP branch (FLV-scoped), after the codec set.
		expect(joined).toContain("-c:a aac -b:a 128k -ar 48000");
		expect(joined).toContain("-ac 2");
		expect(joined).not.toContain("-c copy");
	});

	it("audio-only downmix mode: video COPIES through, audio re-encodes to stereo (review-227 I2)", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: { mode: "transcode-audio", reasons: ["6ch"] },
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
		});
		const joined = argv.join(" ");
		expect(joined).toContain("-c:v copy");
		expect(joined).toContain("-c:a aac -b:a 128k -ar 48000");
		expect(joined).toContain("-ac 2");
		expect(joined).not.toContain("libx264");
		// review-229 S1: -tune under -c:v copy is silently ignored by ffmpeg
		// (measured) — benign, but its presence here would mislead a reader.
		expect(joined).not.toContain("-tune");
	});

	it("SRT keeps the source's channel layout — the >2ch refusal is FLV-scoped (review-227 I3)", () => {
		// Decision: 5.1 over SRT stays COPY (MPEG-TS carries it natively).
		expect(
			decideCodecMode(probe([h264, { ...aac, channels: 6 }]), "SRT_CALLER")
				.mode,
		).toBe("copy");
		// And an SRT TRANSCODE argv carries NO -ac 2 — stereo enforcement
		// rides the RTMP/FLV branch only.
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: { mode: "transcode", reasons: ["hevc"] },
			target: { protocol: "SRT_CALLER", host: "ingest.example", port: 2088 },
		});
		const joined = argv.join(" ");
		expect(joined).toContain("libx264");
		expect(joined).not.toContain("-ac 2");
		expect(argv.at(-1)).toBe("srt://ingest.example:2088?mode=caller");
	});

	it("SRT caller: mpegts to srt://host:port?mode=caller, no passphrase", () => {
		const { argv, redactedArgv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: copy,
			target: { protocol: "SRT_CALLER", host: "ingest.example", port: 2088 },
		});
		expect(argv.at(-2)).toBe("mpegts");
		expect(argv.at(-1)).toBe("srt://ingest.example:2088?mode=caller");
		expect(redactedArgv.at(-1)).toBe("srt://ingest.example:2088?mode=caller");
	});

	it.each([
		["16-char passphrase → pbkeylen 16 (AES-128)", "p".repeat(16), 16],
		["32-char passphrase → pbkeylen 32 (AES-256)", "q".repeat(32), 32],
	])("%s", (_name, passphrase, pbkeylen) => {
		const { argv, redactedArgv } = buildFeederCommand({
			sourcePath: "/s.mp4",
			decision: copy,
			target: {
				protocol: "SRT_CALLER",
				host: "h",
				port: 2090,
				passphrase,
			},
		});
		expect(argv.at(-1)).toBe(
			`srt://h:2090?mode=caller&passphrase=${passphrase}&pbkeylen=${pbkeylen}`,
		);
		// Redacted form keeps the tuning visible but masks the secret.
		expect(redactedArgv.at(-1)).toBe(
			`srt://h:2090?mode=caller&passphrase=[REDACTED]&pbkeylen=${pbkeylen}`,
		);
		expect(redactedArgv.join(" ")).not.toContain(passphrase);
	});

	it.each([
		[10],
		[20],
		[31],
		[33],
	])("hard-errors on a %i-char SRT passphrase (pbkeylen tripwire — no silent 32)", (length) => {
		expect(() =>
			buildFeederCommand({
				sourcePath: "/s.mp4",
				decision: copy,
				target: {
					protocol: "SRT_CALLER",
					host: "h",
					port: 2090,
					passphrase: "x".repeat(length),
				},
			}),
		).toThrow(/exactly 16 \(AES-128\) or 32 \(AES-256\)/);
	});

	it("rejects passphrases that would break libsrt's non-unescaping URL parse", () => {
		expect(() =>
			buildFeederCommand({
				sourcePath: "/s.mp4",
				decision: copy,
				target: {
					protocol: "SRT_CALLER",
					host: "h",
					port: 2088,
					passphrase: "bad&chars0123456",
				},
			}),
		).toThrow(/unsafe for URL transport/);
	});
});

describe("buildLineRedactor", () => {
	it("scrubs known secret literals and generic passphrase= values", () => {
		const redact = buildLineRedactor(["sk-secret-1", "p".repeat(16)]);
		expect(redact("Output #0, flv, to 'rtmp://h/live/sk-secret-1':")).toContain(
			"[REDACTED]",
		);
		expect(redact(`srt passphrase=${"p".repeat(16)} accepted`)).not.toContain(
			"p".repeat(16),
		);
		// Generic belt-and-braces even for unknown literals.
		expect(redact("opening srt://h:1?mode=caller&passphrase=zzz&x=1")).toBe(
			"opening srt://h:1?mode=caller&passphrase=[REDACTED]&x=1",
		);
		// Undefined slots (no SRT passphrase) are tolerated.
		expect(buildLineRedactor([undefined])("plain line")).toBe("plain line");
	});
});

/**
 *  — the ingest preflight.
 *
 * A redundant-RTMP channel declaring video at stream 0 and audio at stream 1
 * was fed `b01.mov`, which carries h264 at 0 and a `tmcd` TIMECODE track at 1
 * and no audio at all. ffmpeg completed the RTMP handshake, the session
 * reported PUSHING, and the channel published nothing: Bitmovin held the
 * ingest at WAITING_FOR_FIRST_CONNECT and closed after ~36s. Nothing in the
 * product could say why, because every layer that had a status showed a good
 * one. These pin the refusal that now happens before ffmpeg is spawned.
 */
describe("ingest preflight (ledger #46)", () => {
	const INGEST = [
		{ key: "video", position: 0 },
		{ key: "audio", position: 1 },
	];
	const RENDITIONS = [
		{ ingestKey: "video", codec: "H264" },
		{ ingestKey: "audio", codec: "AAC" },
	];

	it("reads the expected media type from the renditions, not the key's name", () => {
		// The keys here are deliberately MISLEADING: "alpha" carries AAC and
		// "beta" carries H264. A check that trusted the ref name would invert.
		expect(
			expectedIngestMedia(
				[
					{ key: "alpha", position: 0 },
					{ key: "beta", position: 1 },
				],
				[
					{ ingestKey: "alpha", codec: "AAC" },
					{ ingestKey: "beta", codec: "H265" },
				],
			),
		).toEqual([
			{ key: "alpha", position: 0, media: "audio" },
			{ key: "beta", position: 1, media: "video" },
		]);
	});

	it("leaves a position no rendition references as unknown", () => {
		expect(
			expectedIngestMedia([{ key: "spare", position: 2 }], RENDITIONS),
		).toEqual([{ key: "spare", position: 2, media: "unknown" }]);
	});

	it("ACCEPTS the broadcast layout [video, tmcd, audio] — the false refusal two reviews caught", () => {
		// `buildFeederCommand` emits no `-map`, so ffmpeg pushes one best video
		// plus one best audio and never pushes `tmcd`. The first version of this
		// check indexed the SOURCE layout and refused this file, which is a
		// commonplace broadcast MOV and the same family as the incident file —
		// only with audio present, i.e. a source that works today.
		expect(
			checkSourceSatisfiesIngest(
				{
					streams: [
						{ codec_type: "video", codec_name: "h264" },
						{ codec_type: "data", codec_name: "tmcd" },
						{ codec_type: "audio", codec_name: "aac" },
					],
				},
				expectedIngestMedia(INGEST, RENDITIONS),
			),
		).toEqual({ ok: true });
	});

	it("ACCEPTS audio-before-video — default selection is position-independent", () => {
		expect(
			checkSourceSatisfiesIngest(
				{
					streams: [
						{ codec_type: "audio", codec_name: "aac" },
						{ codec_type: "video", codec_name: "h264" },
					],
				},
				expectedIngestMedia(INGEST, RENDITIONS),
			),
		).toEqual({ ok: true });
	});

	it("refuses the REAL audio-with-cover-art layout: audio at 0, cover at 1", () => {
		// Exactly what ffprobe reports for an .m4a with embedded art — built
		// and probed by review-final rather than assumed, and the assumed
		// layout had it the other way round. The earlier positional check
		// refused this by accident; presence-counting must refuse it on
		// purpose, or ffmpeg maps the cover into the video slot (png → h264 at
		// 90k fps) and the channel receives a still image.
		const result = checkSourceSatisfiesIngest(
			{
				streams: [
					{ codec_type: "audio", codec_name: "aac" },
					{
						codec_type: "video",
						codec_name: "png",
						disposition: { attached_pic: 1 },
					},
				],
			},
			expectedIngestMedia(INGEST, RENDITIONS),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.reason).toContain("needs video");
	});

	it("refuses an audio-only file whose ONLY 'video' is album art", () => {
		// ffprobe types `attached_pic` cover art as codec_type "video", so
		// without the disposition check an MP3/M4A with album art satisfies a
		// video+audio plan and then publishes nothing — the very symptom this
		// preflight exists to catch (review-final found it; the positional
		// version had the identical hole).
		const result = checkSourceSatisfiesIngest(
			{
				streams: [
					{
						codec_type: "video",
						codec_name: "mjpeg",
						disposition: { attached_pic: 1 },
					},
					{ codec_type: "audio", codec_name: "aac" },
				],
			},
			expectedIngestMedia(INGEST, RENDITIONS),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.reason).toContain("needs video");
	});

	it("still accepts a real video track that happens to sit beside cover art", () => {
		expect(
			checkSourceSatisfiesIngest(
				{
					streams: [
						{
							codec_type: "video",
							codec_name: "mjpeg",
							disposition: { attached_pic: 1 },
						},
						{ codec_type: "video", codec_name: "h264" },
						{ codec_type: "audio", codec_name: "aac" },
					],
				},
				expectedIngestMedia(INGEST, RENDITIONS),
			),
		).toEqual({ ok: true });
	});

	it("accepts two ingests reading the SAME position — one stream serves both", () => {
		// A ladder and a thumbnail both off stream 0 is servable: default
		// selection pushes one video and both expectations read it. Counting
		// EXPECTATIONS rather than distinct positions made this a false
		// refusal, which the positional version did not make (review-final).
		expect(
			checkSourceSatisfiesIngest(
				{
					streams: [
						{ codec_type: "video", codec_name: "h264" },
						{ codec_type: "audio", codec_name: "aac" },
					],
				},
				expectedIngestMedia(
					[
						{ key: "v-ladder", position: 0 },
						{ key: "v-thumb", position: 0 },
						{ key: "audio", position: 1 },
					],
					[
						{ ingestKey: "v-ladder", codec: "H264" },
						{ ingestKey: "v-thumb", codec: "H264" },
						{ ingestKey: "audio", codec: "AAC" },
					],
				),
			),
		).toEqual({ ok: true });
	});

	it("refuses a plan wanting TWO audio ingests — the feeder pushes one", () => {
		const result = checkSourceSatisfiesIngest(
			{
				streams: [
					{ codec_type: "video", codec_name: "h264" },
					{ codec_type: "audio", codec_name: "aac" },
					{ codec_type: "audio", codec_name: "aac" },
				],
			},
			expectedIngestMedia(
				[
					{ key: "video", position: 0 },
					{ key: "audio-en", position: 1 },
					{ key: "audio-ja", position: 2 },
				],
				[
					{ ingestKey: "video", codec: "H264" },
					{ ingestKey: "audio-en", codec: "AAC" },
					{ ingestKey: "audio-ja", codec: "AAC" },
				],
			),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		// Named as a PLAN limitation, not blamed on the source, because no
		// source shape can satisfy it under default stream selection.
		expect(result.reason).toContain("2 audio ingests");
		expect(result.reason).toContain("pushes a single audio stream");
	});

	it("refuses the exact source that produced the zero-object channel", () => {
		// b01.mov as ffprobe reported it: h264, then a tmcd data track.
		const probe = {
			streams: [
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "data", codec_name: "tmcd" },
			],
		};
		const result = checkSourceSatisfiesIngest(
			probe,
			expectedIngestMedia(INGEST, RENDITIONS),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.reason).toContain('ingest "audio" needs audio');
		// The reason names what the source DOES carry, so an operator can see why.
		expect(result.reason).toContain("data");
		// : `reason` is now the DYNAMIC problem detail ONLY — the wrapper
		// prose ("Source cannot satisfy … publish nothing.") moved to the i18n
		// catalogue (`feederError.ingestUnsatisfied`), where the panel translates
		// it around this detail. Exact-equal, so re-inlining the English wrapper
		// here goes red.
		expect(result.reason).toBe(
			'ingest "audio" needs audio, but the source carries video, data',
		);
		// And it does NOT complain about the video position, which was fine.
		expect(result.reason).not.toContain('"video"');
	});

	it("names a video-only source as missing audio, not as too short", () => {
		const result = checkSourceSatisfiesIngest(
			{ streams: [{ codec_type: "video", codec_name: "h264" }] },
			expectedIngestMedia(INGEST, RENDITIONS),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.reason).toContain("needs audio");
		expect(result.reason).toContain("video");
	});

	it("passes a source that matches, and one whose expectations are unknown", () => {
		expect(
			checkSourceSatisfiesIngest(
				{
					streams: [
						{ codec_type: "video", codec_name: "h264" },
						{ codec_type: "audio", codec_name: "aac" },
					],
				},
				expectedIngestMedia(INGEST, RENDITIONS),
			),
		).toEqual({ ok: true });

		// No rendition references these keys — the check refuses only what it
		// can prove wrong, so an unmodelled plan shape must not block a push.
		expect(
			checkSourceSatisfiesIngest(
				{ streams: [] },
				expectedIngestMedia(INGEST, []),
			),
		).toEqual({ ok: true });
	});
});

describe("decideCodecMode and cover art (ledger #46)", () => {
	it("does not count cover art as the source's one video stream", () => {
		// A REAL video file that also carries album art looked like TWO video
		// streams, which forced a transcode where copy would have served.
		const decision = decideCodecMode({
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					pix_fmt: "yuv420p",
					profile: "High",
				},
				{
					codec_type: "video",
					codec_name: "png",
					disposition: { attached_pic: 1 },
				},
				{ codec_type: "audio", codec_name: "aac" },
			],
		});
		expect(decision.mode).toBe("copy");
		expect(decision.reasons.join(" ")).not.toContain("2 video streams");
	});

	it("still sees an audio-only file with art as having NO video", () => {
		const decision = decideCodecMode({
			streams: [
				{ codec_type: "audio", codec_name: "aac" },
				{
					codec_type: "video",
					codec_name: "png",
					disposition: { attached_pic: 1 },
				},
			],
		});
		expect(decision.reasons.join(" ")).toContain("no video stream in source");
	});
});

// ---------------------------------------------------------------------------
// Source compatibility gate
// ---------------------------------------------------------------------------

/**
 * The two sources of the 2026-08-29 paid A/B (audit §3.2), as ffprobe
 * describes them: the run started on `PROBE_REFERENCE_SOURCE` and the
 * incompatible switch pushed `PROBE_INCOMPATIBLE_SOURCE`. Bitmovin's
 * heartbeat warned on exactly the four attributes that differ here — frame
 * rate 30000/1001 → 24/1, profile 77 → 100 (Main → High), level 41 → 40,
 * resolution 1920x1080 → 1920x1012 — and dropped the ingest.
 */
const PROBE_REFERENCE_SOURCE: ProbeResult = {
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			profile: "Main",
			level: 41,
			pix_fmt: "yuv420p",
			width: 1920,
			height: 1080,
			r_frame_rate: "30000/1001",
			avg_frame_rate: "30000/1001",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "48000",
			channels: 2,
		},
	],
	format: { duration: "596.5" },
};

const PROBE_INCOMPATIBLE_SOURCE: ProbeResult = {
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			profile: "High",
			level: 40,
			pix_fmt: "yuv420p",
			width: 1920,
			height: 1012,
			r_frame_rate: "24/1",
			avg_frame_rate: "24/1",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "48000",
			channels: 2,
		},
	],
	format: { duration: "121.0" },
};

/** The reference source's two streams, reused to vary ONE attribute at a time. */
const refVideo = (PROBE_REFERENCE_SOURCE.streams ?? [])[0] as ProbeStream;
const refAudio = (PROBE_REFERENCE_SOURCE.streams ?? [])[1] as ProbeStream;

const copyDecision: CodecDecision = { mode: "copy", reasons: ["fixture"] };
const transcodeDecision: CodecDecision = {
	mode: "transcode",
	reasons: ["fixture"],
};

describe("frame-rate parsing (ledger #239)", () => {
	it("reads ffprobe's rational, which is the only form it emits", () => {
		expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 4);
		expect(parseFrameRate("24/1")).toBe(24);
		expect(parseFrameRate("25/1")).toBe(25);
		// A bare decimal is not ffprobe's shape but must not become NaN.
		expect(parseFrameRate("24")).toBe(24);
	});

	it("treats every no-rate form as absent rather than as zero", () => {
		// `0/0` is what ffprobe prints for a stream with no frame rate — a
		// still image, a data track. Zero would compare as a REAL difference
		// against every reference and refuse every switch.
		expect(parseFrameRate("0/0")).toBeUndefined();
		expect(parseFrameRate("")).toBeUndefined();
		expect(parseFrameRate(undefined)).toBeUndefined();
		expect(parseFrameRate("n/a")).toBeUndefined();
	});
});

describe("sourceMediaAttributes (ledger #239)", () => {
	it("carries frame rate, profile, level and pixel format off a real probe", () => {
		const attrs = sourceMediaAttributes(PROBE_REFERENCE_SOURCE);
		expect(attrs.video?.width).toBe(1920);
		expect(attrs.video?.height).toBe(1080);
		expect(attrs.video?.frameRate).toBeCloseTo(29.97, 4);
		// The fraction survives, because that is what Bitmovin's own warning
		// prints and what the operator has to recognise.
		expect(attrs.video?.frameRateText).toBe("30000/1001");
		expect(attrs.video?.profile).toBe("Main");
		expect(attrs.video?.level).toBe(41);
		expect(attrs.video?.pixelFormat).toBe("yuv420p");
		expect(attrs.audio).toEqual([
			{ codec: "aac", sampleRate: 48000, channels: 2 },
		]);
	});

	it("tolerates a probe missing every optional field", () => {
		const attrs = sourceMediaAttributes(probe([h264, aac]));
		expect(attrs.video).toEqual({ codec: "h264", pixelFormat: "yuv420p" });
		expect(attrs.audio).toEqual([{ codec: "aac" }]);
	});

	it("ignores cover art exactly as the copy decision does", () => {
		const attrs = sourceMediaAttributes(
			probe([
				{ ...aac, channels: 2 },
				{
					codec_type: "video",
					codec_name: "png",
					width: 600,
					height: 600,
					disposition: { attached_pic: 1 },
				},
			]),
		);
		expect(attrs.video).toBeUndefined();
	});
});

describe("pushedMediaAttributes — the wire, not the file (ledger #239)", () => {
	it("copy pushes the source through, minus the audio streams ffmpeg drops", () => {
		const source = sourceMediaAttributes({
			streams: [
				...(PROBE_REFERENCE_SOURCE.streams ?? []),
				{ codec_type: "audio", codec_name: "aac", channels: 2 },
			],
		});
		expect(source.audio).toHaveLength(2);
		// No -map ⇒ default stream selection ⇒ ONE audio reaches the encoder.
		const pushed = pushedMediaAttributes(source, copyDecision, "RTMP");
		expect(pushed.audio).toHaveLength(1);
		expect(pushed.video?.profile).toBe("Main");
	});

	it("transcode replaces codec and pixel format, and RTMP caps the layout", () => {
		const source = sourceMediaAttributes(
			probe([
				{ codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p10le" },
				{ codec_type: "audio", codec_name: "ac3", channels: 6 },
			]),
		);
		const pushed = pushedMediaAttributes(source, transcodeDecision, "RTMP");
		expect(pushed.video?.codec).toBe("h264");
		expect(pushed.video?.pixelFormat).toBe("yuv420p");
		expect(pushed.audio[0]).toEqual({
			codec: "aac",
			sampleRate: 48000,
			channels: 2,
		});
		// SRT carries the layout natively (review-227 I3).
		expect(
			pushedMediaAttributes(source, transcodeDecision, "SRT_CALLER").audio[0]
				?.channels,
		).toBe(6);
	});

	it("transcode-audio leaves the video attributes untouched", () => {
		const source = sourceMediaAttributes(PROBE_REFERENCE_SOURCE);
		const pushed = pushedMediaAttributes(
			source,
			{ mode: "transcode-audio", reasons: ["6ch"] },
			"RTMP",
		);
		expect(pushed.video?.profile).toBe("Main");
		expect(pushed.video?.level).toBe(41);
		expect(pushed.audio[0]?.codec).toBe("aac");
	});
});

describe("compareSourceCompatibility (ledger #239)", () => {
	const reference = sourceMediaAttributes(PROBE_REFERENCE_SOURCE);

	it("the positive control: attribute-for-attribute identical is compatible", () => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes(PROBE_REFERENCE_SOURCE),
			"copy",
		);
		expect(result.compatible).toBe(true);
		expect(result.differences).toEqual([]);
	});

	it("the negative control: the paid A/B's own switch is refused, by name", () => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes(PROBE_INCOMPATIBLE_SOURCE),
			"copy",
		);
		expect(result.compatible).toBe(false);
		expect(
			result.differences.filter((d) => d.blocking).map((d) => d.attribute),
		).toEqual(["resolution", "frame rate", "H.264 profile", "H.264 level"]);
		const text = describeSourceDifferences(result.differences);
		// The four lines Bitmovin's heartbeat itself warned about.
		expect(text).toContain("resolution 1920×1080 → 1920×1012");
		expect(text).toContain("frame rate 30000/1001 → 24/1");
		expect(text).toContain("H.264 profile Main → High");
		expect(text).toContain("H.264 level 41 → 40");
	});

	const copyBlocking: [string, ProbeStream[], string][] = [
		[
			"resolution",
			[{ ...refVideo, width: 1280, height: 720 }, refAudio],
			"resolution 1920×1080 → 1280×720",
		],
		[
			"frame rate",
			[{ ...refVideo, r_frame_rate: "25/1", avg_frame_rate: "25/1" }, refAudio],
			"frame rate 30000/1001 → 25/1",
		],
		[
			"H.264 profile",
			[{ ...refVideo, profile: "High" }, refAudio],
			"H.264 profile Main → High",
		],
		[
			"H.264 level",
			[{ ...refVideo, level: 31 }, refAudio],
			"H.264 level 41 → 31",
		],
		[
			"pixel format",
			[{ ...refVideo, pix_fmt: "yuv422p" }, refAudio],
			"pixel format yuv420p → yuv422p",
		],
		[
			"video codec",
			[{ ...refVideo, codec_name: "hevc" }, refAudio],
			"video codec h264 → hevc",
		],
		[
			"audio codec",
			[refVideo, { ...refAudio, codec_name: "mp3" }],
			"audio codec aac → mp3",
		],
		[
			"audio sample rate",
			[refVideo, { ...refAudio, sample_rate: "44100" }],
			"audio sample rate 48000 Hz → 44100 Hz",
		],
		[
			"audio channels",
			[refVideo, { ...refAudio, channels: 1 }],
			"audio channels 2 → 1",
		],
		["audio streams", [refVideo], "audio streams 1 → 0"],
	];

	it.each(
		copyBlocking,
	)("COPY mode blocks on %s — nothing re-encodes it away", (attribute, streams, line) => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({ streams }),
			"copy",
		);
		expect(result.compatible).toBe(false);
		const hit = result.differences.find((d) => d.attribute === attribute);
		expect(hit?.blocking).toBe(true);
		expect(describeSourceDifferences(result.differences)).toContain(line);
	});

	/** The pins a transcoding push onto THIS reference would actually carry. */
	const transcodePins = normalisationTargets(reference, "transcode", "RTMP");

	it("TRANSCODE mode absorbs size, frame rate, pixel format and audio", () => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({
				streams: [
					{
						...refVideo,
						width: 1280,
						height: 720,
						pix_fmt: "yuv422p",
						r_frame_rate: "25/1",
						avg_frame_rate: "25/1",
					},
					{ ...refAudio, sample_rate: "44100", channels: 1 },
				],
			}),
			"transcode",
			transcodePins,
		);
		expect(result.compatible).toBe(true);
		// Still REPORTED — the operator gets to see that their 720p file is
		// being re-encoded up to the run's 1080p.
		expect(result.differences.map((d) => d.attribute)).toEqual([
			"resolution",
			"frame rate",
			"pixel format",
			"audio sample rate",
			"audio channels",
		]);
		expect(result.differences.every((d) => !d.blocking)).toBe(true);
		expect(describeSourceDifferences(result.differences)).toContain(
			"resolution 1920×1080 → 1280×720 (will be re-encoded to match)",
		);
	});

	it("TRANSCODE mode still blocks on what a transcode cannot make", () => {
		// A source with no video at all: `-c:v libx264` has nothing to encode.
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({ streams: [refAudio] }),
			"transcode",
			transcodePins,
		);
		expect(result.compatible).toBe(false);
		expect(result.differences).toContainEqual({
			attribute: "video stream",
			reference: "present",
			candidate: "absent",
			blocking: true,
		});
	});

	it("TRANSCODE cannot pin a profile it has no x264 token for, so it blocks", () => {
		// A run bound to High 10 (not in the 8-bit 4:2:0 token map): the
		// transcode would silently emit x264's own default profile instead.
		const high10 = sourceMediaAttributes({
			streams: [{ ...refVideo, profile: "High 10" }, refAudio],
		});
		const blocked = compareSourceCompatibility(
			high10,
			sourceMediaAttributes({ streams: [{ ...refVideo, profile: "High" }] }),
			"transcode",
			normalisationTargets(high10, "transcode", "RTMP"),
		);
		expect(
			blocked.differences.find((d) => d.attribute === "H.264 profile")
				?.blocking,
		).toBe(true);
		// …while a Main reference IS pinnable (`-profile:v main`), so the same
		// difference is informational.
		const absorbed = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({ streams: [{ ...refVideo, profile: "High" }] }),
			"transcode",
			transcodePins,
		);
		expect(
			absorbed.differences.find((d) => d.attribute === "H.264 profile")
				?.blocking,
		).toBe(false);
	});

	it("TRANSCODE-AUDIO absorbs audio only — the copied video still blocks", () => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({
				streams: [
					{ ...refVideo, width: 1280, height: 720 },
					{ ...refAudio, channels: 6 },
				],
			}),
			"transcode-audio",
			normalisationTargets(reference, "transcode-audio", "RTMP"),
		);
		expect(result.compatible).toBe(false);
		expect(
			result.differences.find((d) => d.attribute === "resolution")?.blocking,
		).toBe(true);
		expect(
			result.differences.find((d) => d.attribute === "audio channels")
				?.blocking,
		).toBe(false);
	});

	it("does NOT call a difference absorbed that the transcode cannot reach", () => {
		// The false accept the pin-aware rule closes. A run bound to 10-bit
		// 4:2:0: the transcode's `-pix_fmt yuv420p` is a re-encode, but it is
		// a CHANGE against this reference, not a match. Likewise a 6-channel
		// reference over RTMP, where #99's stereo cap makes `-ac 2` the most
		// the push can offer.
		const tenBitSurround: MediaAttributes = {
			video: {
				codec: "h264",
				width: 1920,
				height: 1080,
				frameRate: 25,
				pixelFormat: "yuv420p10le",
			},
			audio: [{ codec: "aac", sampleRate: 48000, channels: 6 }],
		};
		const pins = normalisationTargets(tenBitSurround, "transcode", "RTMP");
		const result = compareSourceCompatibility(
			tenBitSurround,
			// What a transcode actually puts on the wire: 8-bit, stereo.
			pushedMediaAttributes(
				sourceMediaAttributes({
					streams: [
						{ ...refVideo, r_frame_rate: "25/1" },
						{ ...refAudio, channels: 2 },
					],
				}),
				{ mode: "transcode", reasons: ["fixture"] },
				"RTMP",
				pins,
			),
			"transcode",
			pins,
		);
		expect(result.compatible).toBe(false);
		expect(
			result.differences.find((d) => d.attribute === "pixel format")?.blocking,
		).toBe(true);
		expect(
			result.differences.find((d) => d.attribute === "audio channels")
				?.blocking,
		).toBe(true);
	});

	it("blocks BOTH audio-count directions — surplus as well as shortfall", () => {
		// "The number of audio streams must also be the same" reads both ways.
		// A feeder push cannot reach the surplus case (default stream
		// selection caps it at one audio), so the direction that matters here
		// is the SLATE's: a clip carrying a second language track against a
		// single-audio livestream.
		const surplus = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({
				streams: [refVideo, refAudio, { ...refAudio, channels: 6 }],
			}),
			"copy",
		);
		expect(surplus.compatible).toBe(false);
		expect(describeSourceDifferences(surplus.differences)).toContain(
			"audio streams 1 → 2",
		);
		// A reference with NO audio still says nothing — that guard is the
		// one asymmetry, and it is about the instrument, not the rule.
		const silentReference: MediaAttributes = {
			...(reference.video ? { video: reference.video } : {}),
			audio: [],
		};
		expect(
			compareSourceCompatibility(
				silentReference,
				sourceMediaAttributes({ streams: [refVideo, refAudio] }),
				"copy",
			).differences,
		).toEqual([]);
	});

	it("never invents a difference from an attribute one side cannot see", () => {
		// A heartbeat-derived reference knows resolution and nothing else; a
		// gate that read absence as mismatch would refuse every such switch.
		const partial: MediaAttributes = {
			video: { width: 1920, height: 1080 },
			audio: [{ channels: 2 }],
		};
		expect(
			compareSourceCompatibility(partial, reference, "copy").differences,
		).toEqual([]);
	});

	it("treats yuvj420p and yuv420p as the one 8-bit 4:2:0 layout", () => {
		const result = compareSourceCompatibility(
			reference,
			sourceMediaAttributes({
				streams: [{ ...refVideo, pix_fmt: "yuvj420p" }, refAudio],
			}),
			"copy",
		);
		expect(result.differences).toEqual([]);
	});

	it("pins the epsilon's MAGNITUDE — 29.97 vs 30 is a real rate change", () => {
		// Widening FRAME_RATE_EPSILON to 0.5 survived the whole suite, because
		// every other arm differs by whole frames. 29.97 vs 30.00 is the pair
		// that matters: 0.03 apart, indistinguishable to a loose tolerance,
		// and the exact NTSC-vs-integer confusion a mezzanine actually ships.
		const ntsc: MediaAttributes = {
			video: { frameRate: 30000 / 1001, frameRateText: "30000/1001" },
			audio: [],
		};
		const integer: MediaAttributes = {
			video: { frameRate: 30, frameRateText: "30/1" },
			audio: [],
		};
		const blocked = compareSourceCompatibility(ntsc, integer, "copy");
		expect(blocked.compatible).toBe(false);
		expect(describeSourceDifferences(blocked.differences)).toContain(
			"frame rate 30000/1001 → 30/1",
		);
		// And the other side of the boundary: 0.005 apart is the same rate
		// reported twice, which must NOT be a difference.
		const rounded: MediaAttributes = {
			video: { frameRate: 29.975 },
			audio: [],
		};
		expect(
			compareSourceCompatibility(ntsc, rounded, "copy").differences,
		).toEqual([]);
	});

	it("does not refuse a hundredth-of-a-frame rounding difference", () => {
		// The heartbeat rounds 30000/1001 to 29.97; r_frame_rate and
		// avg_frame_rate disagree in the last digits on most real files.
		const rounded: MediaAttributes = {
			video: { frameRate: 29.97 },
			audio: [],
		};
		const exact: MediaAttributes = {
			video: { frameRate: 30000 / 1001 },
			audio: [],
		};
		expect(
			compareSourceCompatibility(rounded, exact, "copy").differences,
		).toEqual([]);
	});
});

describe("normalisationTargets + the argv it produces (ledger #239)", () => {
	const reference = sourceMediaAttributes(PROBE_REFERENCE_SOURCE);

	it("copy pins nothing — `-c copy` cannot honour a pin", () => {
		expect(normalisationTargets(reference, "copy", "RTMP")).toBeUndefined();
	});

	it("transcode pins geometry, rate, profile and audio onto the reference", () => {
		expect(normalisationTargets(reference, "transcode", "RTMP")).toEqual({
			width: 1920,
			height: 1080,
			frameRate: 30000 / 1001,
			sampleRate: 48000,
			channels: 2,
			profile: "main",
		});
	});

	it("transcode-audio pins audio only — the video is copied", () => {
		expect(normalisationTargets(reference, "transcode-audio", "RTMP")).toEqual({
			sampleRate: 48000,
			channels: 2,
		});
	});

	it("#99's FLV stereo cap still wins over a multichannel reference", () => {
		const surround: MediaAttributes = {
			video: { width: 1920, height: 1080 },
			audio: [{ channels: 6, sampleRate: 48000 }],
		};
		expect(normalisationTargets(surround, "transcode", "RTMP")?.channels).toBe(
			2,
		);
		expect(
			normalisationTargets(surround, "transcode", "SRT_CALLER")?.channels,
		).toBe(6);
	});

	it("the transcode command CARRIES the pins — -s, -r, -profile:v, -ar, -ac", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: transcodeDecision,
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
			normalise: {
				width: 1920,
				height: 1080,
				frameRate: 30000 / 1001,
				sampleRate: 44100,
				channels: 2,
				profile: "main",
			},
		});
		const joined = argv.join(" ");
		expect(joined).toContain("-s 1920x1080");
		expect(joined).toContain("-r 29.97");
		expect(joined).toContain("-profile:v main");
		expect(joined).toContain("-ar 44100");
		// Exactly ONE -ac: #99's blanket append must not double the option,
		// because ffmpeg keeps the LAST value per output and the argv would
		// then log two contradicting layouts.
		expect(argv.filter((a) => a === "-ac")).toHaveLength(1);
		expect(joined).not.toContain("-ar 48000");
	});

	it("transcode-audio pins the audio without touching the copied video", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: { mode: "transcode-audio", reasons: ["6ch"] },
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
			normalise: { sampleRate: 44100, channels: 2, width: 640, height: 360 },
		});
		const joined = argv.join(" ");
		expect(joined).toContain("-c:v copy");
		expect(joined).toContain("-ar 44100");
		// The video pins are meaningless under -c:v copy and must not appear.
		expect(joined).not.toContain("-s 640x360");
		expect(joined).not.toContain("-r ");
	});

	it("copy mode ignores a normalisation it cannot honour", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: copyDecision,
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
			normalise: { width: 1920, height: 1080, frameRate: 25 },
		});
		expect(argv).toContain("copy");
		expect(argv).not.toContain("-s");
		expect(argv).not.toContain("-r");
	});

	it("with no reference the argv is byte-identical to the pre-#239 command", () => {
		const { argv } = buildFeederCommand({
			sourcePath: "/spool/s.mp4",
			decision: transcodeDecision,
			target: { protocol: "RTMP", url: "rtmp://h/live", streamKey: "k" },
		});
		expect(argv).toEqual([
			"-hide_banner",
			"-nostdin",
			"-re",
			"-ignore_editlist",
			"1",
			"-stream_loop",
			"-1",
			"-i",
			"/spool/s.mp4",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-tune",
			"zerolatency",
			"-pix_fmt",
			"yuv420p",
			"-g",
			"60",
			"-sc_threshold",
			"0",
			"-b:v",
			"4500k",
			"-maxrate",
			"5000k",
			"-bufsize",
			"10000k",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-progress",
			"pipe:1",
			"-f",
			"flv",
			"rtmp://h/live/k",
		]);
	});
});

describe("heartbeatIngestMedia — the encoder's own word (ledger #239)", () => {
	/**
	 * The REAL persisted shape (owner DB, 116 runs, read for rev406 R1): the
	 * audio stream carries `rate` — its SAMPLE RATE — and `codec` in ffprobe's
	 * lowercase vocabulary, while `numberOfAudioChannels` is null. The block
	 * this replaces was written from an ASSUMED shape (`"VIDEO"`, `"H264"`,
	 * `numberOfAudioChannels: 2`) and pinned the inverted premise that the codec
	 * had to be dropped; on the real shape the reader threw the sample rate
	 * away and a 44.1 kHz clip compared "OK" against a 48 kHz ingest.
	 */
	const sample = {
		at: "2026-09-02T13:40:00.000Z",
		raw: {
			ingest: {
				status: "CONNECTED",
				healthy: true,
				streams: [
					{
						mediaType: "video",
						codec: "h264",
						width: 1280,
						height: 720,
						rate: 30,
						bitrate: 2_500_000,
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
	};

	it("reads resolution, frame rate, codec and the audio SAMPLE RATE off a real sample", () => {
		expect(heartbeatIngestMedia(sample)).toEqual({
			video: { codec: "h264", width: 1280, height: 720, frameRate: 30 },
			audio: [{ codec: "aac", sampleRate: 48000 }],
		});
	});

	it("adopts a codec only when it is ffprobe's own name; anything else is dropped, never mapped", () => {
		// `H264`/`AAC` lowercase to ffprobe's names and are adopted; `H265`
		// is the SDK enum, not ffprobe's `hevc`, and comparing it would refuse
		// every HEVC switch — so it is dropped.
		const enumShaped = {
			raw: {
				ingest: {
					streams: [
						{
							mediaType: "video",
							codec: "H265",
							width: 1920,
							height: 1080,
							rate: 25,
						},
						{ mediaType: "audio", codec: "AAC", rate: 44100 },
					],
				},
			},
		};
		expect(heartbeatIngestMedia(enumShaped)).toEqual({
			video: { width: 1920, height: 1080, frameRate: 25 },
			audio: [{ codec: "aac", sampleRate: 44100 }],
		});
	});

	it("derives the channel count from audioChannelFormat when numberOfAudioChannels is null", () => {
		const stereo = {
			raw: {
				ingest: {
					streams: [
						{
							mediaType: "audio",
							codec: "aac",
							rate: 48000,
							numberOfAudioChannels: null,
							audioChannelFormat: "stereo",
						},
					],
				},
			},
		};
		expect(heartbeatIngestMedia(stereo)).toEqual({
			audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
		});
	});

	it("keeps an untyped audio stream — a rate of 48000 is a sample rate, not a frame rate", () => {
		const untyped = {
			raw: {
				ingest: {
					streams: [
						{ width: 1280, height: 720, rate: 30 },
						{ codec: "aac", rate: 48000 },
					],
				},
			},
		};
		expect(heartbeatIngestMedia(untyped)).toEqual({
			video: { width: 1280, height: 720, frameRate: 30 },
			audio: [{ codec: "aac", sampleRate: 48000 }],
		});
	});

	it("answers null for every shape that proves nothing", () => {
		expect(heartbeatIngestMedia(null)).toBeNull();
		expect(heartbeatIngestMedia({})).toBeNull();
		// The persisted column is the WRAPPER; a flat sample is the shape
		// review-224 C1 caught nobody ever writes.
		expect(heartbeatIngestMedia({ ingest: sample.raw.ingest })).toBeNull();
		expect(
			heartbeatIngestMedia({ at: "x", raw: { ingest: { streams: [] } } }),
		).toBeNull();
		expect(
			heartbeatIngestMedia({
				at: "x",
				raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			}),
		).toBeNull();
	});
});

describe("parseMediaAttributes — reading the persisted reference back", () => {
	it("round-trips what the recorder writes", () => {
		const attrs = pushedMediaAttributes(
			sourceMediaAttributes(PROBE_REFERENCE_SOURCE),
			copyDecision,
			"RTMP",
		);
		expect(parseMediaAttributes(JSON.parse(JSON.stringify(attrs)))).toEqual(
			attrs,
		);
	});

	it("degrades to no-reference rather than comparing against garbage", () => {
		expect(parseMediaAttributes(null)).toBeNull();
		expect(parseMediaAttributes("{}")).toBeNull();
		expect(parseMediaAttributes({ video: { width: 1920 } })).toBeNull();
		expect(parseMediaAttributes({ audio: [] })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
//  (PR-C): the normalized loop
// ---------------------------------------------------------------------------

describe("buildNormalizeCommand", () => {
	it("trims the container to the video span, conforms to the loop fps from pts 0, cuts the audio on the AAC grid inside the video, and encodes with the push transcode's own codecs", () => {
		const argv = buildNormalizeCommand({
			sourcePath: "/spool/s.mp4",
			destPath: "/spool/s.loop.mp4",
			fps: 30,
			protocol: "RTMP",
			videoStartSec: 1.0,
			videoDurationSec: 271 / 30,
		});
		expect(argv.slice(0, 11)).toEqual([
			"-hide_banner",
			"-nostdin",
			"-v",
			"error",
			"-y",
			"-ss",
			"1.000000",
			"-i",
			"/spool/s.mp4",
			"-t",
			"9.033333",
		]);
		expect(argv[argv.indexOf("-vf") + 1]).toBe("fps=30,setpts=N/FRAME_RATE/TB");
		// 271/30 s at 48 kHz = 423.4375 AAC frames → 422 whole frames of content
		// (432,128 samples: the encoder's delay frame takes the 423rd slot) after
		// the 1,024-sample pre-trim; no `-shortest`, the audio end is chosen,
		// not raced against the video's.
		expect(argv[argv.indexOf("-af") + 1]).toBe(
			"aresample=async=1:first_pts=0,apad,atrim=start_sample=1024:end_sample=433152,asetpts=PTS-STARTPTS",
		);
		expect(argv).not.toContain("-shortest");
		expect(argv.slice(argv.indexOf("-c:v"), argv.indexOf("-c:v") + 4)).toEqual([
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
		]);
		expect(argv).toContain("aac");
		// RTMP without a reference: the push's stereo pin rides along
		expect(argv.slice(argv.indexOf("-ac"), argv.indexOf("-ac") + 2)).toEqual([
			"-ac",
			"2",
		]);
		expect(argv.slice(-5)).toEqual([
			"-movflags",
			"+faststart",
			"-f",
			"mp4",
			"/spool/s.loop.mp4",
		]);
	});

	it("carries the reference geometry/rate/profile and channel count when a normalisation target exists (ledger #239)", () => {
		const argv = buildNormalizeCommand({
			sourcePath: "/spool/s.mp4",
			destPath: "/spool/s.loop.mp4",
			fps: 29.97,
			protocol: "SRT_CALLER",
			normalise: {
				width: 1280,
				height: 720,
				frameRate: 29.97,
				profile: "main",
				sampleRate: 48000,
				channels: 6,
			},
			videoStartSec: 0,
			videoDurationSec: 10,
		});
		expect(argv[argv.indexOf("-vf") + 1]).toBe(
			"fps=29.97,setpts=N/FRAME_RATE/TB",
		);
		expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2)).toEqual([
			"-s",
			"1280x720",
		]);
		expect(argv.slice(argv.indexOf("-ac"), argv.indexOf("-ac") + 2)).toEqual([
			"-ac",
			"6",
		]);
		expect(argv.filter((a) => a === "-ac")).toHaveLength(1);
		expect(normalizedSpoolPath("/spool/", "abc")).toBe("/spool/abc.loop.mp4");
	});
});

describe("loopProfileFromProbe", () => {
	const probe = (
		over: {
			videoStart?: string;
			audioStart?: string;
			audioDuration?: string;
			nbFrames?: string;
			formatStart?: string;
			noAudio?: boolean;
		} = {},
	) => ({
		format: {
			duration: "9.033333",
			start_time: over.formatStart ?? "0.000000",
		},
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				start_time: over.videoStart ?? "0.000000",
				duration: "9.033333",
				nb_frames: over.nbFrames ?? "271",
				r_frame_rate: "30/1",
			},
			...(over.noAudio
				? []
				: [
						{
							codec_type: "audio",
							codec_name: "aac",
							start_time: over.audioStart ?? "0.000000",
							duration: over.audioDuration ?? "9.024000",
						},
					]),
		],
	});
	const sha = "b".repeat(64);
	const at = "2026-09-07T00:00:00.000Z";

	it("reads F from the video frame count, D = F / fps, and the audio end within a frame of D", () => {
		expect(loopProfileFromProbe(probe(), 30, sha, at)).toEqual({
			version: 1,
			mode: "normalized",
			fps: 30,
			frames: 271,
			loopSeconds: 271 / 30,
			audioEndSec: 9.024,
			sourceSha256: sha,
			normalizer: { version: 1 },
			recordedAt: at,
		});
		// an audio-less loop ends where the video does
		expect(
			loopProfileFromProbe(probe({ noAudio: true }), 30, sha, at).audioEndSec,
		).toBeCloseTo(271 / 30, 6);
		// container start is subtracted (an MPEG-TS-shaped intermediate)
		expect(
			loopProfileFromProbe(
				probe({
					formatStart: "1.400000",
					videoStart: "1.400000",
					audioStart: "1.400000",
				}),
				30,
				sha,
				at,
			).frames,
		).toBe(271);
	});

	it("refuses a loop the VMAF side could not model exactly", () => {
		expect(() =>
			loopProfileFromProbe(probe({ videoStart: "0.500000" }), 30, sha, at),
		).toThrow(/video starts at 0.5000 s/);
		expect(() =>
			loopProfileFromProbe(probe({ audioStart: "0.040000" }), 30, sha, at),
		).toThrow(/audio starts at 0.0400 s/);
		expect(() =>
			loopProfileFromProbe(probe({ audioDuration: "9.100000" }), 30, sha, at),
		).toThrow(/audio ends at 9.1000 s/);
		expect(() =>
			loopProfileFromProbe(probe({ nbFrames: "0" }), 30, sha, at),
		).toThrow(/no video frame count/);
		expect(() => loopProfileFromProbe({ streams: [] }, 30, sha, at)).toThrow(
			/no video stream/,
		);
	});
});

describe("normalizedAudioSamples (row #256)", () => {
	it("keeps whole AAC frames whose packets all start inside the video span, never more than two frames short", () => {
		for (const [seconds, rate] of [
			[9, 48_000],
			[9, 44_100],
			[271 / 30, 48_000],
			[0.5, 48_000],
			[3600.4, 48_000],
		] as const) {
			const samples = normalizedAudioSamples(seconds, rate);
			expect(samples % AAC_FRAME_SAMPLES).toBe(0);
			// the delay frame plus the content packets END at (samples + 1024) / rate,
			// which must not pass the video end and stays within one frame of it
			const packetEnd = (samples + AAC_FRAME_SAMPLES) / rate;
			expect(packetEnd).toBeLessThanOrEqual(seconds);
			expect(seconds - packetEnd).toBeLessThan(AAC_FRAME_SAMPLES / rate);
		}
		expect(normalizedAudioSamples(9, 48_000)).toBe(420 * 1024);
		expect(normalizedAudioSamples(9, 44_100)).toBe(386 * 1024);
		expect(normalizedAudioSamples(0.01, 48_000)).toBe(0);
	});
});

describe("loopProfileFromProbe audio-end tolerance (row #256)", () => {
	const probeWith = (audioDuration: string, sampleRate = "48000") => ({
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				start_time: "0.000000",
				duration: "9.000000",
				nb_frames: "270",
				r_frame_rate: "30/1",
				avg_frame_rate: "30/1",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				start_time: "0.000000",
				duration: audioDuration,
				sample_rate: sampleRate,
			},
		],
		format: { start_time: "0.000000", duration: "9.000000" },
	});
	const read = (audioDuration: string, sampleRate?: string) =>
		loopProfileFromProbe(
			probeWith(audioDuration, sampleRate),
			30,
			"a".repeat(64),
			"2026-09-07T00:00:00.000Z",
		);
	it("accepts the normalizer's audio: one AAC frame early", () => {
		expect(read("8.981333").audioEndSec).toBeCloseTo(8.981333, 5);
	});
	it("refuses audio that ends a video frame late — it would stretch the copy-loop", () => {
		expect(() => read("9.040000")).toThrow(/audio ends at 9.0400 s/);
	});
	it("refuses audio more than two AAC frames plus a video frame early", () => {
		expect(() => read("8.900000")).toThrow(/audio ends at 8.9000 s/);
	});
	it("scales the early tolerance with the audio's own sample rate", () => {
		// 44.1 kHz: two frames = 46.4 ms, plus 1/30 → 79.8 ms; 8.93 is 70 ms early
		expect(read("8.930000", "44100").audioEndSec).toBeCloseTo(8.93, 5);
		expect(() => read("8.910000", "44100")).toThrow(/audio ends/);
	});
});
