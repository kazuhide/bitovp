import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planHasErrors } from "../plan/validate";
import { compileLiveChannel, liveHlsEntryUris } from "./compiler";
import type { LiveChannelPlan } from "./schema";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

/**
 * Rail tests run both directions: the coherent base plan yields zero
 * issues, each mutation fires exactly its rail. Schema-invalid states are
 * built by mutating PARSED plans — that is the validator's reason to
 * duplicate the cross-field schema refines (TS-constructed plans).
 */

function basePlan(): LiveChannelPlan {
	return liveChannelPlanSchema.parse({
		planVersion: 1,
		name: "test channel",
		bitmovin: {},
		liveInput: { key: "main", kind: "RTMP" },
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "b",
			},
		],
		ingest: [
			{ key: "video", position: 0 },
			{ key: "audio", position: 1 },
		],
		renditions: [
			{
				key: "v720",
				codec: "H264",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				presetConfiguration: "LIVE_STANDARD",
			},
			{
				key: "a128",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128000,
				rate: 48000,
			},
		],
		muxings: [
			{
				key: "v720",
				kind: "FMP4",
				streamKey: "v720",
				destination: { outputKey: "out", path: "live/video/720p" },
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				destination: { outputKey: "out", path: "live/audio/128000" },
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				destination: { outputKey: "out", path: "live" },
				timeshift: 7200,
			},
		],
		start: { streamKey: "myStreamKey" },
	});
}

function srtPlan(): LiveChannelPlan {
	const plan = basePlan();
	plan.liveInput = {
		key: "main",
		kind: "SRT",
		name: "SRT Input",
		mode: "CALLER",
		host: "203.0.113.10",
		port: 7000,
	};
	return plan;
}

function codes(plan: LiveChannelPlan): string[] {
	return validateLiveChannel(plan).map((i) => i.code);
}

describe("validateLiveChannel", () => {
	it("passes a coherent plan with zero issues", () => {
		expect(validateLiveChannel(basePlan())).toEqual([]);
	});

	describe("SRT rails (validator duplicates of the schema refines)", () => {
		it("SRT_CALLER_NEEDS_HOST fires when a CALLER loses its host", () => {
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.host = undefined;
			const issues = validateLiveChannel(plan);
			expect(issues.map((i) => i.code)).toContain("SRT_CALLER_NEEDS_HOST");
			expect(issues.find((i) => i.code === "SRT_CALLER_NEEDS_HOST")?.path).toBe(
				"liveInput.host",
			);
		});

		it("SRT_LISTENER_PORT fires outside 2088-2091", () => {
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.mode = "LISTENER";
			plan.liveInput.host = undefined;
			plan.liveInput.port = 9000;
			expect(codes(plan)).toContain("SRT_LISTENER_PORT");
		});

		it("SRT_LISTENER_PORT covers backup connections too", () => {
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.backup = {
				srtInputs: [{ mode: "LISTENER", port: 5000 }],
			};
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "SRT_LISTENER_PORT",
			);
			expect(issue?.path).toBe("liveInput.backup.srtInputs[0].port");
		});

		it("does not fire on a valid LISTENER", () => {
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.mode = "LISTENER";
			plan.liveInput.host = undefined;
			plan.liveInput.port = 2088;
			expect(validateLiveChannel(plan)).toEqual([]);
		});

		it("SRT_LISTENER_HOST_FORBIDDEN on a TS-constructed LISTENER with host", () => {
			// host is a CALLER-only SDK field — a LISTENER host is silently
			// dead wire data; the schema refine is duplicated here for plans
			// built in TS without parsing.
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.mode = "LISTENER";
			plan.liveInput.port = 2088; // host stays set from srtPlan
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "SRT_LISTENER_HOST_FORBIDDEN",
			);
			expect(issue?.level).toBe("error");
			expect(issue?.path).toBe("liveInput.host");
		});

		it("SRT_LISTENER_HOST_FORBIDDEN covers backup connections too", () => {
			const plan = srtPlan();
			if (plan.liveInput.kind !== "SRT") throw new Error("not srt");
			plan.liveInput.backup = {
				srtInputs: [{ mode: "LISTENER", host: "203.0.113.20", port: 2089 }],
			};
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "SRT_LISTENER_HOST_FORBIDDEN",
			);
			expect(issue?.path).toBe("liveInput.backup.srtInputs[0].host");
		});
	});

	describe("REDUNDANT_RTMP_INGEST_XOR", () => {
		function redundantPlan(): LiveChannelPlan {
			const plan = basePlan();
			plan.liveInput = {
				key: "main",
				kind: "REDUNDANT_RTMP",
				name: "Redundant RTMP Input",
				ingestPoints: [{ applicationName: "liveA", streamKey: "feedA" }],
			};
			return plan;
		}

		it("passes with exactly one ingest-point list", () => {
			expect(validateLiveChannel(redundantPlan())).toEqual([]);
		});

		it("fires when both lists are set", () => {
			const plan = redundantPlan();
			if (plan.liveInput.kind !== "REDUNDANT_RTMP") throw new Error("kind");
			plan.liveInput.staticIngestPoints = [{ name: "static-a" }];
			expect(codes(plan)).toContain("REDUNDANT_RTMP_INGEST_XOR");
		});

		it("fires when neither list is set", () => {
			const plan = redundantPlan();
			if (plan.liveInput.kind !== "REDUNDANT_RTMP") throw new Error("kind");
			plan.liveInput.ingestPoints = undefined;
			expect(codes(plan)).toContain("REDUNDANT_RTMP_INGEST_XOR");
		});
	});

	describe("deliveryMirrors rails (Live excludes each destination's self mirror)", () => {
		const withMirror = (mirrorKey: string) => {
			const plan = basePlan();
			plan.outputs.push({
				key: "msl",
				kind: "AKAMAI_MSL",
				credentialId: "00000000-0000-4000-8000-000000000004",
				streamFormat: "CMAF",
				mslVersion: "MSL4",
			} as (typeof plan.outputs)[number]);
			(plan as { deliveryMirrors?: { outputKey: string }[] }).deliveryMirrors =
				[{ outputKey: mirrorKey }];
			return plan;
		};

		it("accepts a resolvable mirror", () => {
			const issues = validateLiveChannel(withMirror("msl")).filter(
				(i) => i.level === "error" && i.path.startsWith("deliveryMirrors"),
			);
			expect(issues).toEqual([]);
		});

		it("rejects an unknown mirror key", () => {
			const issues = validateLiveChannel(withMirror("ghost"));
			expect(
				issues.some(
					(i) =>
						i.code === "PLAN_UNRESOLVED_REF" &&
						i.path === "deliveryMirrors.0.outputKey",
				),
			).toBe(true);
		});

		it("rejects the same mirror twice", () => {
			const plan = withMirror("msl");
			(
				plan as unknown as { deliveryMirrors: { outputKey: string }[] }
			).deliveryMirrors.push({ outputKey: "msl" });
			const issues = validateLiveChannel(plan);
			expect(
				issues.some(
					(i) =>
						i.code === "PLAN_DUPLICATE_KEY" &&
						i.path === "deliveryMirrors.1.outputKey",
				),
			).toBe(true);
		});

		it("accepts a destination's own output because the compiler excludes its self mirror", () => {
			const plan = basePlan();
			(plan as { deliveryMirrors?: { outputKey: string }[] }).deliveryMirrors =
				[{ outputKey: "out" }];
			const issues = validateLiveChannel(plan);
			expect(
				issues.some(
					(i) =>
						i.code === "PLAN_DUPLICATE_KEY" &&
						i.path === "muxings.0.destination.outputKey",
				),
			).toBe(false);
		});
	});

	describe("structural rails", () => {
		it("LIVE_DUPLICATE_KEY on repeated keys", () => {
			const plan = basePlan();
			const out = plan.outputs.at(0);
			if (!out) throw new Error("missing output");
			plan.outputs.push({ ...out });
			expect(codes(plan)).toContain("LIVE_DUPLICATE_KEY");
		});

		it("LIVE_UNRESOLVED_REF with paths for every reference family", () => {
			const plan = basePlan();
			const rendition = plan.renditions.at(0);
			const muxing = plan.muxings.at(0);
			const manifest = plan.liveManifests.at(0);
			if (!rendition || !muxing || !manifest) throw new Error("missing");
			rendition.ingestKey = "nope";
			muxing.streamKey = "ghost";
			if (muxing.destination) muxing.destination.outputKey = "void";
			manifest.destination.outputKey = "void";
			const issues = validateLiveChannel(plan);
			const refIssues = issues.filter((i) => i.code === "LIVE_UNRESOLVED_REF");
			expect(refIssues.map((i) => i.path)).toEqual(
				expect.arrayContaining([
					"renditions[0].ingestKey",
					"muxings[0].streamKey",
					"muxings[0].destination.outputKey",
					"liveManifests[0].destination.outputKey",
				]),
			);
			expect(planHasErrors(issues)).toBe(true);
		});

		/**
		 * THE THREE LIVE CONTAINER RAILS — pinned by nothing until review.
		 *
		 * I wrote them as twins of the VOD ones, pinned the VOD side, and left
		 * these unmeasured. All three SURVIVED a reviewer's mutation with the
		 * whole 2,654-test core suite green, and a second instrument agreed:
		 * each code appeared exactly ONCE in the repo — at its own definition.
		 * `LIVE_MUXING_VIDEO_NOT_PRIMARY` is the live half of the invariant
		 * four readers' correctness depends on .
		 */
		it("LIVE_MUXING_DUPLICATE_STREAM when a container lists one rendition twice", () => {
			const plan = basePlan();
			const muxing = plan.muxings.at(0);
			if (!muxing) throw new Error("missing muxing");
			// TS, because `additionalStreamKeys` lives on the TS schema — an
			// fMP4 literal carrying it does not type-check, which is the schema
			// telling the test the truth.
			plan.muxings[0] = {
				key: muxing.key,
				kind: "TS",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "seg_%number%.ts",
				additionalStreamKeys: ["v720"],
				destination: muxing.destination,
			} as (typeof plan.muxings)[number];
			expect(codes(plan)).toContain("LIVE_MUXING_DUPLICATE_STREAM");
		});

		it("LIVE_MUXING_VIDEO_NOT_PRIMARY when the picture hides behind an audio primary", () => {
			const plan = basePlan();
			const audioMux = plan.muxings.at(1);
			if (!audioMux) throw new Error("missing audio muxing");
			plan.muxings[1] = {
				...audioMux,
				kind: "TS",
				additionalStreamKeys: ["v720"],
			} as (typeof plan.muxings)[number];
			expect(codes(plan)).toContain("LIVE_MUXING_VIDEO_NOT_PRIMARY");
		});

		it("LIVE_MUXING_MULTIPLE_VIDEO when one container holds two pictures", () => {
			const plan = basePlan();
			plan.renditions.push({
				key: "v360",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 800000,
				presetConfiguration: "LIVE_STANDARD",
			} as (typeof plan.renditions)[number]);
			const muxing = plan.muxings.at(0);
			if (!muxing) throw new Error("missing muxing");
			plan.muxings[0] = {
				...muxing,
				kind: "TS",
				additionalStreamKeys: ["v360"],
			} as (typeof plan.muxings)[number];
			expect(codes(plan)).toContain("LIVE_MUXING_MULTIPLE_VIDEO");
		});

		/**
		 * A channel that goes ON AIR silent —  C1. Worse than the VOD
		 * twin because nothing shows it: the ladder is there, the manifest
		 * parses, the picture plays, and every variant names an EXT-X-MEDIA
		 * group that was never created.
		 */
		it("LIVE_UNMUXED_RENDITION is an ERROR when the dropped rendition is audio", () => {
			const plan = basePlan();
			plan.muxings = plan.muxings.filter((m) => m.streamKey !== "a128");
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_UNMUXED_RENDITION",
			);
			expect(issue?.level).toBe("error");
			expect(issue?.message).toContain("on air silent");
		});

		it("…and stays a WARNING for a dropped video rendition", () => {
			// The asymmetry is the point: a missing rung is visible, a missing
			// audio track is not. A rail that blocked both would be refusing
			// plans on a judgement nobody asked for.
			const plan = basePlan();
			plan.muxings = plan.muxings.filter((m) => m.streamKey !== "v720");
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_UNMUXED_RENDITION",
			);
			expect(issue?.level).toBe("warning");
		});

		it("LIVE_MUXING_NO_DESTINATION (no DRM exists to own outputs)", () => {
			const plan = basePlan();
			const muxing = plan.muxings.at(0);
			if (!muxing) throw new Error("missing muxing");
			muxing.destination = undefined;
			expect(codes(plan)).toContain("LIVE_MUXING_NO_DESTINATION");
		});

		it("LIVE_MUXING_CODEC_MISMATCH for H265 in TS", () => {
			const plan = basePlan();
			plan.renditions[0] = {
				key: "v720",
				codec: "H265",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				level: null,
				mode: "STANDARD",
			};
			plan.muxings[0] = {
				key: "v720",
				kind: "TS",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "seg_%number%.ts",
				destination: { outputKey: "out", path: "live/video/720p" },
			};
			expect(codes(plan)).toContain("LIVE_MUXING_CODEC_MISMATCH");
		});

		it("LIVE_UNMUXED_RENDITION is a warning, not an error", () => {
			const plan = basePlan();
			plan.renditions.push({
				key: "orphan",
				codec: "H264",
				name: "orphan",
				ingestKey: "video",
				height: 360,
				bitrate: 800000,
				level: null,
				presetConfiguration: "LIVE_STANDARD",
				mode: "STANDARD",
			});
			const issues = validateLiveChannel(plan);
			const orphan = issues.find((i) => i.code === "LIVE_UNMUXED_RENDITION");
			expect(orphan?.level).toBe("warning");
			expect(planHasErrors(issues)).toBe(false);
		});

		it("LIVE_DASH_NO_REPRESENTATIONS when only TS legs exist", () => {
			const plan = basePlan();
			plan.muxings = [
				{
					key: "v720",
					kind: "TS",
					streamKey: "v720",
					segmentLength: 6,
					segmentNaming: "seg_%number%.ts",
					destination: { outputKey: "out", path: "live/video/720p" },
				},
				{
					key: "a128",
					kind: "TS",
					streamKey: "a128",
					segmentLength: 6,
					segmentNaming: "seg_%number%.ts",
					destination: { outputKey: "out", path: "live/audio/128000" },
				},
			];
			plan.liveManifests.push({
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				name: "Live DASH Manifest",
				destination: { outputKey: "out", path: "live" },
				audioLanguage: "en",
				representationType: "TEMPLATE",
				timeshift: 7200,
			});
			expect(codes(plan)).toContain("LIVE_DASH_NO_REPRESENTATIONS");
		});

		it("LIVE_HLS_NO_ENTRIES when muxing-kind pins select no legs", () => {
			// Parity with the DASH rail: an HLS manifest whose pins deselect
			// every leg must not reach START as an empty master playlist.
			const plan = basePlan();
			const hls = plan.liveManifests.at(0);
			if (hls?.kind !== "HLS") {
				throw new Error("missing hls manifest");
			}
			hls.videoMuxingKind = "TS"; // base plan only has FMP4 legs
			hls.audioMuxingKind = "TS";
			expect(codes(plan)).toContain("LIVE_HLS_NO_ENTRIES");
		});

		it("LIVE_SEGMENT_PATH_NOT_UNDER_MANIFEST warns on unstrippable paths", () => {
			const plan = basePlan();
			const muxing = plan.muxings.at(0);
			if (!muxing?.destination) throw new Error("missing muxing");
			muxing.destination.path = "elsewhere/video/720p";
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_SEGMENT_PATH_NOT_UNDER_MANIFEST",
			);
			expect(issue?.level).toBe("warning");
		});

		// The classic TS+FMP4 dual-leg layout: an unpinned HLS manifest
		// selects BOTH legs of a rendition, and the bitrate-keyed playlist
		// uris collide — two playlists overwriting each other at the origin.
		function dualLegPlan(): LiveChannelPlan {
			const plan = basePlan();
			plan.muxings.push({
				key: "v720-ts",
				kind: "TS",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "seg_%number%.ts",
				destination: { outputKey: "out", path: "live/video/720p-ts" },
			});
			return plan;
		}

		it("LIVE_HLS_URI_COLLISION when an unpinned manifest selects both legs", () => {
			const issue = validateLiveChannel(dualLegPlan()).find(
				(i) => i.code === "LIVE_HLS_URI_COLLISION",
			);
			expect(issue?.level).toBe("error");
			expect(issue?.message).toContain("video_3000000.m3u8");
			expect(issue?.message).toContain("v720");
			expect(issue?.message).toContain("v720-ts");
		});

		it("LIVE_HLS_URI_COLLISION clears once a muxing-kind pin disambiguates — and the pin orphans the other leg", () => {
			const plan = dualLegPlan();
			const hls = plan.liveManifests.at(0);
			if (hls?.kind !== "HLS") throw new Error("missing hls manifest");
			hls.videoMuxingKind = "FMP4";
			const issues = validateLiveChannel(plan);
			expect(issues.map((i) => i.code)).not.toContain("LIVE_HLS_URI_COLLISION");
			// This fixture carries TS *and* fMP4 legs with ONE manifest, so
			// whichever container the pin chooses, the other leg is encoded and
			// referenced by nothing. The plan was a misconfiguration all along
			// and nothing said so until LIVE_MUXING_UNREFERENCED existed
			//  — the assertion used to be
			// `planHasErrors === false`, which recorded the blindness.
			expect(issues.map((i) => i.code)).toContain("LIVE_MUXING_UNREFERENCED");
			const orphan = issues.find((i) => i.code === "LIVE_MUXING_UNREFERENCED");
			expect(orphan?.message).toMatch(/"v720-ts"/);
			expect(orphan?.level).toBe("error");
		});

		it("a second manifest family adopts the other leg, and the plan is clean", () => {
			// The configuration the dual-leg shape is FOR: HLS takes the TS
			// legs, DASH takes the fMP4 ones, and nothing is orphaned. This is
			// the arm that stops LIVE_MUXING_UNREFERENCED from being a rule
			// nobody can satisfy.
			const plan = dualLegPlan();
			const hls = plan.liveManifests.at(0);
			if (hls?.kind !== "HLS") throw new Error("missing hls manifest");
			hls.videoMuxingKind = "TS";
			hls.audioMuxingKind = "TS";
			plan.liveManifests.push({
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				name: "Live DASH Manifest",
				destination: { outputKey: "out", path: "live" },
				audioLanguage: "en",
				representationType: "TEMPLATE",
				timeshift: 7200,
			});
			const issues = validateLiveChannel(plan);
			expect(issues.map((i) => i.code)).not.toContain(
				"LIVE_MUXING_UNREFERENCED",
			);
			expect(planHasErrors(issues)).toBe(false);
		});

		it("two renditions sharing a bitrate get distinct playlist names instead of a collision (row #325)", () => {
			const plan = basePlan();
			plan.renditions.push({
				key: "a128b",
				codec: "AAC",
				ingestKey: "audio",
				name: "AAC 128 (alt rate)",
				bitrate: 128000,
				rate: 44100,
				channelLayout: "CL_STEREO",
			});
			plan.muxings.push({
				key: "a128b",
				kind: "FMP4",
				streamKey: "a128b",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "out", path: "live/audio/128000b" },
			});
			expect(validateLiveChannel(plan).map((i) => i.code)).not.toContain(
				"LIVE_HLS_URI_COLLISION",
			);
			const emitted = compileLiveChannel(plan)
				.filter((op) => op.kind === "CREATE_HLS_AUDIO_MEDIA")
				.map((op) => (op.payload as { uri?: unknown }).uri);
			expect(emitted).toEqual(["audio_128000.m3u8", "audio_128000_1.m3u8"]);
		});

		it("suffixes count per kind in plan order and leave the first bare (row #325)", () => {
			const plan = basePlan();
			const v = plan.renditions.find((r) => r.key === "v720");
			if (v?.codec !== "H264") throw new Error("fixture video missing");
			plan.renditions.push({ ...v, key: "v720b" }, { ...v, key: "v720c" });
			expect([...liveHlsEntryUris(plan).entries()]).toEqual([
				["v720", "video_3000000.m3u8"],
				["a128", "audio_128000.m3u8"],
				["v720b", "video_3000000_1.m3u8"],
				["v720c", "video_3000000_2.m3u8"],
			]);
		});
	});

	describe("live support-matrix rails", () => {
		it.each([
			"OFF",
			"AUTO",
			"ON",
		])("keeps AV1 detail preservation %s VOD-only", (detailPreservationMode) => {
			const plan = basePlan();
			plan.renditions[0] = {
				key: "v720",
				codec: "AV1",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				mode: "STANDARD",
				detailPreservationMode,
			};
			expect(validateLiveChannel(plan)).toContainEqual(
				expect.objectContaining({
					code: "LIVE_CODEC_UNSUPPORTED",
					level: "error",
					path: "renditions[0].codec",
				}),
			);
		});

		it("LIVE_CODEC_UNSUPPORTED for VP9, Atmos and WebVTT", () => {
			const plan = basePlan();
			plan.renditions.push(
				{
					key: "vp9",
					codec: "VP9",
					ingestKey: "video",
					height: 360,
					bitrate: 500000,
					mode: "STANDARD",
				},
				{
					key: "atmos",
					codec: "DOLBY_ATMOS",
					ingestKey: "audio",
					bitrate: 448000,
					rate: 48000,
					loudnessControl: {
						meteringMode: "ITU_R_BS_1770_4",
						dialogueIntelligence: "ENABLED",
						speechThreshold: 15,
					},
				},
				{
					key: "vtt",
					codec: "WEBVTT",
					ingestKey: "video",
					label: "en",
					language: "en",
					groupId: "SUBTITLE",
					uri: "subtitles_en.m3u8",
				},
			);
			const issues = validateLiveChannel(plan).filter(
				(i) => i.code === "LIVE_CODEC_UNSUPPORTED",
			);
			expect(issues.map((i) => i.path)).toEqual([
				"renditions[2].codec",
				"renditions[3].codec",
				"renditions[4].codec",
			]);
			expect(issues.every((i) => i.level === "error")).toBe(true);
		});

		it("LIVE_PER_TITLE_UNSUPPORTED for per-title stream modes", () => {
			const plan = basePlan();
			const rendition = plan.renditions.at(0);
			if (rendition?.codec !== "H264") throw new Error("expected h264");
			rendition.mode = "PER_TITLE_TEMPLATE";
			expect(codes(plan)).toContain("LIVE_PER_TITLE_UNSUPPORTED");
		});

		it("LIVE_RENDITION_BITRATE_REQUIRED on null video bitrate", () => {
			const plan = basePlan();
			const rendition = plan.renditions.at(0);
			if (rendition?.codec !== "H264") throw new Error("expected h264");
			rendition.bitrate = null;
			expect(codes(plan)).toContain("LIVE_RENDITION_BITRATE_REQUIRED");
		});

		it("LIVE_PRESET_VOD warns on the shared schema's VOD default", () => {
			const plan = basePlan();
			const rendition = plan.renditions.at(0);
			if (rendition?.codec !== "H264") throw new Error("expected h264");
			rendition.presetConfiguration = "VOD_HIGH_QUALITY";
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_PRESET_VOD",
			);
			expect(issue?.level).toBe("warning");
		});

		const featureCases: {
			field: string;
			mutate: (
				rendition: Extract<
					LiveChannelPlan["renditions"][number],
					{ codec: "H264" }
				>,
			) => void;
		}[] = [
			{
				field: "filters",
				mutate: (r) => {
					r.filters = [{ filterKey: "f", position: 0 }];
				},
			},
			{
				field: "nexguard",
				mutate: (r) => {
					r.nexguard = {
						credentialId: "00000000-0000-4000-8000-000000000009",
						watermarkType: "OTT",
						preset: "p",
						strength: "DEFAULT",
					};
				},
			},
			{
				field: "encodingKey",
				mutate: (r) => {
					r.encodingKey = "enc1";
				},
			},
			{
				field: "dashSetKey",
				mutate: (r) => {
					r.dashSetKey = "set1";
				},
			},
			{
				field: "hlsMedia",
				mutate: (r) => {
					r.hlsMedia = { groupId: "g", name: "n", uri: "u.m3u8" };
				},
			},
			{
				field: "hlsVariantLabel",
				mutate: (r) => {
					r.hlsVariantLabel = "dv";
				},
			},
		];
		for (const { field, mutate } of featureCases) {
			it(`LIVE_RENDITION_FEATURE_UNSUPPORTED on ${field}`, () => {
				const plan = basePlan();
				const rendition = plan.renditions.at(0);
				if (rendition?.codec !== "H264") throw new Error("expected h264");
				mutate(rendition);
				const issue = validateLiveChannel(plan).find(
					(i) => i.code === "LIVE_RENDITION_FEATURE_UNSUPPORTED",
				);
				expect(issue?.path).toBe(`renditions[0].${field}`);
			});
		}

		it.each([
			["motionCompensatedTemporalFiltering", "OFF"],
			["motionCompensatedTemporalFiltering", "AUTO"],
			["motionCompensatedTemporalFiltering", "ON"],
			[
				"rateControlModeConfig",
				{ type: "PERCEPTUAL_QUALITY_MODE", perceptualStrength: 0 },
			],
		] as const)("rejects native HEVCv2 %s in ordinary Live H265", (field, value) => {
			const plan = basePlan();
			plan.renditions[0] = {
				key: "v720",
				codec: "H265",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				level: null,
				mode: "STANDARD",
				[field]: value,
			};
			const parsed = liveChannelPlanSchema.parse(plan);
			const issue = validateLiveChannel(parsed).find(
				(i) => i.path === `renditions[0].${field}`,
			);
			expect(issue).toMatchObject({
				code: "LIVE_RENDITION_FEATURE_UNSUPPORTED",
				level: "error",
			});
			expect(planHasErrors(validateLiveChannel(parsed))).toBe(true);
		});

		it("ordinary Live H265 remains valid when native controls are omitted", () => {
			const plan = basePlan();
			plan.renditions[0] = {
				key: "v720",
				codec: "H265",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				level: null,
				mode: "STANDARD",
			};
			expect(validateLiveChannel(liveChannelPlanSchema.parse(plan))).toEqual(
				[],
			);
		});

		it("LIVE_RENDITION_FEATURE_UNSUPPORTED on H265 dolbyVisionMetadata", () => {
			const plan = basePlan();
			plan.renditions[0] = {
				key: "v720",
				codec: "H265",
				ingestKey: "video",
				height: 720,
				bitrate: 3000000,
				level: null,
				mode: "STANDARD",
				dolbyVisionMetadata: {
					profile: "DVHE_05",
					metadataSource: "EMBEDDED",
				},
			};
			expect(codes(plan)).toContain("LIVE_RENDITION_FEATURE_UNSUPPORTED");
		});
	});

	describe("C8 — DVR element budget (never clamped)", () => {
		function dvrPlan(timeshift: number): LiveChannelPlan {
			const plan = basePlan();
			for (const muxing of plan.muxings) {
				if (muxing.kind === "MP4")
					throw new Error("DVR fixture must be segmented");
				muxing.segmentLength = 1;
			}
			const manifest = plan.liveManifests.at(0);
			if (!manifest) throw new Error("missing manifest");
			manifest.timeshift = timeshift;
			return plan;
		}

		it("stays silent under 80% utilization", () => {
			// 2 legs × 7200 / 1s = 14400 elements = 27% of 54000.
			expect(
				validateLiveChannel(dvrPlan(7200)).filter((i) => i.code === "C8"),
			).toEqual([]);
		});

		it("warns above 80% utilization", () => {
			// 2 legs × 24300 = 48600 elements = 90%.
			const issue = validateLiveChannel(dvrPlan(24300)).find(
				(i) => i.code === "C8",
			);
			expect(issue?.level).toBe("warning");
			expect(issue?.message).toContain("48600");
			expect(issue?.message).toContain("54000");
		});

		it("errors only when over budget — and explains the math", () => {
			// 2 legs × 30000 = 60000 elements > 54000.
			const issue = validateLiveChannel(dvrPlan(30000)).find(
				(i) => i.code === "C8",
			);
			expect(issue?.level).toBe("error");
			expect(issue?.message).toContain("60000");
			expect(issue?.message).toContain("ceil");
		});

		it("LIVE_TIMESHIFT_INCONSISTENT warns on a DVR-less sibling manifest", () => {
			const plan = basePlan();
			plan.liveManifests.push({
				key: "dash",
				kind: "DASH",
				manifestName: "stream.mpd",
				name: "Live DASH Manifest",
				destination: { outputKey: "out", path: "live" },
				audioLanguage: "en",
				representationType: "TEMPLATE",
			});
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_TIMESHIFT_INCONSISTENT",
			);
			expect(issue?.level).toBe("warning");
			expect(issue?.path).toBe("liveManifests[1].timeshift");
		});
	});

	it("LIVE_AUTORESTART_TIMEOUT duplicates the schema minimum for TS plans", () => {
		const plan = basePlan();
		plan.start.autoRestart = { segmentsWrittenTimeout: 10 };
		const issue = validateLiveChannel(plan).find(
			(i) => i.code === "LIVE_AUTORESTART_TIMEOUT",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.path).toBe("start.autoRestart.segmentsWrittenTimeout");
		// And not on a compliant value.
		plan.start.autoRestart = { segmentsWrittenTimeout: 30 };
		expect(codes(plan)).not.toContain("LIVE_AUTORESTART_TIMEOUT");
	});

	it("requires cloudRegion EXTERNAL when infrastructure is set (C18)", () => {
		const plan = basePlan();
		plan.bitmovin.infrastructure = {
			infrastructureId: "infra-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
		};
		// basePlan defaults cloudRegion to AUTO — must fail.
		const issue = validateLiveChannel(plan).find(
			(i) => i.code === "LIVE_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.path).toBe("bitmovin.cloudRegion");
		plan.bitmovin.cloudRegion = "EXTERNAL";
		expect(codes(plan)).not.toContain(
			"LIVE_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
		);
	});

	describe("C19 — clockSynchronizationMode vs HLS PDT source", () => {
		/** [clock mode, HLS PDT source, expects the error] */
		const CASES: [string | undefined, string | undefined, boolean][] = [
			// Both set and MATCHED ⇒ fine (this is the golden's shape).
			["SYSTEM_CLOCK", "SYSTEM_CLOCK", false],
			["EMBEDDED", "EMBEDDED", false],
			// Both set and MISMATCHED ⇒ the encoding FAILS at Bitmovin, so error.
			["SYSTEM_CLOCK", "EMBEDDED", true],
			["EMBEDDED", "SYSTEM_CLOCK", true],
			// Only one side set ⇒ nothing to conflict with (the encoder defaults
			// to the equivalent mode only when a PDT source IS set).
			["SYSTEM_CLOCK", undefined, false],
			[undefined, "EMBEDDED", false],
			[undefined, undefined, false],
		];
		for (const [clockMode, source, expectError] of CASES) {
			it(`clock=${clockMode ?? "unset"} source=${source ?? "unset"} ⇒ ${expectError ? "error" : "clean"}`, () => {
				const plan = basePlan();
				if (clockMode) {
					plan.start.adInsertion = {
						clockSynchronizationMode: clockMode as "SYSTEM_CLOCK",
					};
				}
				if (source) {
					const hls = plan.liveManifests.find((m) => m.kind === "HLS");
					if (hls?.kind !== "HLS") {
						throw new Error("basePlan carries an HLS manifest");
					}
					hls.programDateTimeSettings = {
						source: source as "SYSTEM_CLOCK",
					};
				}
				const issue = validateLiveChannel(plan).find(
					(i) => i.code === "LIVE_CLOCK_SYNC_PDT_CONFLICT",
				);
				if (expectError) {
					expect(issue?.level).toBe("error");
					expect(issue?.path).toMatch(
						/^liveManifests\[\d+\]\.programDateTimeSettings\.source$/,
					);
				} else {
					expect(issue).toBeUndefined();
				}
			});
		}

		it("ignores a DASH-only plan (DASH has no PDT source)", () => {
			const plan = basePlan();
			plan.liveManifests = plan.liveManifests.filter((m) => m.kind === "DASH");
			plan.start.adInsertion = { clockSynchronizationMode: "EMBEDDED" };
			expect(codes(plan)).not.toContain("LIVE_CLOCK_SYNC_PDT_CONFLICT");
		});
	});

	describe("cacheControl output-provider support", () => {
		it("warns on an output that ignores Cache-Control, and stays quiet on S3/GCS/Azure", () => {
			const plan = basePlan();
			plan.start.cacheControl = {
				hls: { variantPlaylist: { cacheControl: "public, max-age=2" } },
			};
			// basePlan's output is S3 — supported, so no warning.
			expect(codes(plan)).not.toContain("LIVE_CACHE_CONTROL_PROVIDER");
			const output = plan.outputs[0];
			if (!output) {
				throw new Error("basePlan carries an output");
			}
			for (const kind of ["GCS", "GCS_SERVICE_ACCOUNT", "AZURE"] as const) {
				output.kind = kind as typeof output.kind;
				expect(codes(plan), `${kind} is a supported provider`).not.toContain(
					"LIVE_CACHE_CONTROL_PROVIDER",
				);
			}
			// SFTP genuinely ignores the headers ⇒ a warning, never an error.
			output.kind = "SFTP" as typeof output.kind;
			const issue = validateLiveChannel(plan).find(
				(i) => i.code === "LIVE_CACHE_CONTROL_PROVIDER",
			);
			expect(issue?.level).toBe("warning");
			expect(issue?.path).toBe("start.cacheControl");
		});

		it("stays quiet when no cacheControl is requested", () => {
			expect(codes(basePlan())).not.toContain("LIVE_CACHE_CONTROL_PROVIDER");
		});
	});

	it("rejects EXTERNAL without an infrastructure block (C18 inverse)", () => {
		const plan = basePlan();
		plan.bitmovin.cloudRegion = "EXTERNAL";
		const issue = validateLiveChannel(plan).find(
			(i) => i.code === "LIVE_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE",
		);
		expect(issue?.level).toBe("error");
		plan.bitmovin.infrastructure = {
			infrastructureId: "infra-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
		};
		expect(codes(plan)).not.toContain(
			"LIVE_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE",
		);
	});

	it("warns when a static IP rides an unpinned region (AUTO/aggregates)", () => {
		const plan = basePlan();
		plan.bitmovin.staticIpId = "ip-1";
		// basePlan default region is AUTO — region-bound IP is unpinned.
		const issue = validateLiveChannel(plan).find(
			(i) => i.code === "LIVE_STATIC_IP_REGION_UNPINNED",
		);
		expect(issue?.level).toBe("warning");
		expect(issue?.path).toBe("bitmovin.cloudRegion");
		plan.bitmovin.cloudRegion = "AWS_AP_NORTHEAST_1";
		expect(codes(plan)).not.toContain("LIVE_STATIC_IP_REGION_UNPINNED");
		// Continent aggregates are just as unpinned as AUTO.
		plan.bitmovin.cloudRegion = "EUROPE";
		expect(codes(plan)).toContain("LIVE_STATIC_IP_REGION_UNPINNED");
	});
});

describe("credential-egress host allowlist agrees with the worker (C22)", () => {
	/**
	 * A review proved the two sides disagreed: the validator enumerated the ESAM
	 * site whenever `poisEndpoint` was set, so an UNAUTHENTICATED POIS endpoint
	 * was blocked at submit with a 400 while the worker allowed it at execution.
	 * The worker was right — C22 scopes the rail by "does a vaulted secret egress
	 * here", explicitly not by "is this field a URL" — and the symptom was a false
	 * rejection of a case the constraint does not cover.
	 */
	const withEsam = (esam: Record<string, unknown>): LiveChannelPlan => {
		const plan = basePlan();
		return { ...plan, start: { ...plan.start, esam } } as LiveChannelPlan;
	};
	const ALLOW = ["pois.example.com"];
	const codes = (plan: LiveChannelPlan) =>
		validateLiveChannel(plan, { secretEgressAllowedHosts: ALLOW })
			.filter((issue) => issue.path === "start.esam.poisEndpoint")
			.map((issue) => issue.code);

	it("blocks an unvetted host when a POIS CREDENTIAL rides", () => {
		expect(
			codes(
				withEsam({
					poisEndpoint: "https://attacker.example.net/esam",
					poisCredentialId: "00000000-0000-4000-8000-0000000000c1",
				}),
			),
		).toEqual(["PLAN_SECRET_EGRESS_HOST_NOT_ALLOWED"]);
	});

	it("does NOT block an unvetted host with no credential — nothing vaulted egresses", () => {
		expect(
			codes(withEsam({ poisEndpoint: "https://whoever.example.net/esam" })),
		).toEqual([]);
	});

	it("stays silent for an allowlisted host with a credential", () => {
		expect(
			codes(
				withEsam({
					poisEndpoint: "https://pois.example.com/esam",
					poisCredentialId: "00000000-0000-4000-8000-0000000000c1",
				}),
			),
		).toEqual([]);
	});
});

describe("C31 on the LIVE path — the path MSL exists for (ledger #137)", () => {
	/**
	 * review-4 #1. The first cut checked C31 in `validatePlan` only. Live
	 * reuses `planOutputSchema` verbatim, so an MSL output parses here
	 * identically — and `validateLiveChannel` builds its own issue list, so
	 * nothing carried over. With no wizard support for MSL yet, a pasted live
	 * plan is the ONLY way to reach the feature today: the constraint ran
	 * nowhere it mattered.
	 *
	 * These arms therefore test the WIRING, not the checker (the checker's own
	 * table is pinned in plan/validate.test.ts). One passing arm and one
	 * failing arm on the live validator is what proves it is connected.
	 */
	function mslChannel(opts: {
		streamFormat: "DASH" | "HLS" | "CMAF";
		muxingKind: "FMP4" | "TS";
		manifestKind: "HLS" | "DASH";
	}): LiveChannelPlan {
		const plan = basePlan();
		return liveChannelPlanSchema.parse({
			...plan,
			outputs: [
				{
					key: "msl",
					kind: "AKAMAI_MSL",
					credentialId: "00000000-0000-4000-8000-000000000003",
					streamFormat: opts.streamFormat,
				},
			],
			muxings: plan.muxings.map((m) => ({
				key: m.key,
				kind: opts.muxingKind,
				streamKey: m.streamKey,
				// MSL-conforming naming: these cases are about the CONTAINER
				// rule, and the schema default would fail them for the naming
				// rule instead (measured against the real API, 2026-08-21).
				segmentNaming: `seg-{rand_chars:8}-%number%.${
					opts.muxingKind === "TS" ? "ts" : "m4s"
				}`,
				destination: { outputKey: "msl", path: `live/${m.key}` },
			})),
			liveManifests: [
				{
					key: "m",
					kind: opts.manifestKind,
					destination: { outputKey: "msl", path: "live" },
					...(opts.manifestKind === "HLS" ? { timeshift: 7200 } : {}),
				},
			],
		});
	}

	const c31 = (plan: LiveChannelPlan) =>
		validateLiveChannel(plan).filter((i) => i.code === "C31");

	it("accepts a coherent MSL channel", () => {
		expect(
			c31(
				mslChannel({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKind: "HLS",
				}),
			),
		).toEqual([]);
	});

	it("rejects fMP4 muxings on an HLS-format MSL output", () => {
		// Green before the wiring fix, because validateLiveChannel never ran
		// the check at all.
		const issues = c31(
			mslChannel({
				streamFormat: "HLS",
				muxingKind: "FMP4",
				manifestKind: "HLS",
			}),
		);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues.map((i) => i.message).join(" ")).toMatch(
			/do not expect to accept FMP4/,
		);
	});

	it("rejects a DASH-format MSL output carrying only an HLS manifest", () => {
		const issues = c31(
			mslChannel({
				streamFormat: "DASH",
				muxingKind: "FMP4",
				manifestKind: "HLS",
			}),
		);
		// Two, and the pair is the point: the DASH manifest it must have is an
		// ERROR, the HLS one it should not have beside it is a WARNING
		// (review-5 I3/I4). The live path gets both because it runs the same
		// checker, which is the whole claim of this describe block.
		expect(issues).toHaveLength(2);
		expect(issues[0]?.level).toBe("error");
		expect(issues[0]?.message).toMatch(/missing DASH/);
		expect(issues[1]?.level).toBe("warning");
		expect(issues[1]?.message).toMatch(/do not expect to accept HLS manifest/);
	});

	it("leaves an ordinary S3 channel alone", () => {
		expect(c31(basePlan())).toEqual([]);
	});
});

describe("Akamai MSL4 manifest path contract (re-audit 2026-08-29 BLOCKER-5, ledger #220)", () => {
	const mslFixture = () =>
		liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(__dirname, "__fixtures__/live-akamai-msl.plan.json"),
					"utf8",
				),
			),
		);
	const mslPathIssues = (path: string) => {
		const plan = mslFixture();
		for (const m of plan.liveManifests) {
			m.destination.path = path;
		}
		return validateLiveChannel(plan).filter(
			(i) => i.code === "LIVE_MSL_MANIFEST_PATH",
		);
	};
	it("refuses the wizard's old `output/<name>` shape on an MSL primary — the edge served 404 for every referenced segment", () => {
		const issues = mslPathIssues("output/my-live");
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]?.level).toBe("error");
		expect(issues[0]?.message).toMatch(/leading and a trailing slash/);
	});
	it.each([
		"",
		"/output/my-live/",
	])("accepts the documented form %j", (path) => {
		expect(mslPathIssues(path)).toEqual([]);
	});
	it.each([
		"/output/my-live", // leading slash only
		"output/my-live/", // trailing slash only
		"/", // a nameless wrapped path — no documented case
		"output/my-live", // neither (the wizard's old shape)
	])("refuses the asymmetric or degenerate shape %j (review-338 S2)", (path) => {
		// Exactly "" and "/<name>/" are accepted; the probe that found the
		// regex right also found nothing in the suite pinning these four.
		const issues = mslPathIssues(path);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]?.level).toBe("error");
	});
	it("does not police a STORAGE primary's folder — an MSL mirror gets its own wire path from the compiler", () => {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(__dirname, "__fixtures__/live-akamai-msl-storage.plan.json"),
					"utf8",
				),
			),
		);
		expect(plan.liveManifests[0]?.destination.path).toBe(
			"output/live-akamai-msl-storage",
		);
		expect(
			validateLiveChannel(plan).filter(
				(i) => i.code === "LIVE_MSL_MANIFEST_PATH",
			),
		).toEqual([]);
	});
});
