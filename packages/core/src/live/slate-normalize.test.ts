import { describe, expect, it } from "vitest";
import type { MediaAttributes, ProbeResult } from "./media-attributes";
import {
	buildSlateNormalizeArgs,
	decideSlatePreparation,
	SLATE_ASSUMED_CHANNELS,
	slateConversionDestination,
	slateDestinationKey,
	slateNormalizationTarget,
	slateNormalizedKey,
	slateProbeFacts,
} from "./slate-normalize";

/** The heartbeat-derived reference of the measured runs: no channel count. */
const INGEST: MediaAttributes = {
	video: { codec: "h264", width: 1280, height: 720, frameRate: 30 },
	audio: [{ codec: "aac", sampleRate: 48000 }],
};

function movie(over: {
	format?: string;
	video?: Record<string, unknown>;
	audio?: Record<string, unknown>[] | null;
	audioFirst?: boolean;
}): ProbeResult {
	const video = {
		codec_type: "video",
		codec_name: "h264",
		width: 1280,
		height: 720,
		r_frame_rate: "30/1",
		avg_frame_rate: "30/1",
		pix_fmt: "yuv420p",
		...over.video,
	};
	const audio = (
		over.audio === null
			? []
			: (over.audio ?? [{}]).map((a) => ({
					codec_type: "audio",
					codec_name: "aac",
					sample_rate: "48000",
					channels: 2,
					...a,
				}))
	) as ProbeResult["streams"];
	return {
		streams: over.audioFirst
			? [...(audio ?? []), video]
			: [video, ...(audio ?? [])],
		format: { format_name: over.format ?? "mpegts" },
	} as ProbeResult;
}

const TARGET = {
	width: 1280,
	height: 720,
	frameRate: 30,
	sampleRate: 48000,
	channels: 2,
	channelsAssumed: true,
};

describe("slateNormalizationTarget", () => {
	it("reads geometry, frame rate and sample rate off the reference and assumes stereo when the heartbeat has no channel count", () => {
		expect(slateNormalizationTarget(INGEST)).toEqual({ target: TARGET });
		expect(SLATE_ASSUMED_CHANNELS).toBe(2);
	});

	it("keeps a measured channel count", () => {
		const resolved = slateNormalizationTarget({
			...INGEST,
			audio: [{ codec: "aac", sampleRate: 44100, channels: 1 }],
		});
		expect(resolved.target).toMatchObject({
			sampleRate: 44100,
			channels: 1,
			channelsAssumed: false,
		});
	});

	it("names what a thin reference lacks", () => {
		expect(slateNormalizationTarget(null)).toEqual({
			target: null,
			missing: ["ingest reference"],
		});
		expect(
			slateNormalizationTarget({ video: { codec: "h264" }, audio: [] }),
		).toEqual({
			target: null,
			missing: ["resolution", "frame rate", "audio sample rate"],
		});
	});
});

describe("decideSlatePreparation", () => {
	it("registers a still image as it is, with or without a reference", () => {
		const png: ProbeResult = {
			streams: [{ codec_type: "video", codec_name: "png", width: 500 }],
			format: { format_name: "png_pipe" },
		};
		expect(decideSlatePreparation(png, INGEST)).toEqual({
			action: "REGISTER_AS_IS",
			reason: "IMAGE",
		});
		expect(decideSlatePreparation(png, null)).toEqual({
			action: "REGISTER_AS_IS",
			reason: "IMAGE",
		});
	});

	it("registers an MPEG-TS that matches the ingest as it is", () => {
		expect(decideSlatePreparation(movie({}), INGEST)).toEqual({
			action: "REGISTER_AS_IS",
			reason: "MATCHES_INGEST",
		});
	});

	it("normalizes a matching MP4 — its audio plays at half speed as it is", () => {
		expect(
			decideSlatePreparation(
				movie({ format: "mov,mp4,m4a,3gp,3g2,mj2" }),
				INGEST,
			),
		).toEqual({ action: "NORMALIZE", target: TARGET, reasons: ["container"] });
	});

	it("normalizes an MPEG-TS whose attributes differ, naming each difference once", () => {
		const off = movie({
			video: { width: 1282, r_frame_rate: "25/1", avg_frame_rate: "25/1" },
			audio: [{ sample_rate: "44100", channels: 1 }],
		});
		const decision = decideSlatePreparation(off, INGEST);
		expect(decision.action).toBe("NORMALIZE");
		if (decision.action !== "NORMALIZE") {
			return;
		}
		expect(decision.reasons).toEqual([
			"resolution",
			"frame rate",
			"audio sample rate",
			"audio channels",
		]);
	});

	it("catches what the heartbeat reference cannot see: mono, yuv422p, a second audio stream, audio at position 0", () => {
		expect(
			decideSlatePreparation(movie({ audio: [{ channels: 1 }] }), INGEST),
		).toMatchObject({ action: "NORMALIZE", reasons: ["audio channels"] });
		expect(
			decideSlatePreparation(movie({ video: { pix_fmt: "yuv422p" } }), INGEST),
		).toMatchObject({ action: "NORMALIZE", reasons: ["pixel format"] });
		expect(
			decideSlatePreparation(movie({ audio: [{}, {}] }), INGEST),
		).toMatchObject({ action: "NORMALIZE", reasons: ["audio streams"] });
		expect(
			decideSlatePreparation(movie({ audioFirst: true }), INGEST),
		).toMatchObject({
			action: "NORMALIZE",
			reasons: ["video stream position"],
		});
	});

	it("holds frame rates to FRAME_RATE_EPSILON: NTSC vs integer normalizes, NTSC vs its 2-decimal print does not", () => {
		const ntsc = movie({
			video: { r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001" },
		});
		expect(decideSlatePreparation(ntsc, INGEST)).toMatchObject({
			action: "NORMALIZE",
			reasons: ["frame rate"],
		});
		expect(
			decideSlatePreparation(movie({}), {
				...INGEST,
				video: { ...INGEST.video, frameRate: 29.97 },
			}),
		).toMatchObject({ action: "NORMALIZE", reasons: ["frame rate"] });
		expect(
			decideSlatePreparation(ntsc, {
				...INGEST,
				video: { ...INGEST.video, frameRate: 29.97 },
			}),
		).toEqual({ action: "REGISTER_AS_IS", reason: "MATCHES_INGEST" });
	});

	it("treats yuvj420p as yuv420p", () => {
		expect(
			decideSlatePreparation(movie({ video: { pix_fmt: "yuvj420p" } }), INGEST),
		).toEqual({ action: "REGISTER_AS_IS", reason: "MATCHES_INGEST" });
	});

	it("normalizes a clip with no audio (silence is synthesised) and an MKV", () => {
		expect(
			decideSlatePreparation(movie({ audio: null }), INGEST),
		).toMatchObject({ action: "NORMALIZE", reasons: ["audio streams"] });
		expect(
			decideSlatePreparation(movie({ format: "matroska,webm" }), INGEST),
		).toMatchObject({ action: "NORMALIZE", reasons: ["container"] });
	});

	it("waits for the input when a movie has no reference to be matched to", () => {
		expect(decideSlatePreparation(movie({}), null)).toEqual({
			action: "WAIT_FOR_INPUT",
			missing: ["ingest reference"],
		});
		expect(
			decideSlatePreparation(movie({}), {
				video: { width: 1280, height: 720 },
				audio: [],
			}),
		).toEqual({
			action: "WAIT_FOR_INPUT",
			missing: ["frame rate", "audio sample rate"],
		});
	});

	it("refuses only what cannot be normalized: no probe, no container, no video", () => {
		expect(decideSlatePreparation(null, INGEST).action).toBe("REFUSE");
		expect(
			decideSlatePreparation({ streams: movie({}).streams }, INGEST).action,
		).toBe("REFUSE");
		const audioOnly: ProbeResult = {
			streams: [{ codec_type: "audio", codec_name: "aac" }],
			format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
		};
		expect(decideSlatePreparation(audioOnly, INGEST)).toMatchObject({
			action: "REFUSE",
		});
	});
});

describe("slateNormalizedKey", () => {
	it("sits next to the source, names the target, and never nests its own marker", () => {
		const key = slateNormalizedKey("slates/brb.mp4", TARGET);
		expect(key).toBe("slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts");
		expect(slateNormalizedKey(key, TARGET)).toBe(key);
		expect(slateNormalizedKey("brb", TARGET)).toBe(
			"brb.normalized-1280x720-30-48000-2ch.ts",
		);
		// Two clips that share a stem keep separate outputs.
		expect(slateNormalizedKey("slates/brb.mov", TARGET)).not.toBe(key);
		expect(
			slateNormalizedKey("a/b.mov", { ...TARGET, frameRate: 30000 / 1001 }),
		).toBe("a/b.mov.normalized-1280x720-30000_1001-48000-2ch.ts");
	});
});

describe("buildSlateNormalizeArgs", () => {
	const base = {
		sourcePath: "/tmp/in.mp4",
		destPath: "/tmp/out.ts",
		target: TARGET,
		hasAudio: true,
		interlaced: false,
	};

	it("pins every measured requirement: geometry fit, CFR at the ingest rate, yuv420p, closed 2 s GOP, AAC at rate/channels, MPEG-TS", () => {
		const argv = buildSlateNormalizeArgs(base);
		const joined = argv.join(" ");
		expect(argv.slice(-3)).toEqual(["-f", "mpegts", "/tmp/out.ts"]);
		expect(joined).toContain("-map 0:V:0 -map 0:a:0");
		expect(joined).toContain(
			"-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p",
		);
		expect(joined).toContain("-c:v libx264");
		expect(joined).toContain("-pix_fmt yuv420p");
		expect(joined).toContain(
			"-g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop",
		);
		expect(joined).toContain("-c:a aac -ar 48000 -ac 2");
		expect(argv).not.toContain("-shortest");
		expect(argv).not.toContain("lavfi");
	});

	it("synthesises silence for a clip with no audio and cuts it at the video's end", () => {
		const argv = buildSlateNormalizeArgs({ ...base, hasAudio: false });
		const joined = argv.join(" ");
		expect(joined).toContain("-f lavfi -i anullsrc=r=48000:cl=stereo");
		expect(joined).toContain("-map 0:V:0 -map 1:a:0");
		expect(argv).toContain("-shortest");
	});

	it("deinterlaces frame-for-frame and keeps NTSC rates exact", () => {
		const argv = buildSlateNormalizeArgs({
			...base,
			interlaced: true,
			target: { ...TARGET, frameRate: 30000 / 1001, channels: 1 },
		});
		const joined = argv.join(" ");
		expect(joined).toContain("-vf yadif=mode=send_frame,scale=");
		expect(joined).toContain("fps=30000/1001");
		expect(joined).toContain("-ac 1");
	});
});

describe("slateProbeFacts", () => {
	it("reads audio presence and interlacing, ignoring cover art", () => {
		expect(slateProbeFacts(movie({ audio: null }))).toEqual({
			hasVideo: true,
			hasAudio: false,
			interlaced: false,
		});
		expect(
			slateProbeFacts(movie({ video: { field_order: "tt" } })).interlaced,
		).toBe(true);
		expect(
			slateProbeFacts({
				streams: [
					{
						codec_type: "video",
						codec_name: "mjpeg",
						disposition: { attached_pic: 1 },
					},
					{ codec_type: "audio" },
				],
			}).hasVideo,
		).toBe(false);
	});
});

describe("slateConversionDestination", () => {
	const S3 = {
		key: "archive-s3",
		kind: "S3",
		credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
		bucket: "ap-northeast-1-output",
	};

	it("picks the first S3-family output and the directory its muxings and manifests share", () => {
		const plan = {
			outputs: [S3],
			muxings: [
				{ destination: { outputKey: "archive-s3", path: "chan-1/video/720p" } },
				{ destination: { outputKey: "archive-s3", path: "chan-1/video/540p" } },
			],
			liveManifests: [
				{ destination: { outputKey: "archive-s3", path: "chan-1/output" } },
			],
		};
		expect(slateConversionDestination(plan)).toEqual({
			credentialId: S3.credentialId,
			bucket: S3.bucket,
			keyPrefix: "chan-1/slates",
			outputKey: "archive-s3",
		});
	});

	it("ignores paths on other outputs and falls back to the bucket root", () => {
		const plan = {
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					credentialId: "x",
					mslVersion: "MSL4",
				},
				{ ...S3, key: "mirror", kind: "GENERIC_S3" },
			],
			muxings: [
				{ destination: { outputKey: "origin", path: "qa/chan/video/720p" } },
				{ destination: { outputKey: "mirror", path: "/qa/chan/archive/" } },
			],
			liveManifests: [{ destination: { outputKey: "origin", path: "" } }],
		};
		expect(slateConversionDestination(plan)).toMatchObject({
			bucket: S3.bucket,
			keyPrefix: "qa/chan/archive/slates",
			outputKey: "mirror",
		});
		expect(
			slateConversionDestination({
				outputs: [S3],
				muxings: [],
				liveManifests: [],
			}),
		).toMatchObject({ keyPrefix: "slates" });
	});

	it("is null for an MSL-only plan, a non-object, or an output without a bucket", () => {
		expect(
			slateConversionDestination({
				outputs: [{ key: "origin", kind: "AKAMAI_MSL", credentialId: "x" }],
			}),
		).toBeNull();
		expect(slateConversionDestination(null)).toBeNull();
		expect(
			slateConversionDestination({
				outputs: [{ key: "a", kind: "S3", credentialId: "c" }],
			}),
		).toBeNull();
	});

	it("keys the destination by source bucket AND key, so same-named sources never collide", () => {
		const destination = {
			credentialId: S3.credentialId,
			bucket: S3.bucket,
			keyPrefix: "chan-1/slates",
			outputKey: "archive-s3",
		};
		const a = slateDestinationKey(
			destination,
			{ bucket: "in", key: "brand-a/brb.mp4" },
			TARGET,
		);
		expect(a).toBe(
			"chan-1/slates/in/brand-a/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
		);
		expect(
			slateDestinationKey(
				destination,
				{ bucket: "in", key: "brand-b/brb.mp4" },
				TARGET,
			),
		).not.toBe(a);
		expect(
			slateDestinationKey(
				destination,
				{ bucket: "other", key: "brand-a/brb.mp4" },
				TARGET,
			),
		).not.toBe(a);
		// Converting the same source again for the same ingest overwrites its own output.
		expect(
			slateDestinationKey(
				destination,
				{ bucket: "in", key: "/brand-a/brb.mp4" },
				TARGET,
			),
		).toBe(a);
	});

	it("a delivery mirror takes the primary's paths; a root-level destination pins the root", () => {
		const mirrored = {
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					credentialId: "x",
					mslVersion: "MSL4",
				},
				{ ...S3, key: "mirror", kind: "GENERIC_S3" },
			],
			deliveryMirrors: [{ outputKey: "mirror" }],
			muxings: [
				{ destination: { outputKey: "origin", path: "qa/chan/video/720p" } },
				{ destination: { outputKey: "origin", path: "qa/chan/video/360p" } },
			],
			liveManifests: [
				{ destination: { outputKey: "origin", path: "qa/chan" } },
			],
		};
		expect(slateConversionDestination(mirrored)).toMatchObject({
			outputKey: "mirror",
			keyPrefix: "qa/chan/slates",
		});
		const rooted = {
			outputs: [S3],
			muxings: [
				{ destination: { outputKey: "archive-s3", path: "chan/video/720p" } },
			],
			liveManifests: [{ destination: { outputKey: "archive-s3", path: "" } }],
		};
		expect(slateConversionDestination(rooted)).toMatchObject({
			keyPrefix: "slates",
		});
	});
});
