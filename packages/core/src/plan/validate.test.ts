import { describe, expect, it } from "vitest";
import {
	AKAMAI_MSL_REQUIREMENTS,
	checkAkamaiMslConstraints,
} from "./akamai-msl-constraint";
import { compilePlan } from "./compiler";
import {
	encodingPlanSchema,
	nexGuardSchema,
	planManifestSchema,
	planMuxingSchema,
	planOutputSchema,
} from "./schema";
import { planHasErrors, validatePlan } from "./validate";

function basePlan() {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "test",
		bitmovin: {},
		inputs: [
			{
				key: "in",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "b",
			},
		],
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "b",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
			},
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				destination: { outputKey: "out", path: "x/video" },
			},
		],
		manifests: [],
		generation: { timing: "JUST_IN_TIME" },
	});
}

describe("validatePlan", () => {
	it("rejects a retained numeric per-title template bitrate before provider creation", () => {
		const plan = basePlan();
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw new Error("fixture");
		for (const mode of [
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		] as const) {
			video.mode = mode;
			video.bitrate = 300_000;
			expect(validatePlan(plan)).toContainEqual(
				expect.objectContaining({
					code: "PLAN_PER_TITLE_BITRATE",
					level: "error",
					path: "renditions.0.bitrate",
				}),
			);
			video.bitrate = null;
			expect(
				validatePlan(plan).some((i) => i.code === "PLAN_PER_TITLE_BITRATE"),
			).toBe(false);
		}
	});
	it("passes a coherent plan", () => {
		expect(validatePlan(basePlan())).toEqual([]);
	});

	it("flags unresolved references with paths", () => {
		const plan = basePlan();
		const ingest = plan.ingest.at(0);
		const muxing = plan.muxings.at(0);
		if (!ingest || !muxing) {
			throw new Error("fixture is missing entries");
		}
		ingest.inputKey = "nope";
		muxing.streamKey = "ghost";
		const issues = validatePlan(plan);
		expect(issues.map((i) => i.code)).toContain("PLAN_UNRESOLVED_REF");
		expect(planHasErrors(issues)).toBe(true);
		expect(issues.some((i) => i.path === "ingest[0].inputKey")).toBe(true);
	});

	it("flags duplicate keys", () => {
		const plan = basePlan();
		const first = plan.inputs.at(0);
		if (!first) {
			throw new Error("fixture is missing entries");
		}
		plan.inputs.push({ ...first });
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "PLAN_DUPLICATE_KEY")).toBe(true);
	});

	it("warns (not errors) on unmuxed renditions", () => {
		const plan = basePlan();
		const first = plan.renditions.at(0);
		if (!first) {
			throw new Error("fixture is missing entries");
		}
		plan.renditions.push({ ...first, key: "orphan" });
		const issues = validatePlan(plan);
		const orphan = issues.find((i) => i.code === "PLAN_UNMUXED_RENDITION");
		expect(orphan?.level).toBe("warning");
		expect(planHasErrors(issues)).toBe(false);
	});

	it("warns when a muxing writes outside a manifest base path", () => {
		const plan = basePlan();
		plan.manifests.push({
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS Manifest",
			destination: { outputKey: "out", path: "other-base/" },
			masterVersion: "HLS_V4",
			mediaVersion: "HLS_V4",
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
			perTitleVariantUri: "AVG_BITRATE",
		});
		const issues = validatePlan(plan);
		const warnings = issues.filter(
			(i) => i.code === "PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST",
		);
		// Aggregated: one issue per manifest, naming the offending muxings.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.level).toBe("warning");
		expect(warnings[0]?.message).toContain('"hls"');
		// The aggregated message must name the offending muxings.
		expect(warnings[0]?.message).toContain("muxing(s) v ");
		expect(planHasErrors(issues)).toBe(false);
	});

	it("treats an empty manifest base path as bucket root (no warning)", () => {
		const plan = basePlan();
		plan.manifests.push({
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS Manifest",
			destination: { outputKey: "out", path: "" },
			masterVersion: "HLS_V4",
			mediaVersion: "HLS_V4",
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
			perTitleVariantUri: "AVG_BITRATE",
		});
		const issues = validatePlan(plan);
		expect(
			issues.some((i) => i.code === "PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST"),
		).toBe(false);
	});

	it("enforces C1 once per-title modes exist (P2 surface, via cast)", () => {
		const plan = basePlan();
		plan.manifests.push({
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS Manifest",
			destination: { outputKey: "out", path: "x/" },
			masterVersion: "HLS_V4",
			mediaVersion: "HLS_V4",
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
			perTitleVariantUri: "AVG_BITRATE",
		});
		const rendition = plan.renditions.at(0);
		if (rendition?.codec !== "H264") {
			throw new Error("fixture is missing entries");
		}
		(rendition as { mode: string }).mode = "PER_TITLE_TEMPLATE";
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "C1" && i.level === "error")).toBe(
			true,
		);
		// Post-encoding resolves it.
		plan.generation.timing = "POST_ENCODING";
		expect(validatePlan(plan).some((i) => i.code === "C1")).toBe(false);
	});

	it("flags manifests pointing at unknown outputs", () => {
		const plan = basePlan();
		plan.manifests.push({
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS Manifest",
			destination: { outputKey: "missing", path: "x/" },
			masterVersion: "HLS_V4",
			mediaVersion: "HLS_V4",
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
			perTitleVariantUri: "AVG_BITRATE",
		});
		expect(planHasErrors(validatePlan(plan))).toBe(true);
	});

	function vttPlan() {
		const plan = basePlan();
		plan.fileStreams.push({
			key: "vtt-en",
			inputKey: "in",
			inputPath: "subs/en.vtt",
			fileType: "WEBVTT",
		});
		plan.renditions.push(
			encodingPlanSchema.shape.renditions.element.parse({
				key: "vtt",
				codec: "WEBVTT",
				ingestKey: "vtt-en",
			}),
		);
		plan.muxings.push({
			key: "vtt",
			kind: "CHUNKED_TEXT",
			streamKey: "vtt",
			segmentLength: 10,
			segmentNaming: "en_webvtt_seg_%number%.vtt",
			destination: { outputKey: "out", path: "x/en" },
		});
		return plan;
	}

	it("passes a coherent WebVTT sidecar plan", () => {
		expect(validatePlan(vttPlan())).toEqual([]);
	});

	it("rejects stream-source mismatches in both directions", () => {
		const wrongVtt = vttPlan();
		const vtt = wrongVtt.renditions.find((r) => r.codec === "WEBVTT");
		if (!vtt) {
			throw new Error("fixture is missing the vtt rendition");
		}
		vtt.ingestKey = "video"; // subtitle track fed by an AV ingest
		expect(
			validatePlan(wrongVtt).filter(
				(i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH",
			),
		).toHaveLength(1);

		const wrongVideo = vttPlan();
		const video = wrongVideo.renditions.find((r) => r.codec === "H264");
		if (!video) {
			throw new Error("fixture is missing the video rendition");
		}
		video.ingestKey = "vtt-en"; // AV rendition fed by a whole file
		expect(
			validatePlan(wrongVideo).some(
				(i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH",
			),
		).toBe(true);
	});

	it("rejects container/codec mismatches", () => {
		const plan = vttPlan();
		const chunked = plan.muxings.find((m) => m.kind === "CHUNKED_TEXT");
		const fmp4 = plan.muxings.find((m) => m.kind === "FMP4");
		if (!chunked || !fmp4) {
			throw new Error("fixture is missing muxings");
		}
		chunked.streamKey = "v"; // chunked text packaging video
		fmp4.streamKey = "vtt"; // fmp4 packaging subtitles
		const codes = validatePlan(plan).map((i) => i.code);
		expect(
			codes.filter((c) => c === "PLAN_MUXING_CODEC_MISMATCH"),
		).toHaveLength(2);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
		"AV1",
	] as const)("accepts thumbnails on a %s video rendition", (codec) => {
		const original = basePlan();
		const plan = encodingPlanSchema.parse({
			...original,
			renditions: [
				{ key: "v", ingestKey: "video", height: 360, bitrate: 300000, codec },
			],
			muxings: [
				{
					key: "v",
					kind: codec === "VP9" ? "WEBM" : "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/video" },
				},
			],
			thumbnails: [
				{
					key: "preview",
					streamKey: "v",
					height: 180,
					pattern: "thumbnail-%number%.jpg",
					unit: "SECONDS",
					positions: [1, 5, 10],
					destination: { outputKey: "out", path: "x/thumbnails" },
				},
			],
		});
		expect(validatePlan(plan)).toEqual([]);
	});

	it("rejects thumbnails on non-video renditions and unknown outputs", () => {
		const plan = vttPlan();
		plan.thumbnails.push({
			key: "t1",
			streamKey: "vtt",
			height: 540,
			pattern: "thumbnail-%number%.jpg",
			unit: "SECONDS",
			positions: [10],
			destination: { outputKey: "missing", path: "x/thumbnail" },
		});
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).toContain("PLAN_THUMBNAIL_SOURCE_NOT_VIDEO");
		expect(codes).toContain("PLAN_UNRESOLVED_REF");
	});

	it("rejects sprites on non-video renditions and unknown outputs", () => {
		const plan = vttPlan();
		plan.sprites.push({
			key: "s1",
			streamKey: "vtt",
			distance: 10,
			unit: "SECONDS",
			height: 90,
			hTiles: 10,
			vTiles: 10,
			filename: "sprite.jpg",
			destination: { outputKey: "missing", path: "x/sprite" },
		});
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).toContain("PLAN_SPRITE_SOURCE_NOT_VIDEO");
		expect(codes).toContain("PLAN_UNRESOLVED_REF");
	});

	it("rejects a sprite with no dimension and conflicting tile config", () => {
		const plan = vttPlan();
		plan.sprites.push({
			key: "s1",
			streamKey: "v",
			distance: 10,
			unit: "SECONDS",
			// no width/height; imagesPerFile together with hTiles/vTiles; vTiles
			// missing its hTiles pair would also fire, so set both to isolate the
			// imagesPerFile conflict + the missing-dimension error.
			hTiles: 10,
			vTiles: 10,
			imagesPerFile: 100,
			filename: "sprite.jpg",
			destination: { outputKey: "out", path: "x/sprite" },
		});
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).toContain("PLAN_SPRITE_NO_DIMENSION");
		expect(codes).toContain("PLAN_SPRITE_TILE_CONFLICT");
	});

	it("rejects a sprite with hTiles but no vTiles", () => {
		const plan = vttPlan();
		plan.sprites.push({
			key: "s1",
			streamKey: "v",
			distance: 10,
			unit: "SECONDS",
			height: 90,
			hTiles: 10,
			filename: "sprite.jpg",
			destination: { outputKey: "out", path: "x/sprite" },
		});
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).toContain("PLAN_SPRITE_TILE_CONFLICT");
	});

	function perTitlePlan() {
		const plan = basePlan();
		const video = plan.renditions.at(0);
		if (video?.codec !== "H264") {
			throw new Error("fixture is missing the video rendition");
		}
		video.mode = "PER_TITLE_TEMPLATE";
		video.bitrate = null;
		const muxing = plan.muxings.at(0);
		if (!muxing) {
			throw new Error("fixture is missing the muxing");
		}
		if (!muxing.destination) {
			throw new Error("fixture muxing has no destination");
		}
		muxing.destination.path = "x/video/{height}p_{bitrate}_{uuid}/";
		plan.perTitle = { h264Configuration: { targetQualityCrf: 17 } };
		plan.generation.timing = "POST_ENCODING";
		return plan;
	}

	it("passes a coherent per-title plan", () => {
		expect(validatePlan(perTitlePlan())).toEqual([]);
	});

	it("C4: per-title muxing paths need placeholders and non-SFTP outputs", () => {
		const noPlaceholder = perTitlePlan();
		const muxing = noPlaceholder.muxings.at(0);
		if (!muxing) {
			throw new Error("fixture is missing the muxing");
		}
		if (!muxing.destination) {
			throw new Error("fixture muxing has no destination");
		}
		muxing.destination.path = "x/video/fixed";
		expect(
			validatePlan(noPlaceholder).filter((i) => i.code === "C4"),
		).toHaveLength(1);

		const sftp = perTitlePlan();
		sftp.outputs.push({
			key: "sftp-out",
			kind: "SFTP",
			credentialId: "00000000-0000-4000-8000-000000000009",
			name: "SFTP Output",
		});
		const sftpMuxing = sftp.muxings.at(0);
		if (!sftpMuxing) {
			throw new Error("fixture is missing the muxing");
		}
		if (!sftpMuxing.destination) {
			throw new Error("fixture muxing has no destination");
		}
		sftpMuxing.destination.outputKey = "sftp-out";
		expect(validatePlan(sftp).some((i) => i.code === "C4")).toBe(true);
	});

	it("requires the matching perTitle codec configuration", () => {
		const plan = perTitlePlan();
		plan.perTitle = { h265Configuration: { targetQualityCrf: 17 } };
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "PLAN_PER_TITLE_CONFIG_MISSING")).toBe(
			true,
		);
	});

	it("enforces the container/codec matrix for TS and WebM", () => {
		const tsOnAac = basePlan();
		tsOnAac.renditions.push(
			encodingPlanSchema.shape.renditions.element.parse({
				key: "vp9",
				codec: "VP9",
				ingestKey: "video",
				height: 360,
				bitrate: null,
			}),
		);
		tsOnAac.muxings.push({
			key: "bad-webm",
			kind: "WEBM",
			streamKey: "v", // H264 into WebM — invalid
			segmentLength: 6,
			segmentNaming: "seg_%number%.chk",
			initSegmentName: "init.hdr",
			destination: { outputKey: "out", path: "x/webm" },
		});
		tsOnAac.muxings.push({
			key: "ok-webm",
			kind: "WEBM",
			streamKey: "vp9",
			segmentLength: 6,
			segmentNaming: "seg_%number%.chk",
			initSegmentName: "init.hdr",
			destination: { outputKey: "out", path: "x/webm-ok" },
		});
		const codes = validatePlan(tsOnAac).map((i) => i.code);
		expect(
			codes.filter((c) => c === "PLAN_MUXING_CODEC_MISMATCH"),
		).toHaveLength(1);
	});

	it("allows AV1 in fMP4 and WebM but rejects it in MP4 and TS", () => {
		const plan = basePlan();
		plan.renditions = [
			encodingPlanSchema.shape.renditions.element.parse({
				key: "av1",
				codec: "AV1",
				ingestKey: "video",
				height: 360,
				bitrate: 600000,
			}),
		];
		const muxing = encodingPlanSchema.shape.muxings.element;
		// Valid containers: fMP4 (CMAF) + WebM.
		plan.muxings = [
			muxing.parse({
				key: "av1-fmp4",
				kind: "FMP4",
				streamKey: "av1",
				destination: { outputKey: "out", path: "x/video/fmp4" },
			}),
			muxing.parse({
				key: "av1-webm",
				kind: "WEBM",
				streamKey: "av1",
				destination: { outputKey: "out", path: "x/video/webm" },
			}),
		];
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_MUXING_CODEC_MISMATCH"),
		).toHaveLength(0);

		// Invalid containers: MP4 + TS each fire a mismatch.
		plan.muxings.push(
			muxing.parse({
				key: "av1-mp4",
				kind: "MP4",
				streamKey: "av1",
				filename: "av1.mp4",
				destination: { outputKey: "out", path: "x/video/mp4" },
			}),
			muxing.parse({
				key: "av1-ts",
				kind: "TS",
				streamKey: "av1",
				destination: { outputKey: "out", path: "x/video/ts" },
			}),
		);
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_MUXING_CODEC_MISMATCH"),
		).toHaveLength(2);
	});

	it("DASH zero-rep check honors pinned legs and per-title expansion", () => {
		// WebM-pinned DASH video with a per-title VP9 rendition is valid
		// even though no static FMP4 video muxing exists.
		const plan = basePlan();
		plan.renditions = [
			encodingPlanSchema.shape.renditions.element.parse({
				key: "vp9",
				codec: "VP9",
				ingestKey: "video",
				height: 360,
				bitrate: null,
				mode: "PER_TITLE_TEMPLATE",
			}),
		];
		plan.muxings = [
			{
				key: "vp9",
				kind: "WEBM",
				streamKey: "vp9",
				segmentLength: 6,
				segmentNaming: "seg_%number%.chk",
				initSegmentName: "init.hdr",
				destination: { outputKey: "out", path: "x/video/{bitrate}_{uuid}/" },
			},
		];
		plan.perTitle = { vp9Configuration: { targetQualityCrf: 18 } };
		plan.generation.timing = "POST_ENCODING";
		plan.manifests.push({
			key: "dash",
			kind: "DASH",
			manifestName: "stream.mpd",
			name: "DASH Manifest",
			destination: { outputKey: "out", path: "x/" },
			audioLanguage: "en",
			representationType: "TEMPLATE",
			videoMuxingKind: "WEBM",
		});
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DASH_NO_REPRESENTATIONS"),
		).toBe(false);

		/*
		 * The same manifest WITHOUT per-title (STANDARD VP9) now SELECTS the
		 * WebM leg statically. This arm used to assert the opposite — "selects
		 * nothing statically, the rail must fire" — which was paid audit
		 * 893eb66 CRITICAL-2 written down as expected behaviour: the schema
		 * admitted `videoMuxingKind: "WEBM"`, the compiler's video selection
		 * hard-coded FMP4, and case 8's MPD shipped with four WebM ladders
		 * missing. A test can pin a defect as faithfully as a fix.
		 */
		const fixed = structuredClone(plan);
		const vp9 = fixed.renditions.at(0);
		if (vp9?.codec !== "VP9") {
			throw new Error("fixture is missing the vp9 rendition");
		}
		vp9.mode = "STANDARD";
		fixed.perTitle = undefined;
		const fixedMuxing = fixed.muxings.at(0);
		if (!fixedMuxing?.destination) {
			throw new Error("fixture muxing has no destination");
		}
		fixedMuxing.destination.path = "x/video/fixed";
		const fixedCodes = validatePlan(fixed).map((i) => i.code);
		expect(fixedCodes).not.toContain("PLAN_DASH_NO_REPRESENTATIONS");
		expect(fixedCodes).not.toContain("PLAN_DASH_VIDEO_UNSELECTED");
		// And the case-8 shape itself: the leg is WebM but the manifest does
		// not say so (FMP4 by default), so every video rep drops out. Both the
		// zero-total rail and the new video-specific one fire — the second is
		// the one that says WHICH field to fix.
		const mismatched = structuredClone(fixed);
		const dash = mismatched.manifests.find((m) => m.kind === "DASH");
		if (dash?.kind !== "DASH") {
			throw new Error("fixture is missing the DASH manifest");
		}
		dash.videoMuxingKind = undefined;
		const mismatchedCodes = validatePlan(mismatched).map((i) => i.code);
		expect(mismatchedCodes).toContain("PLAN_DASH_VIDEO_UNSELECTED");
		expect(mismatchedCodes).toContain("PLAN_DASH_NO_REPRESENTATIONS");
	});

	it("warns on an unused perTitle configuration", () => {
		const plan = basePlan();
		plan.perTitle = { h264Configuration: { targetQualityCrf: 17 } };
		const issues = validatePlan(plan);
		const unused = issues.find(
			(i) => i.code === "PLAN_PER_TITLE_CONFIG_UNUSED",
		);
		expect(unused?.level).toBe("warning");
		expect(planHasErrors(issues)).toBe(false);
	});

	function drmPlan() {
		const plan = basePlan();
		const muxing = plan.muxings.at(0);
		if (!muxing) {
			throw new Error("fixture is missing the muxing");
		}
		muxing.destination = undefined;
		plan.drm.push({
			key: "v-cenc",
			kind: "CENC",
			muxingKey: "v",
			credentialId: "00000000-0000-4000-8000-000000000005",
			kid: "43214321432143214321432143214321",
			ivSize: "IV_8_BYTES",
			widevine: { pssh: "cGFzc3RocnU=" },
			destination: { outputKey: "out", path: "x/video/1080p" },
		});
		return plan;
	}

	it("passes a coherent DRM plan (muxing output carried by the DRM)", () => {
		expect(validatePlan(drmPlan())).toEqual([]);
	});

	it("C9: CENC iv size must match the encryption mode", () => {
		const cbcWrong = drmPlan();
		const drm = cbcWrong.drm.at(0);
		if (drm?.kind !== "CENC") {
			throw new Error("fixture is missing the cenc drm");
		}
		drm.encryptionMode = "CBC"; // with IV_8_BYTES → violation
		expect(validatePlan(cbcWrong).filter((i) => i.code === "C9")).toHaveLength(
			1,
		);
		drm.ivSize = "IV_16_BYTES";
		expect(validatePlan(cbcWrong).some((i) => i.code === "C9")).toBe(false);
	});

	it("rejects DRM on incompatible containers and unresolved refs", () => {
		const plan = drmPlan();
		plan.drm.push({
			key: "bad-fp",
			kind: "FAIRPLAY",
			muxingKey: "ghost",
			credentialId: "00000000-0000-4000-8000-000000000005",
			iv: "00000000000000000000000000000000",
			uri: "skd://x",
			destination: { outputKey: "missing", path: "x/hls" },
		});
		const codes = validatePlan(plan).map((i) => i.code);
		expect(
			codes.filter((c) => c === "PLAN_UNRESOLVED_REF").length,
		).toBeGreaterThanOrEqual(2); // unknown muxing + unknown output

		const tsCenc = drmPlan();
		tsCenc.muxings.push({
			key: "v-ts",
			kind: "TS",
			streamKey: "v",
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
			destination: { outputKey: "out", path: "x/ts" },
		});
		const cencDrm = tsCenc.drm.at(0);
		if (cencDrm?.kind !== "CENC") {
			throw new Error("fixture is missing the cenc drm");
		}
		cencDrm.muxingKey = "v-ts"; // CENC cannot encrypt TS
		expect(
			validatePlan(tsCenc).some((i) => i.code === "PLAN_DRM_MUXING_MISMATCH"),
		).toBe(true);
	});

	it("rejects manifests whose pinned drmKind misses a selected muxing", () => {
		const plan = drmPlan();
		plan.manifests.push({
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS Manifest",
			destination: { outputKey: "out", path: "x/" },
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
			perTitleVariantUri: "AVG_BITRATE",
			drmKind: "FAIRPLAY", // only CENC exists on the muxing
		});
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "PLAN_DRM_KIND_UNMATCHED")).toBe(true);
		// Pinning the kind that exists passes.
		const manifest = plan.manifests.at(0);
		if (manifest?.kind !== "HLS") {
			throw new Error("fixture is missing the manifest");
		}
		manifest.drmKind = "CENC";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DRM_KIND_UNMATCHED"),
		).toBe(false);
	});

	it("rejects destination-less muxings with no DRM output", () => {
		const plan = drmPlan();
		plan.drm = [];
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "PLAN_MUXING_NO_OUTPUT")).toBe(true);
		expect(planHasErrors(issues)).toBe(true);
	});

	it("rejects DASH manifests that would hold zero representations", () => {
		const plan = basePlan();
		const fmp4 = plan.muxings.at(0);
		if (!fmp4) {
			throw new Error("fixture is missing the muxing");
		}
		// MP4 byte-range is an HLS-only path — a DASH manifest over it is empty.
		plan.muxings = [
			{
				key: "v-mp4",
				kind: "MP4",
				streamKey: "v",
				filename: "video_360p.mp4",
				fragmentDuration: 4000,
				manifestType: "HLS_BYTE_RANGES",
				destination: { outputKey: "out", path: "x/video/360p" },
			},
		];
		plan.manifests.push({
			key: "dash",
			kind: "DASH",
			manifestName: "stream.mpd",
			name: "DASH Manifest",
			destination: { outputKey: "out", path: "x/" },
			audioLanguage: "en",
			representationType: "TEMPLATE",
		});
		const issues = validatePlan(plan);
		expect(issues.some((i) => i.code === "PLAN_DASH_NO_REPRESENTATIONS")).toBe(
			true,
		);
		expect(planHasErrors(issues)).toBe(true);
		// The same plan with the fMP4 muxing back is representable.
		plan.muxings = [fmp4];
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DASH_NO_REPRESENTATIONS"),
		).toBe(false);
	});

	it("rejects duplicate filter attachments and positions per rendition", () => {
		const plan = basePlan();
		plan.filters.push(
			{
				key: "deint",
				kind: "DEINTERLACE",
				parity: "AUTO",
				mode: "FRAME",
				frameSelectionMode: "ALL",
				autoEnable: "META_DATA_AND_CONTENT_BASED",
			},
			{
				key: "deint2",
				kind: "DEINTERLACE",
				parity: "AUTO",
				mode: "FRAME",
				frameSelectionMode: "ALL",
				autoEnable: "META_DATA_AND_CONTENT_BASED",
			},
		);
		const video = plan.renditions.at(0);
		if (video?.codec !== "H264") {
			throw new Error("fixture is missing the video rendition");
		}
		// Same filter twice (step-id collision) AND same position twice.
		video.filters = [
			{ filterKey: "deint", position: 0 },
			{ filterKey: "deint", position: 0 },
			{ filterKey: "deint2", position: 0 },
		];
		const codes = validatePlan(plan).map((i) => i.code);
		expect(codes).toContain("PLAN_DUPLICATE_FILTER_ATTACHMENT");
		expect(
			codes.filter((c) => c === "PLAN_DUPLICATE_FILTER_POSITION"),
		).toHaveLength(2);
	});

	it("warns on declared-but-unattached filters", () => {
		const plan = basePlan();
		plan.filters.push({
			key: "orphan",
			kind: "DEINTERLACE",
			parity: "AUTO",
			mode: "FRAME",
			frameSelectionMode: "ALL",
			autoEnable: "META_DATA_AND_CONTENT_BASED",
		});
		const issues = validatePlan(plan);
		const orphan = issues.find((i) => i.code === "PLAN_UNATTACHED_FILTER");
		expect(orphan?.level).toBe("warning");
		expect(planHasErrors(issues)).toBe(false);
	});

	it("warns on duplicate keyframe cue times", () => {
		const plan = basePlan();
		plan.keyframes.push({ key: "ad1", time: 19.2 }, { key: "ad2", time: 19.2 });
		const issues = validatePlan(plan);
		const dup = issues.find((i) => i.code === "PLAN_DUPLICATE_KEYFRAME_TIME");
		expect(dup?.level).toBe("warning");
		expect(planHasErrors(issues)).toBe(false);
	});

	it("rejects unresolved filter references", () => {
		const plan = basePlan();
		const video = plan.renditions.at(0);
		if (video?.codec !== "H264") {
			throw new Error("fixture is missing the video rendition");
		}
		video.filters = [{ filterKey: "ghost", position: 0 }];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) =>
					i.code === "PLAN_UNRESOLVED_REF" &&
					i.path === "renditions[0].filters[0].filterKey",
			),
		).toBe(true);
		// Declaring the filter resolves it.
		plan.filters.push({
			key: "ghost",
			kind: "DEINTERLACE",
			parity: "AUTO",
			mode: "FRAME",
			frameSelectionMode: "ALL",
			autoEnable: "META_DATA_AND_CONTENT_BASED",
		});
		expect(validatePlan(plan)).toEqual([]);
	});

	it("rejects ingest/fileStream key collisions (shared namespace)", () => {
		const plan = vttPlan();
		const file = plan.fileStreams.at(0);
		if (!file) {
			throw new Error("fixture is missing the file stream");
		}
		file.key = "video"; // collides with the ingest track key
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DUPLICATE_KEY"),
		).toBe(true);
	});
});

describe("multi-encoding partition rails", () => {
	function multiPlan() {
		return encodingPlanSchema.parse({
			planVersion: 1,
			name: "multi",
			bitmovin: {},
			encodings: [
				{ key: "dv", name: "multi-dv" },
				{ key: "sdr", name: "multi-sdr" },
			],
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video-dv",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
					encodingKey: "dv",
				},
				{
					key: "video-sdr",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
					encodingKey: "sdr",
				},
			],
			renditions: [
				{
					key: "v-dv",
					codec: "H264",
					ingestKey: "video-dv",
					height: 360,
					bitrate: 300000,
					encodingKey: "dv",
				},
				{
					key: "v-sdr",
					codec: "H264",
					ingestKey: "video-sdr",
					height: 360,
					bitrate: 300000,
					encodingKey: "sdr",
				},
			],
			muxings: [
				{
					key: "v-dv",
					kind: "FMP4",
					streamKey: "v-dv",
					destination: { outputKey: "out", path: "x/dv" },
				},
				{
					key: "v-sdr",
					kind: "FMP4",
					streamKey: "v-sdr",
					destination: { outputKey: "out", path: "x/sdr" },
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		});
	}

	it("accepts a partition whose sources stay encoding-local", () => {
		expect(validatePlan(multiPlan())).toEqual([]);
	});

	it("rejects renditions consuming a source from another encoding", () => {
		const plan = multiPlan();
		const rendition = plan.renditions.at(1);
		if (!rendition) {
			throw new Error("fixture is missing the second rendition");
		}
		rendition.ingestKey = "video-dv"; // owned by encoding "dv", rendition is "sdr"
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_ENCODING_SOURCE_MISMATCH" &&
					i.path === "renditions[1].ingestKey",
			),
		).toBe(true);
	});

	it("rejects metadata sidecars attached across encodings", () => {
		const plan = multiPlan();
		plan.dolbyStreams.push(
			{
				key: "dv-src",
				kind: "VISION",
				inputKey: "in",
				videoInputPath: "v.mxf",
				encodingKey: "dv",
			},
			{
				key: "dv-meta",
				kind: "VISION_METADATA",
				inputKey: "in",
				inputPath: "meta.xml",
				encodingKey: "sdr", // wrong owner
			},
		);
		plan.renditions.push({
			key: "v-dv-meta",
			codec: "H265",
			ingestKey: "dv-src",
			height: 1080,
			bitrate: 2000000,
			encodingKey: "dv",
			dolbyVisionMetadata: {
				profile: "DVHE_05",
				metadataSource: "INPUT_STREAM",
				metadataStreamKey: "dv-meta",
			},
		} as (typeof plan.renditions)[number]);
		plan.muxings.push({
			key: "v-dv-meta",
			kind: "FMP4",
			streamKey: "v-dv-meta",
			destination: { outputKey: "out", path: "x/dv-meta" },
		} as (typeof plan.muxings)[number]);
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_ENCODING_SOURCE_MISMATCH" &&
					i.path === "renditions[2].dolbyVisionMetadata.metadataStreamKey",
			),
		).toBe(true);
	});

	it("rejects JIT generation on multi-encoding plans", () => {
		const plan = multiPlan();
		plan.generation.timing = "JUST_IN_TIME";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_MULTI_ENCODING_JIT"),
		).toBe(true);
	});

	it("rejects tweaks.audioVideoSyncMode combined with Dolby audio codecs", () => {
		const plan = basePlan();
		plan.generation.audioVideoSyncMode = "RESYNC_AT_START";
		// No Dolby rendition yet — the tweak alone is fine.
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_TWEAKS_DOLBY_CONFLICT"),
		).toBe(false);
		plan.renditions.push({
			key: "atmos",
			codec: "DDPLUS",
			ingestKey: "audio",
			bitrate: 448000,
		} as (typeof plan.renditions)[number]);
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_TWEAKS_DOLBY_CONFLICT" &&
					i.path === "generation.audioVideoSyncMode",
			),
		).toBe(true);
	});

	it("requires cloudRegion EXTERNAL when infrastructure is set (C18)", () => {
		const plan = basePlan();
		plan.bitmovin.infrastructure = {
			infrastructureId: "infra-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
		};
		// basePlan defaults cloudRegion to AUTO — must fail.
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION" &&
					i.path === "bitmovin.cloudRegion" &&
					i.level === "error",
			),
		).toBe(true);
		plan.bitmovin.cloudRegion = "EXTERNAL";
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
			),
		).toBe(false);
	});

	describe("secret-egress URLs are https-only", () => {
		/**
		 * kantar.serverUrl RECEIVES the vaulted Kantar pair, so plain http would
		 * put credentials on the wire in cleartext — no attacker needed, a
		 * copy-pasted plan or a vendor doc showing http is enough.
		 */
		function parseWithServerUrl(serverUrl: string) {
			const plan = basePlan();
			return encodingPlanSchema.safeParse({
				...plan,
				kantar: {
					credentialId: "00000000-0000-4000-8000-0000000000b1",
					licenseId: 4711,
					channelName: "Demo",
					contentReference: "ep01",
					serverUrl,
					reportDestination: { outputKey: "out", path: "reports" },
				},
			});
		}

		it("accepts https", () => {
			expect(
				parseWithServerUrl("https://kantar.example.com/watermark").success,
			).toBe(true);
		});

		it("REJECTS http", () => {
			const result = parseWithServerUrl("http://kantar.example.com/watermark");
			expect(result.success).toBe(false);
			if (!result.success) {
				// Assert the message ON THE FIELD'S OWN PATH — a bare
				// JSON.stringify match would pass if "https" showed up in any
				// unrelated issue (review nit).
				const issue = result.error.issues.find(
					(i) => i.path.join(".") === "kantar.serverUrl",
				);
				expect(issue?.message).toMatch(/https/i);
			}
		});

		it("REJECTS credentials embedded in the URL (user:pass@host)", () => {
			// Plans are persisted RAW because they are secret-free by
			// construction; userinfo here would put a password in the job row,
			// saved presets, the diff panel and the template export.
			const result = parseWithServerUrl(
				"https://kantar-user:s3cr3t@kantar.example.com/watermark",
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				const issue = result.error.issues.find(
					(i) => i.path.join(".") === "kantar.serverUrl",
				);
				expect(issue?.message).toMatch(/credentials in the URL/i);
			}
		});

		it("accepts a userinfo-free https URL with a port and query", () => {
			expect(
				parseWithServerUrl("https://kantar.example.com:8443/wm?tenant=jp")
					.success,
			).toBe(true);
		});

		it("rejects a non-URL string", () => {
			expect(parseWithServerUrl("kantar.example.com/watermark").success).toBe(
				false,
			);
		});
	});

	describe("Kantar audio watermarking rails (P5 PR-4)", () => {
		function kantarPlan() {
			const plan = basePlan();
			// basePlan is video-only; Kantar watermarks AUDIO, so the happy
			// path needs an audio rendition (the rail below proves the
			// video-only case is rejected).
			plan.renditions.push({
				key: "a128",
				codec: "AAC",
				ingestKey: "video",
				bitrate: 128000,
			} as (typeof plan.renditions)[number]);
			// …and that audio has to be PACKAGED. This plan left it unmuxed,
			// which the unmuxed rail now refuses as an error :
			// a watermarked track that reaches no container is encoded, billed
			// and delivered to nobody. Packaging it keeps this suite about the
			// Kantar rails, which is what it is for.
			plan.muxings.push({
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "out", path: "audio/128000" },
			} as (typeof plan.muxings)[number]);
			plan.kantar = {
				credentialId: "00000000-0000-4000-8000-0000000000b1",
				licenseId: 4711,
				channelName: "Demo",
				contentReference: "ep01",
				serverUrl: "https://kantar.example.com/watermark",
				reportDestination: { outputKey: "out", path: "reports" },
			};
			return plan;
		}

		it("passes when the report output resolves and audio exists", () => {
			expect(
				validatePlan(kantarPlan()).filter((i) => i.level === "error"),
			).toEqual([]);
		});

		it("rejects an unresolved report output", () => {
			const plan = kantarPlan();
			if (!plan.kantar) {
				throw new Error("kantar set above");
			}
			plan.kantar.reportDestination.outputKey = "ghost";
			expect(
				validatePlan(plan).some(
					(i) =>
						i.code === "PLAN_UNRESOLVED_REF" &&
						i.path === "kantar.reportDestination.outputKey",
				),
			).toBe(true);
		});

		it("rejects a video-only plan — an audio watermark needs audio", () => {
			const plan = kantarPlan();
			plan.renditions = plan.renditions.filter(
				(r) => r.codec !== "AAC" && r.codec !== "DDPLUS" && r.codec !== "DD",
			);
			const issue = validatePlan(plan).find(
				(i) => i.code === "PLAN_KANTAR_NEEDS_AUDIO",
			);
			expect(issue?.level).toBe("error");
			expect(issue?.path).toBe("kantar");
		});
	});

	it("rejects EXTERNAL without an infrastructure block (C18 inverse)", () => {
		// The wizard's fill-then-clear path leaves cloudRegion EXTERNAL with
		// infrastructure undefined; imported plans can carry it too.
		const plan = basePlan();
		plan.bitmovin.cloudRegion = "EXTERNAL";
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE" &&
					i.path === "bitmovin.cloudRegion" &&
					i.level === "error",
			),
		).toBe(true);
		plan.bitmovin.infrastructure = {
			infrastructureId: "infra-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
		};
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE",
			),
		).toBe(false);
	});

	it("rejects per-encoding region overrides that break the EXTERNAL contract", () => {
		const plan = multiPlan();
		plan.bitmovin.cloudRegion = "EXTERNAL";
		plan.bitmovin.infrastructure = {
			infrastructureId: "infra-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
		};
		const enc = plan.encodings?.[0];
		if (!enc) {
			throw new Error("multiPlan carries encodings");
		}
		enc.cloudRegion = "AWS_EU_WEST_1";
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION" &&
					i.path === "encodings[0].cloudRegion",
			),
		).toBe(true);
	});

	it("warns on preview-only manifests (generated but never finalized)", () => {
		const plan = basePlan();
		plan.generation.timing = "JUST_IN_TIME";
		const preview = {
			key: "preview-hls",
			kind: "HLS",
			jitPlacement: "PREVIEW",
			destination: { outputKey: "out", path: "x/preview" },
		} as (typeof plan.manifests)[number];
		plan.manifests.push(preview);
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_PREVIEW_ONLY_MANIFEST" && i.level === "warning",
			),
		).toBe(true);
		// VOD_AND_PREVIEW keeps the final manifest — no warning.
		(preview as { jitPlacement?: string }).jitPlacement = "VOD_AND_PREVIEW";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_PREVIEW_ONLY_MANIFEST"),
		).toBe(false);
	});

	it("rejects preview manifest placement on POST_ENCODING plans", () => {
		const plan = basePlan();
		plan.manifests.push({
			key: "preview-hls",
			kind: "HLS",
			jitPlacement: "PREVIEW",
			destination: { outputKey: "out", path: "x/preview" },
		} as (typeof plan.manifests)[number]);
		plan.generation.timing = "JUST_IN_TIME";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_PREVIEW_REQUIRES_JIT"),
		).toBe(false);
		plan.generation.timing = "POST_ENCODING";
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_PREVIEW_REQUIRES_JIT" &&
					i.path.startsWith("manifests["),
			),
		).toBe(true);
	});

	it("rejects per-title combined with multi-encoding", () => {
		const plan = multiPlan();
		plan.perTitle = {
			h264Configuration: { autoRepresentations: {} },
		} as typeof plan.perTitle;
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_MULTI_ENCODING_PER_TITLE",
			),
		).toBe(true);
	});

	it("rejects AI Scene Analysis combined with multi-encoding", () => {
		const plan = multiPlan();
		plan.aiSceneAnalysis = {
			assetDescription: {
				filename: "out.json",
				destination: { outputKey: "out", path: "x/ai" },
			},
		} as typeof plan.aiSceneAnalysis;
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_MULTI_ENCODING_AISA"),
		).toBe(true);
	});

	it("bounds the NexGuard NGPR payload ID to the SDK's documented 1..4,194,303 (ledger #159)", () => {
		const base = {
			credentialId: "3e6ffbdd-3e6f-4bdd-8e6f-fbdd3e6f4bdd",
			watermarkType: "OTT",
			preset: "p1",
		};
		expect(nexGuardSchema.safeParse({ ...base, payload: 1 }).success).toBe(
			true,
		);
		expect(
			nexGuardSchema.safeParse({ ...base, payload: 4_194_303 }).success,
		).toBe(true);
		expect(nexGuardSchema.safeParse({ ...base, payload: 0 }).success).toBe(
			false,
		);
		expect(
			nexGuardSchema.safeParse({ ...base, payload: 4_194_304 }).success,
		).toBe(false);
		expect(nexGuardSchema.safeParse({ ...base, payload: 1.5 }).success).toBe(
			false,
		);
	});

	it("caps AISA outputLanguageCodes at 3 — COVERAGE §9's ≤3, enforced at the schema (2026-08-22 census find)", () => {
		const aisa = (codes: string[]) => ({
			...basePlan(),
			aiSceneAnalysis: {
				assetDescription: {
					filename: "out.json",
					destination: { outputKey: "out", path: "x/ai" },
				},
				outputLanguageCodes: codes,
			},
		});
		expect(encodingPlanSchema.safeParse(aisa(["en", "ja", "de"])).success).toBe(
			true,
		);
		expect(
			encodingPlanSchema.safeParse(aisa(["en", "ja", "de", "fr"])).success,
		).toBe(false);
	});

	it("rejects resources without encodingKey in multi mode", () => {
		const plan = multiPlan();
		const rendition = plan.renditions.at(0);
		if (!rendition) {
			throw new Error("fixture is missing the first rendition");
		}
		rendition.encodingKey = undefined;
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_UNRESOLVED_REF" &&
					i.path === "renditions[0].encodingKey",
			),
		).toBe(true);
	});

	it("rejects encodingKey when the plan declares no encodings", () => {
		const plan = multiPlan();
		plan.encodings = undefined;
		plan.generation.timing = "JUST_IN_TIME";
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_UNRESOLVED_REF" &&
					i.path === "ingest[0].encodingKey",
			),
		).toBe(true);
	});
});

describe("dolbyVisionMetadata schema refinement", () => {
	function planWith(metadata: Record<string, unknown>) {
		return {
			planVersion: 1,
			name: "dv",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			dolbyStreams: [
				{ key: "dv-src", kind: "VISION", inputKey: "in", videoInputPath: "v" },
				{
					key: "dv-meta",
					kind: "VISION_METADATA",
					inputKey: "in",
					inputPath: "m",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H265",
					ingestKey: "dv-src",
					height: 1080,
					bitrate: 2000000,
					dolbyVisionMetadata: metadata,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x" },
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		};
	}

	it("rejects INPUT_STREAM without metadataStreamKey", () => {
		const result = encodingPlanSchema.safeParse(
			planWith({ profile: "DVHE_05", metadataSource: "INPUT_STREAM" }),
		);
		expect(result.success).toBe(false);
	});

	it("rejects EMBEDDED with metadataStreamKey", () => {
		const result = encodingPlanSchema.safeParse(
			planWith({
				profile: "DVHE_05",
				metadataSource: "EMBEDDED",
				metadataStreamKey: "dv-meta",
			}),
		);
		expect(result.success).toBe(false);
	});

	it("accepts the two valid source shapes", () => {
		expect(
			encodingPlanSchema.safeParse(
				planWith({
					profile: "DVHE_05",
					metadataSource: "INPUT_STREAM",
					metadataStreamKey: "dv-meta",
				}),
			).success,
		).toBe(true);
		expect(
			encodingPlanSchema.safeParse(
				planWith({ profile: "DVHE_05", metadataSource: "EMBEDDED" }),
			).success,
		).toBe(true);
	});
});

describe("dolby stream-source matrix", () => {
	function dolbyPlan() {
		return encodingPlanSchema.parse({
			planVersion: 1,
			name: "dolby-matrix",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "audio-pcm",
					inputKey: "in",
					inputPath: "a.mov",
					selectionMode: "AUDIO_RELATIVE",
				},
			],
			dolbyStreams: [
				{
					key: "atmos-src",
					kind: "ATMOS",
					inputKey: "in",
					inputPath: "a.atmos",
					inputFormat: "DAMF",
				},
				{ key: "dv-src", kind: "VISION", inputKey: "in", videoInputPath: "v" },
				{
					key: "dv-meta",
					kind: "VISION_METADATA",
					inputKey: "in",
					inputPath: "m.xml",
				},
			],
			renditions: [
				{
					key: "atmos",
					codec: "DOLBY_ATMOS",
					ingestKey: "atmos-src",
					bitrate: 448000,
					rate: 48000,
					loudnessControl: {
						meteringMode: "ITU_R_BS_1770_4",
						dialogueIntelligence: "ENABLED",
						speechThreshold: 15,
					},
				},
				{
					key: "v",
					codec: "H265",
					ingestKey: "dv-src",
					height: 1080,
					bitrate: 2000000,
				},
			],
			muxings: [
				{
					key: "atmos",
					kind: "FMP4",
					streamKey: "atmos",
					destination: { outputKey: "out", path: "x/atmos" },
				},
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/v" },
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		});
	}

	it("accepts the canonical pairings", () => {
		expect(validatePlan(dolbyPlan())).toEqual([]);
	});

	it("rejects non-atmos codecs consuming an ATMOS stream", () => {
		const plan = dolbyPlan();
		const video = plan.renditions.find((r) => r.codec === "H265");
		if (!video) {
			throw new Error("fixture is missing the video rendition");
		}
		video.ingestKey = "atmos-src";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH"),
		).toBe(true);
	});

	it("rejects DOLBY_ATMOS consuming a VISION stream or plain ingest", () => {
		const fromVision = dolbyPlan();
		const atmos1 = fromVision.renditions.find((r) => r.codec === "DOLBY_ATMOS");
		if (!atmos1) {
			throw new Error("fixture is missing the atmos rendition");
		}
		atmos1.ingestKey = "dv-src";
		expect(
			validatePlan(fromVision).some(
				(i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH",
			),
		).toBe(true);

		const fromIngest = dolbyPlan();
		const atmos2 = fromIngest.renditions.find((r) => r.codec === "DOLBY_ATMOS");
		if (!atmos2) {
			throw new Error("fixture is missing the atmos rendition");
		}
		atmos2.ingestKey = "audio-pcm";
		expect(
			validatePlan(fromIngest).some(
				(i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH",
			),
		).toBe(true);
	});

	it("rejects renditions consuming a VISION_METADATA sidecar directly", () => {
		const plan = dolbyPlan();
		const video = plan.renditions.find((r) => r.codec === "H265");
		if (!video) {
			throw new Error("fixture is missing the video rendition");
		}
		video.ingestKey = "dv-meta";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_STREAM_SOURCE_MISMATCH"),
		).toBe(true);
	});
});

describe("HLS variant-group and DASH set rails", () => {
	function groupPlan() {
		return encodingPlanSchema.parse({
			planVersion: 1,
			name: "groups",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
				{
					key: "audio",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "AUDIO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
					hlsVariantLabel: "h264",
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
					hlsMedia: {
						groupId: "aac",
						name: "AAC Media",
						uri: "audio_aac.m3u8",
					},
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/v" },
				},
				{
					key: "a",
					kind: "FMP4",
					streamKey: "a",
					destination: { outputKey: "out", path: "x/a" },
				},
			],
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					manifestName: "stream.m3u8",
					name: "HLS Manifest",
					destination: { outputKey: "out", path: "x/" },
					audioGroupId: "aac",
					audioLanguage: "en",
					closedCaptions: "NONE",
					perTitleVariantUri: "AVG_BITRATE",
					variantsPerAudioGroup: true,
					iframePlaylists: true,
				},
			],
			generation: { timing: "POST_ENCODING" },
		});
	}

	it("accepts a complete variant-group plan", () => {
		expect(validatePlan(groupPlan())).toEqual([]);
	});

	describe("HLS child URI uniqueness across manifests (#233)", () => {
		it.each([
			false,
			true,
		])("rejects an I-frame/audio write collision, reversed=%s", (reversed) => {
			const plan = groupPlan();
			const audio = plan.renditions.find((r) => r.codec === "AAC");
			const first = plan.manifests[0];
			if (!audio?.hlsMedia || first?.kind !== "HLS") throw new Error("fixture");
			const uri = "video_h264_360p_300000_iframe.m3u8";
			audio.hlsMedia.uri = uri;
			first.audioMuxingKind = "TS";
			first.videoMuxingKind = "FMP4";
			plan.manifests.push({
				...first,
				key: "audio-only",
				manifestName: "audio.m3u8",
				audioMuxingKind: "FMP4",
				videoMuxingKind: "TS",
				iframePlaylists: false,
			});
			if (reversed) plan.manifests.reverse();
			const writes = compilePlan(plan).filter(
				(op) =>
					(op.kind === "CREATE_HLS_IFRAME_PLAYLIST" &&
						(op.payload as { filename?: string }).filename === uri) ||
					(op.kind === "CREATE_HLS_AUDIO_MEDIA" &&
						(op.payload as { uri?: string }).uri === uri),
			);
			expect(writes).toHaveLength(2);
			expect(
				validatePlan(plan).filter(
					(i) => i.code === "PLAN_HLS_MEDIA_URI_COLLISION",
				),
			).toEqual([
				expect.objectContaining({ level: "error", path: "manifests[1]" }),
			]);
		});

		function sharedDestination(family: "audio" | "video" = "audio") {
			const plan = groupPlan();
			const key = family === "audio" ? "a" : "v";
			plan.renditions = plan.renditions.filter((r) => r.key === key);
			plan.muxings = plan.muxings.filter((m) => m.streamKey === key);
			const leg = plan.muxings[0];
			if (!leg) throw new Error("muxing fixture required");
			plan.muxings.push(
				planMuxingSchema.parse({
					key: `${key}-ts`,
					kind: "TS",
					streamKey: key,
					destination: leg.destination,
				}),
			);
			const manifest = plan.manifests[0];
			if (manifest?.kind !== "HLS") throw new Error("HLS fixture required");
			manifest.variantsPerAudioGroup = false;
			manifest.iframePlaylists = false;
			manifest.audioMuxingKind = "FMP4";
			manifest.videoMuxingKind = "FMP4";
			plan.manifests.push({
				...manifest,
				key: "hls-ts",
				manifestName: "ts.m3u8",
				audioMuxingKind: "TS",
				videoMuxingKind: "TS",
			});
			return encodingPlanSchema.parse(plan);
		}

		const collisions = (plan: ReturnType<typeof groupPlan>) =>
			validatePlan(encodingPlanSchema.parse(plan)).filter(
				(i) => i.code === "PLAN_HLS_MEDIA_URI_COLLISION",
			);

		it.each([
			"audio",
			"video",
		] as const)("rejects %s children on different legs despite distinct master names", (family) => {
			const issues = collisions(sharedDestination(family));
			expect(issues).toHaveLength(1);
			expect(issues[0]).toMatchObject({
				level: "error",
				path: "manifests[1]",
			});
			expect(issues[0]?.message).toContain('"hls"');
			expect(issues[0]?.message).toContain('"hls-ts"');
		});

		it("does not infer safe sharing from the same muxing leg", () => {
			const plan = sharedDestination();
			const second = plan.manifests[1];
			if (second?.kind !== "HLS") throw new Error("HLS fixture required");
			second.audioMuxingKind = "FMP4";
			second.mediaVersion = "HLS_V7";
			expect(collisions(plan)).toHaveLength(1);
		});

		it.each([
			"path",
			"outputKey",
		] as const)("allows the same URI at a different destination %s", (field) => {
			const plan = sharedDestination();
			const output = plan.outputs[0];
			const second = plan.manifests[1];
			if (output?.kind !== "S3" || !second) throw new Error("fixture required");
			plan.outputs.push({ ...output, key: "out2", bucket: "b2" });
			second.destination = {
				...second.destination,
				[field]: field === "path" ? "other/" : "out2",
			};
			expect(planHasErrors(validatePlan(encodingPlanSchema.parse(plan)))).toBe(
				false,
			);
			expect(collisions(plan)).toEqual([]);
		});

		it("allows distinct audio child URIs in the same destination", () => {
			const plan = sharedDestination();
			const audio = plan.renditions[0];
			if (audio?.codec !== "AAC") throw new Error("AAC fixture required");
			audio.hlsMedia = undefined;
			for (const manifest of plan.manifests) {
				if (manifest.kind === "HLS") {
					manifest.audioMediaUri = `${manifest.key}-audio.m3u8`;
				}
			}
			expect(validatePlan(encodingPlanSchema.parse(plan))).toEqual([]);
		});
	});

	it("rejects iframePlaylists without variantsPerAudioGroup", () => {
		const plan = groupPlan();
		const manifest = plan.manifests.at(0);
		if (manifest?.kind !== "HLS") {
			throw new Error("fixture is missing the HLS manifest");
		}
		manifest.variantsPerAudioGroup = undefined;
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_HLS_IFRAME_WITHOUT_GROUPS",
			),
		).toBe(true);
	});

	it("rejects variant groups when renditions lack label or hlsMedia", () => {
		const noLabel = groupPlan();
		const video = noLabel.renditions.find((r) => r.codec === "H264");
		if (!video) {
			throw new Error("fixture is missing the video rendition");
		}
		video.hlsVariantLabel = undefined;
		expect(
			validatePlan(noLabel).some(
				(i) =>
					i.code === "PLAN_HLS_VARIANT_GROUP_INCOMPLETE" &&
					i.path === "renditions[0]",
			),
		).toBe(true);

		const noMedia = groupPlan();
		const audio = noMedia.renditions.find((r) => r.codec === "AAC");
		if (!audio) {
			throw new Error("fixture is missing the audio rendition");
		}
		audio.hlsMedia = undefined;
		expect(
			validatePlan(noMedia).some(
				(i) => i.code === "PLAN_HLS_VARIANT_GROUP_INCOMPLETE",
			),
		).toBe(true);
	});

	it("rejects variant groups with zero audio groups (empty master)", () => {
		const plan = groupPlan();
		// Drop the audio rendition + muxing entirely: video-only plan.
		plan.renditions = plan.renditions.filter((r) => r.codec !== "AAC");
		plan.muxings = plan.muxings.filter((m) => m.key !== "a");
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_HLS_VARIANT_GROUP_INCOMPLETE" &&
					i.path === "manifests[0].variantsPerAudioGroup",
			),
		).toBe(true);
	});

	describe("HLS audio media NAME/URI uniqueness (audit 893eb66 HIGH-8, ledger #201)", () => {
		function twoAudios(second: {
			name: string;
			uri: string;
			groupId?: string;
		}) {
			const plan = groupPlan();
			const a = plan.renditions.find((r) => r.key === "a");
			if (a?.codec !== "AAC") {
				throw new Error("fixture is missing the audio rendition");
			}
			plan.renditions.push({
				...a,
				key: "a2",
				bitrate: 64000,
				hlsMedia: {
					groupId: second.groupId ?? "aac",
					name: second.name,
					uri: second.uri,
				},
			});
			plan.muxings.push({
				key: "a2",
				kind: "FMP4",
				streamKey: "a2",
				destination: { outputKey: "out", path: "x/a2" },
			} as (typeof plan.muxings)[number]);
			return plan;
		}
		const codes = (plan: ReturnType<typeof groupPlan>) =>
			validatePlan(plan).map((i) => i.code);

		it("two explicit media entries sharing a NAME in one group is an error", () => {
			const plan = twoAudios({ name: "AAC Media", uri: "audio_aac2.m3u8" });
			expect(codes(plan)).toContain("PLAN_HLS_MEDIA_NAME_COLLISION");
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_URI_COLLISION");
		});

		it("two explicit media entries sharing a URI in one group is an error", () => {
			const plan = twoAudios({ name: "AAC Media 2", uri: "audio_aac.m3u8" });
			expect(codes(plan)).toContain("PLAN_HLS_MEDIA_URI_COLLISION");
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_NAME_COLLISION");
		});

		it("the same NAME in DIFFERENT groups is fine — uniqueness is per group", () => {
			const plan = twoAudios({
				name: "AAC Media",
				uri: "audio_aac2.m3u8",
				groupId: "atmos",
			});
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_NAME_COLLISION");
		});

		it("audioMediaUri with more than one defaulted audio is an error — one literal cannot name two playlists", () => {
			const plan = groupPlan();
			const a = plan.renditions.find((r) => r.key === "a");
			if (a?.codec !== "AAC") {
				throw new Error("fixture is missing the audio rendition");
			}
			// Both DEFAULTED: strip the explicit block from the first, add a second.
			a.hlsMedia = undefined;
			plan.renditions.push({ ...a, key: "a2", bitrate: 64000 });
			plan.muxings.push({
				key: "a2",
				kind: "FMP4",
				streamKey: "a2",
				destination: { outputKey: "out", path: "x/a2" },
			} as (typeof plan.muxings)[number]);
			const hls = plan.manifests.find((m) => m.kind === "HLS");
			if (hls?.kind !== "HLS") {
				throw new Error("fixture is missing the HLS manifest");
			}
			hls.audioMediaUri = "audio.m3u8";
			expect(codes(plan)).toContain("PLAN_HLS_AUDIO_MEDIA_URI_SHARED");
			// And the derivation itself does not collide — the override is
			// ignored for a shared group, so no URI collision is reported on top.
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_URI_COLLISION");
		});

		it("two DEFAULTED audios at distinct bitrates validate clean — defaults are unique by construction", () => {
			const plan = groupPlan();
			const a = plan.renditions.find((r) => r.key === "a");
			if (a?.codec !== "AAC") {
				throw new Error("fixture is missing the audio rendition");
			}
			a.hlsMedia = undefined;
			plan.renditions.push({ ...a, key: "a2", bitrate: 64000 });
			plan.muxings.push({
				key: "a2",
				kind: "FMP4",
				streamKey: "a2",
				destination: { outputKey: "out", path: "x/a2" },
			} as (typeof plan.muxings)[number]);
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_NAME_COLLISION");
			expect(codes(plan)).not.toContain("PLAN_HLS_MEDIA_URI_COLLISION");
		});
	});

	describe("mixed video codecs need a pinned encodingMode (audit 893eb66 HIGH-9, ledger #204)", () => {
		function mixed(encodingMode?: "TWO_PASS", secondEncoding?: string) {
			const plan = groupPlan();
			const v = plan.renditions.find((r) => r.key === "v");
			if (v?.codec !== "H264") {
				throw new Error("fixture is missing the video rendition");
			}
			plan.renditions.push({
				...v,
				key: "v-h265",
				codec: "H265",
				...(secondEncoding ? { encodingKey: secondEncoding } : {}),
			} as (typeof plan.renditions)[number]);
			plan.muxings.push({
				key: "v-h265",
				kind: "FMP4",
				streamKey: "v-h265",
				destination: { outputKey: "out", path: "x/v-h265" },
			} as (typeof plan.muxings)[number]);
			if (encodingMode) {
				plan.generation.encodingMode = encodingMode;
			}
			return plan;
		}
		const codes = (plan: ReturnType<typeof groupPlan>) =>
			validatePlan(plan).map((i) => i.code);

		it("H264 + H265 in one encoding with NO mode is an error", () => {
			// Case 10: every resource created, then START 400 "All encodingModes
			// … must be the same" — each codec's preset implied its own mode.
			expect(codes(mixed())).toContain(
				"PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS",
			);
		});

		it("a START pin does not cure conflicting presets", () => {
			expect(codes(mixed("TWO_PASS"))).toContain(
				"PLAN_ENCODING_MODE_PRESET_CONFLICT",
			);
		});
		it("an advanced mixed-codec plan without presets may pin a common START mode", () => {
			const plan = mixed("TWO_PASS");
			for (const r of plan.renditions) {
				if (r.codec === "H264") r.presetConfiguration = null;
				if (r.codec === "H265") delete r.presetConfiguration;
			}
			expect(encodingPlanSchema.safeParse(plan).success).toBe(true);
			expect(codes(plan)).not.toContain(
				"PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS",
			);
			expect(codes(plan)).not.toContain("PLAN_ENCODING_MODE_PRESET_CONFLICT");
		});

		it("a single codec per encoding is never mixed — the Dolby ladders", () => {
			// Scope is the ENCODING, not the plan: two codecs in two encodings
			// each pin their own preset-implied mode at their own START.
			const plan = mixed(undefined, "enc-h265");
			plan.encodings = [
				{ key: "enc-h265", name: "H265 ladder" },
			] as unknown as typeof plan.encodings;
			expect(codes(plan)).not.toContain(
				"PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS",
			);
			expect(codes(plan)).not.toContain("PLAN_ENCODING_MODE_PRESET_CONFLICT");
			// generation mode is global: each encoding gets a START, so even
			// separately owned presets conflict when this global pin is added.
			plan.generation.encodingMode = "TWO_PASS";
			expect(codes(plan)).toContain("PLAN_ENCODING_MODE_PRESET_CONFLICT");
		});
	});

	describe("fMP4 HLS media playlists below version 6 (audit 893eb66 HIGH-8, ledger #206)", () => {
		/**
		 * `videoKind`/`audioKind` switch that family's muxing to TS AND pin the
		 * manifest to it — the two halves have to move together, because a pin
		 * with no matching leg selects nothing at all.
		 */
		function withVersion(
			mediaVersion?: "HLS_V4" | "HLS_V6",
			legs?: { videoKind?: "TS"; audioKind?: "TS" },
		) {
			const plan = groupPlan();
			const hls = plan.manifests.find((m) => m.kind === "HLS");
			if (hls?.kind !== "HLS") {
				throw new Error("fixture is missing the HLS manifest");
			}
			hls.mediaVersion = mediaVersion;
			if (legs?.videoKind) {
				const v = plan.muxings.find((m) => m.streamKey === "v");
				if (v) {
					v.kind = "TS";
				}
				hls.videoMuxingKind = "TS";
			}
			if (legs?.audioKind) {
				const a = plan.muxings.find((m) => m.streamKey === "a");
				if (a) {
					a.kind = "TS";
				}
				hls.audioMuxingKind = "TS";
			}
			return plan;
		}
		const codes = (plan: ReturnType<typeof groupPlan>) =>
			validatePlan(plan).map((i) => i.code);

		it("fMP4 video at V4 warns — EXT-X-MAP is a version-6 feature", () => {
			const issues = validatePlan(withVersion("HLS_V4"));
			const hit = issues.find(
				(i) => i.code === "PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6",
			);
			expect(hit?.level).toBe("warning");
		});

		it("fMP4 video at V6 is silent", () => {
			expect(codes(withVersion("HLS_V6"))).not.toContain(
				"PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6",
			);
		});

		it("TS legs in BOTH families at V4 are silent — no EXT-X-MAP anywhere", () => {
			expect(
				codes(withVersion("HLS_V4", { videoKind: "TS", audioKind: "TS" })),
			).not.toContain("PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6");
		});

		it("an fMP4 AUDIO leg at V4 warns even when every video leg is TS (HIGH-4)", () => {
			// This arm used to assert SILENCE — the manifest's audio muxing was
			// left fMP4 while only the video was switched, and the rule scanned
			// video legs only, so the plan's own EXT-X-MAP went unreported. One
			// `mediaVersion` covers the audio media playlist too.
			const issues = validatePlan(withVersion("HLS_V4", { videoKind: "TS" }));
			const hit = issues.find(
				(i) => i.code === "PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6",
			);
			expect(hit?.level).toBe("warning");
		});

		it("an ABSENT version is silent — the API default is not ours to grade", () => {
			expect(codes(withVersion(undefined))).not.toContain(
				"PLAN_HLS_FMP4_MEDIA_VERSION_BELOW_6",
			);
		});
	});

	it("rejects hlsMedia on non-audio renditions", () => {
		const plan = groupPlan();
		const video = plan.renditions.find((r) => r.codec === "H264");
		if (!video) {
			throw new Error("fixture is missing the video rendition");
		}
		video.hlsMedia = {
			groupId: "phantom",
			name: "leak",
			uri: "leak.m3u8",
		};
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_HLS_MEDIA_ON_NON_AUDIO"),
		).toBe(true);
	});

	it("resolves dashSetKey routing and type matching", () => {
		const plan = groupPlan();
		plan.manifests.push({
			key: "dash",
			kind: "DASH",
			manifestName: "stream.mpd",
			name: "DASH Manifest",
			destination: { outputKey: "out", path: "x/" },
			audioLanguage: "en",
			representationType: "TEMPLATE",
			adaptationSets: [
				{ key: "video-set", type: "VIDEO" },
				{ key: "audio-set", type: "AUDIO", lang: "en" },
			],
		} as (typeof plan.manifests)[number]);
		// Unrouted renditions are an error.
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_DASH_SET_UNRESOLVED"),
		).toHaveLength(2);
		// Routing resolves them.
		const v = plan.renditions.find((r) => r.codec === "H264");
		const a = plan.renditions.find((r) => r.codec === "AAC");
		if (!v || !a) {
			throw new Error("fixture is missing renditions");
		}
		v.dashSetKey = "video-set";
		a.dashSetKey = "audio-set";
		expect(validatePlan(plan)).toEqual([]);
		// A video rendition cannot join an AUDIO set.
		v.dashSetKey = "audio-set";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DASH_SET_TYPE_MISMATCH"),
		).toBe(true);
	});
});

describe("DASH OnDemand and AISA rails", () => {
	function onDemandPlan() {
		return encodingPlanSchema.parse({
			planVersion: 1,
			name: "ondemand",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "MP4",
					streamKey: "v",
					filename: "video.mp4",
					fragmentDuration: 6000,
					manifestType: "DASH_ON_DEMAND",
					destination: { outputKey: "out", path: "x/video/360p" },
				},
			],
			manifests: [
				{
					key: "dash",
					kind: "DASH",
					manifestName: "stream.mpd",
					name: "DASH Manifest",
					profile: "ON_DEMAND",
					destination: { outputKey: "out", path: "x/" },
					audioLanguage: "en",
				},
			],
			generation: { timing: "POST_ENCODING" },
		});
	}

	it("accepts a coherent OnDemand plan", () => {
		expect(validatePlan(onDemandPlan())).toEqual([]);
	});

	it("requires fragmentDuration on DASH_ON_DEMAND muxings", () => {
		const plan = onDemandPlan();
		const muxing = plan.muxings.at(0);
		if (muxing?.kind !== "MP4") {
			throw new Error("fixture is missing the MP4 muxing");
		}
		muxing.fragmentDuration = undefined;
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_MP4_FRAGMENT_DURATION_MISSING",
			),
		).toBe(true);
	});

	it("flags dashSetKey-routed renditions with no OnDemand muxing at all", () => {
		const plan = onDemandPlan();
		const manifest = plan.manifests.at(0);
		const muxing = plan.muxings.at(0);
		if (manifest?.kind !== "DASH" || !muxing) {
			throw new Error("fixture is missing entries");
		}
		manifest.adaptationSets = [{ key: "video-set", type: "VIDEO" }];
		const rendition = plan.renditions.at(0);
		if (!rendition) {
			throw new Error("fixture is missing the rendition");
		}
		rendition.dashSetKey = "video-set";
		// Swap the OnDemand MP4 leg for an fMP4 one: explicit routing intent
		// with nothing selectable.
		plan.muxings = [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				segmentLength: 6,
				segmentNaming: "seg_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "out", path: "x/video/360p" },
			} as (typeof plan.muxings)[number],
		];
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_DASH_ONDEMAND_MUXING_TYPE" &&
					i.message.includes("no DASH_ON_DEMAND MP4 muxing"),
			),
		).toBe(true);
	});

	it("flags routed renditions whose MP4 muxings lack DASH_ON_DEMAND", () => {
		const plan = onDemandPlan();
		const muxing = plan.muxings.at(0);
		if (muxing?.kind !== "MP4") {
			throw new Error("fixture is missing the MP4 muxing");
		}
		muxing.manifestType = "HLS_BYTE_RANGES";
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_DASH_ONDEMAND_MUXING_TYPE",
			),
		).toBe(true);
	});

	it("accepts mixed legs when a DASH_ON_DEMAND muxing also exists", () => {
		const plan = onDemandPlan();
		plan.muxings.push({
			key: "v-byterange",
			kind: "MP4",
			streamKey: "v",
			filename: "byterange.mp4",
			fragmentDuration: 4000,
			manifestType: "HLS_BYTE_RANGES",
			destination: { outputKey: "out", path: "x/video/byterange" },
		} as (typeof plan.muxings)[number]);
		expect(
			validatePlan(plan).filter(
				(i) =>
					i.code === "PLAN_DASH_ONDEMAND_MUXING_TYPE" ||
					i.code === "PLAN_DASH_NO_REPRESENTATIONS",
			),
		).toEqual([]);
	});

	it("enforces drmKind against the OnDemand MP4 selection", () => {
		const plan = onDemandPlan();
		const manifest = plan.manifests.at(0);
		if (manifest?.kind !== "DASH") {
			throw new Error("fixture is missing the DASH manifest");
		}
		(manifest as { drmKind?: string }).drmKind = "CENC";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_DRM_KIND_UNMATCHED"),
		).toBe(true);
	});

	it("rejects dolbyVisionConfiguration on non-DV muxings", () => {
		const plan = onDemandPlan();
		const muxing = plan.muxings.at(0);
		if (muxing?.kind !== "MP4") {
			throw new Error("fixture is missing the MP4 muxing");
		}
		muxing.dolbyVisionConfiguration = { trackSampleEntryName: "DVH1" };
		expect(
			validatePlan(plan).some(
				(i) => i.code === "PLAN_MUXING_DV_CONFIG_MISMATCH",
			),
		).toBe(true);
	});

	it("resolves the AISA asset-description output", () => {
		const plan = onDemandPlan();
		plan.aiSceneAnalysis = {
			assetDescription: {
				filename: "out.json",
				destination: { outputKey: "missing", path: "x/ai" },
			},
		} as typeof plan.aiSceneAnalysis;
		expect(
			validatePlan(plan).some(
				(i) =>
					i.code === "PLAN_UNRESOLVED_REF" &&
					i.path === "aiSceneAnalysis.assetDescription.destination.outputKey",
			),
		).toBe(true);
	});
});

describe("validatePlan — trimming + concatenation input streams", () => {
	// A coherent base with a single ingest the trim/concat streams can wrap and
	// a rendition that reads the wrapping stream. Helpers patch the shared parts.
	const codesFor = (patch: Record<string, unknown>): string[] => {
		const plan = encodingPlanSchema.parse({
			planVersion: 1,
			name: "test",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
				{
					key: "video2",
					inputKey: "in",
					inputPath: "b.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "trim",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/video" },
				},
			],
			manifests: [],
			generation: { timing: "JUST_IN_TIME" },
			...patch,
		});
		return validatePlan(plan).map((i) => i.code);
	};

	it("accepts a time-based trim feeding a rendition (no errors)", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 5 },
			],
		});
		expect(codes).not.toContain("PLAN_TRIMMING_UNRESOLVED_SOURCE");
		expect(codes).not.toContain("PLAN_UNRESOLVED_REF");
	});

	it("flags a trimming stream whose source does not resolve", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "trim", kind: "TIME_BASED", sourceKey: "ghost" },
			],
		});
		expect(codes).toContain("PLAN_TRIMMING_UNRESOLVED_SOURCE");
	});

	it("flags a trimming stream that references itself", () => {
		const codes = codesFor({
			trimmingStreams: [{ key: "trim", kind: "TIME_BASED", sourceKey: "trim" }],
		});
		expect(codes).toContain("PLAN_TRIMMING_UNRESOLVED_SOURCE");
	});

	it("flags a duplicate key across the shared input-stream namespace", () => {
		// A trimming stream reusing an ingest key collides in the shared space.
		const codes = codesFor({
			trimmingStreams: [
				{ key: "video", kind: "TIME_BASED", sourceKey: "video2" },
				{ key: "trim", kind: "TIME_BASED", sourceKey: "video" },
			],
		});
		expect(codes).toContain("PLAN_DUPLICATE_KEY");
	});

	it("accepts a two-source concatenation with exactly one main", () => {
		const codes = codesFor({
			concatenationStreams: [
				{
					key: "trim",
					sources: [
						{ sourceKey: "video", isMain: true, position: 0 },
						{ sourceKey: "video2", position: 1 },
					],
				},
			],
		});
		expect(codes).not.toContain("PLAN_CONCAT_UNRESOLVED_SOURCE");
		expect(codes).not.toContain("PLAN_CONCAT_MAIN_COUNT");
		expect(codes).not.toContain("PLAN_UNRESOLVED_REF");
	});

	it("flags a concatenation source that does not resolve", () => {
		const codes = codesFor({
			concatenationStreams: [
				{
					key: "trim",
					sources: [
						{ sourceKey: "video", isMain: true },
						{ sourceKey: "ghost" },
					],
				},
			],
		});
		expect(codes).toContain("PLAN_CONCAT_UNRESOLVED_SOURCE");
	});

	it("flags zero or multiple main sources in a concatenation", () => {
		const none = codesFor({
			concatenationStreams: [
				{ key: "trim", sources: [{ sourceKey: "video" }] },
			],
		});
		expect(none).toContain("PLAN_CONCAT_MAIN_COUNT");
		const two = codesFor({
			concatenationStreams: [
				{
					key: "trim",
					sources: [
						{ sourceKey: "video", isMain: true },
						{ sourceKey: "video2", isMain: true },
					],
				},
			],
		});
		expect(two).toContain("PLAN_CONCAT_MAIN_COUNT");
	});

	it("flags duplicate concatenation positions", () => {
		const codes = codesFor({
			concatenationStreams: [
				{
					key: "trim",
					sources: [
						{ sourceKey: "video", isMain: true, position: 0 },
						{ sourceKey: "video2", position: 0 },
					],
				},
			],
		});
		expect(codes).toContain("PLAN_CONCAT_DUPLICATE_POSITION");
	});

	it("rejects a WEBVTT rendition reading a trimming stream", () => {
		const codes = codesFor({
			renditions: [{ key: "sub", codec: "WEBVTT", ingestKey: "trim" }],
			muxings: [
				{
					key: "sub",
					kind: "CHUNKED_TEXT",
					streamKey: "sub",
					destination: { outputKey: "out", path: "x/sub" },
				},
			],
			trimmingStreams: [
				{ key: "trim", kind: "TIME_BASED", sourceKey: "video" },
			],
		});
		expect(codes).toContain("PLAN_STREAM_SOURCE_MISMATCH");
	});

	it("flags a trim wrapping a LATER-declared trim (forward reference)", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "outer", kind: "TIME_BASED", sourceKey: "inner" },
				{ key: "inner", kind: "TIME_BASED", sourceKey: "video" },
			],
		});
		expect(codes).toContain("PLAN_INPUTSTREAM_FORWARD_REF");
	});

	it("accepts a trim wrapping an EARLIER-declared trim (backward reference)", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "inner", kind: "TIME_BASED", sourceKey: "video" },
				{ key: "outer", kind: "TIME_BASED", sourceKey: "inner" },
			],
		});
		expect(codes).not.toContain("PLAN_INPUTSTREAM_FORWARD_REF");
	});

	it("flags a 2-cycle between trimming streams", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "a", kind: "TIME_BASED", sourceKey: "b" },
				{ key: "b", kind: "TIME_BASED", sourceKey: "a" },
			],
		});
		expect(codes).toContain("PLAN_INPUTSTREAM_FORWARD_REF");
	});

	it("flags a concatenation wrapping a LATER-declared concatenation", () => {
		const codes = codesFor({
			concatenationStreams: [
				{ key: "c1", sources: [{ sourceKey: "c2", isMain: true }] },
				{ key: "c2", sources: [{ sourceKey: "video", isMain: true }] },
			],
		});
		expect(codes).toContain("PLAN_INPUTSTREAM_FORWARD_REF");
	});

	it("accepts a concatenation wrapping an earlier trim (concat emits after all trims)", () => {
		const codes = codesFor({
			trimmingStreams: [
				{ key: "trim", kind: "TIME_BASED", sourceKey: "video" },
			],
			concatenationStreams: [
				{
					key: "cc",
					sources: [
						{ sourceKey: "trim", isMain: true, position: 0 },
						{ sourceKey: "video2", position: 1 },
					],
				},
			],
		});
		expect(codes).not.toContain("PLAN_INPUTSTREAM_FORWARD_REF");
	});
});

describe("validatePlan — qc.only (VMAF-only encode)", () => {
	// A coherent VMAF-only base: one H264 video rendition, one muxing carrying
	// the qc destination, no manifests, qc.only on. Patches override the parts a
	// given rule exercises. Mirrors the codesFor pattern above.
	const codesFor = (patch: Record<string, unknown>): string[] => {
		const plan = encodingPlanSchema.parse({
			planVersion: 1,
			name: "vmaf-only",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 540,
					bitrate: 600000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/video" },
				},
			],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
			qc: { vmaf: true, only: true },
			...patch,
		});
		return validatePlan(plan).map((issue) => issue.code);
	};

	it("accepts a minimal coherent qc.only plan (muxings ARE allowed)", () => {
		const codes = codesFor({});
		expect(codes.filter((c) => c.startsWith("PLAN_QC_ONLY"))).toEqual([]);
		// The kept muxing must NOT trip the unmuxed-rendition warning either.
		expect(codes).not.toContain("PLAN_UNMUXED_RENDITION");
	});

	it("rejects qc.only with neither vmaf nor psnr (nothing would be produced)", () => {
		expect(
			codesFor({ qc: { vmaf: false, psnr: false, only: true } }),
		).toContain("PLAN_QC_ONLY_NO_METRIC");
		// psnr-only is fine — the runner still computes VMAF in the same pass.
		expect(
			codesFor({ qc: { vmaf: false, psnr: true, only: true } }),
		).not.toContain("PLAN_QC_ONLY_NO_METRIC");
	});

	it("rejects qc.only when no video rendition has a destination muxing (zero-muxing encode)", () => {
		// A video rendition exists but its muxing carries no destination → no qc
		// mirror would be emitted → the encoding would have ZERO muxings.
		const codes = codesFor({
			muxings: [{ key: "v", kind: "FMP4", streamKey: "v" }],
		});
		expect(codes).toContain("PLAN_QC_ONLY_NO_MIRROR");
	});

	it("rejects qc.only with a non-video (audio) rendition (silently dropped otherwise)", () => {
		const codes = codesFor({
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
				{
					key: "audio",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "AUDIO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 540,
					bitrate: 600000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 44100,
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects qc.only with aiSceneAnalysis (emits a non-mirror output)", () => {
		const codes = codesFor({
			aiSceneAnalysis: {
				assetDescription: {
					filename: "ai.json",
					destination: { outputKey: "out", path: "ai" },
				},
			},
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects qc.only with no video rendition to mirror", () => {
		const codes = codesFor({
			ingest: [
				{
					key: "audio",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "AUDIO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 64000,
					rate: 44100,
				},
			],
			muxings: [
				{
					key: "a",
					kind: "FMP4",
					streamKey: "a",
					destination: { outputKey: "out", path: "x/audio" },
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_NO_VIDEO");
	});

	it("rejects manifests on a qc.only plan", () => {
		const codes = codesFor({
			generation: { timing: "POST_ENCODING" },
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					destination: { outputKey: "out", path: "x" },
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects thumbnails on a qc.only plan", () => {
		const codes = codesFor({
			thumbnails: [
				{
					key: "t",
					streamKey: "v",
					height: 180,
					positions: [1],
					destination: { outputKey: "out", path: "x/thumbs" },
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects sprites on a qc.only plan", () => {
		const codes = codesFor({
			sprites: [
				{
					key: "s",
					streamKey: "v",
					width: 160,
					distance: 5,
					filename: "sprite.jpg",
					destination: { outputKey: "out", path: "x/sprites" },
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects keyframes on a qc.only plan", () => {
		const codes = codesFor({ keyframes: [{ key: "k", time: 5 }] });
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("rejects drm on a qc.only plan", () => {
		const codes = codesFor({
			drm: [
				{
					key: "d",
					kind: "CENC",
					muxingKey: "v",
					credentialId: "00000000-0000-4000-8000-000000000003",
					kid: "00000000000000000000000000000000",
					destination: { outputKey: "out", path: "x/enc" },
				},
			],
		});
		expect(codes).toContain("PLAN_QC_ONLY_FORBIDDEN_RESOURCE");
	});

	it("does not fire any qc.only rule when qc.only is absent", () => {
		// A normal plan with manifests/keyframes must be untouched by these rules.
		const codes = codesFor({
			qc: { vmaf: true },
			generation: { timing: "POST_ENCODING" },
			keyframes: [{ key: "k", time: 5 }],
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					destination: { outputKey: "out", path: "x" },
				},
			],
		});
		expect(codes.filter((c) => c.startsWith("PLAN_QC_ONLY"))).toEqual([]);
	});
});

describe("C29 — qc.gate rails (ledger #86)", () => {
	const gateCodes = (
		qc: Record<string, unknown>,
		over: Record<string, unknown> = {},
	): string[] => {
		const plan = encodingPlanSchema.parse({
			planVersion: 1,
			name: "gate",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "out",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: "FMP4",
					streamKey: "v",
					destination: { outputKey: "out", path: "x/video" },
				},
			],
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					manifestName: "stream.m3u8",
					destination: { outputKey: "out", path: "x" },
				},
			],
			generation: { timing: "POST_ENCODING" },
			qc,
			...over,
		});
		return validatePlan(plan).map((i) => i.code);
	};
	const RULE = { metric: "VMAF_MEAN", scope: "OVERALL", gte: 85 };

	it("a gate over nothing (qc.vmaf false) is an error", () => {
		expect(
			gateCodes({ vmaf: false, gate: { rules: [RULE], onFail: "MARK_ONLY" } }),
		).toContain("PLAN_QC_GATE_WITHOUT_VMAF");
		expect(
			gateCodes({ vmaf: true, gate: { rules: [RULE], onFail: "MARK_ONLY" } }),
		).not.toContain("PLAN_QC_GATE_WITHOUT_VMAF");
	});

	it("a gte of 0 WARNS — it cannot fail on quality, only on measurement absence (review-204 I2)", () => {
		expect(
			gateCodes({
				vmaf: true,
				gate: {
					rules: [{ metric: "VMAF_MIN", scope: "OVERALL", gte: 0 }],
					onFail: "MARK_ONLY",
				},
			}),
		).toContain("PLAN_QC_GATE_GTE_ZERO");
		expect(
			gateCodes({ vmaf: true, gate: { rules: [RULE], onFail: "MARK_ONLY" } }),
		).not.toContain("PLAN_QC_GATE_GTE_ZERO");
	});

	it("a gate over ZERO video renditions WARNS — default rules can only fail (review-204 N3)", () => {
		expect(
			gateCodes(
				{ vmaf: true, gate: { rules: [RULE], onFail: "MARK_ONLY" } },
				{
					renditions: [
						{
							key: "a64",
							ingestKey: "audio",
							codec: "AAC",
							bitrate: 64000,
							rate: 44100,
						},
					],
					muxings: [
						{
							key: "ma",
							kind: "FMP4",
							streamKey: "a64",
							destination: { outputKey: "out", path: "a" },
						},
					],
				},
			),
		).toContain("PLAN_QC_GATE_NO_VIDEO");
		expect(
			gateCodes({ vmaf: true, gate: { rules: [RULE], onFail: "MARK_ONLY" } }),
		).not.toContain("PLAN_QC_GATE_NO_VIDEO");
	});

	it("PSNR_MEAN rules need qc.psnr on", () => {
		const psnrRule = { metric: "PSNR_MEAN", scope: "OVERALL", gte: 35 };
		expect(
			gateCodes({
				vmaf: true,
				gate: { rules: [psnrRule], onFail: "MARK_ONLY" },
			}),
		).toContain("PLAN_QC_GATE_PSNR_OFF");
		expect(
			gateCodes({
				vmaf: true,
				psnr: true,
				gate: { rules: [psnrRule], onFail: "MARK_ONLY" },
			}),
		).not.toContain("PLAN_QC_GATE_PSNR_OFF");
	});

	it("BLOCK_MANIFESTS on a JIT plan is unsatisfiable — error explains, never silently switches", () => {
		expect(
			gateCodes(
				{ vmaf: true, gate: { rules: [RULE], onFail: "BLOCK_MANIFESTS" } },
				{ generation: { timing: "JUST_IN_TIME" } },
			),
		).toContain("PLAN_QC_GATE_BLOCK_JIT");
		expect(
			gateCodes({
				vmaf: true,
				gate: { rules: [RULE], onFail: "BLOCK_MANIFESTS" },
			}),
		).not.toContain("PLAN_QC_GATE_BLOCK_JIT");
	});

	it("BLOCK_MANIFESTS with nothing to block WARNS the MARK_ONLY semantics", () => {
		const codes = gateCodes(
			{ vmaf: true, gate: { rules: [RULE], onFail: "BLOCK_MANIFESTS" } },
			{ manifests: [] },
		);
		expect(codes).toContain("PLAN_QC_GATE_NOTHING_TO_BLOCK");
		// It is a WARNING, not an error: the plan still submits.
		expect(
			validatePlan(
				encodingPlanSchema.parse({
					planVersion: 1,
					name: "gate",
					bitmovin: {},
					inputs: [
						{
							key: "in",
							kind: "S3",
							credentialId: "00000000-0000-4000-8000-000000000001",
							bucket: "b",
						},
					],
					outputs: [
						{
							key: "out",
							kind: "S3",
							credentialId: "00000000-0000-4000-8000-000000000002",
							bucket: "b",
						},
					],
					ingest: [
						{
							key: "video",
							inputKey: "in",
							inputPath: "a.mp4",
							selectionMode: "VIDEO_RELATIVE",
						},
					],
					renditions: [
						{
							key: "v",
							codec: "H264",
							ingestKey: "video",
							height: 360,
							bitrate: 300000,
						},
					],
					muxings: [
						{
							key: "v",
							kind: "FMP4",
							streamKey: "v",
							destination: { outputKey: "out", path: "x/video" },
						},
					],
					manifests: [],
					generation: { timing: "POST_ENCODING" },
					qc: {
						vmaf: true,
						gate: { rules: [RULE], onFail: "BLOCK_MANIFESTS" },
					},
				}),
			).filter(
				(issue) =>
					issue.code === "PLAN_QC_GATE_NOTHING_TO_BLOCK" &&
					issue.level === "warning",
			),
		).toHaveLength(1);
	});

	it("a rule naming an unknown rendition key is an error at save, not a runtime surprise", () => {
		expect(
			gateCodes({
				vmaf: true,
				gate: {
					rules: [{ ...RULE, scope: "PER_RENDITION", renditions: ["typo"] }],
					onFail: "MARK_ONLY",
				},
			}),
		).toContain("PLAN_QC_GATE_UNKNOWN_RENDITION");
		expect(
			gateCodes({
				vmaf: true,
				gate: {
					rules: [{ ...RULE, scope: "PER_RENDITION", renditions: ["v"] }],
					onFail: "MARK_ONLY",
				},
			}),
		).not.toContain("PLAN_QC_GATE_UNKNOWN_RENDITION");
	});

	it("absent gate adds NO new codes (the 73 goldens' plans stay silent)", () => {
		expect(
			gateCodes({ vmaf: true }).filter((code) =>
				code.startsWith("PLAN_QC_GATE"),
			),
		).toEqual([]);
	});
});

/**
 *  — deliveryMirrors: keys resolve, no key twice, no mirror that
 * duplicates a destination's own output (the SDK would receive the same
 * output twice in one outputs array), and per-title extends C4's allowlist
 * check to every mirror.
 */
describe("deliveryMirrors (ledger #115)", () => {
	function planWithMirror() {
		const plan = basePlan();
		plan.outputs.push({
			key: "mirror",
			kind: "GCS",
			credentialId: "00000000-0000-4000-8000-000000000003",
			bucket: "m",
			name: "GCS Output",
		});
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		return plan;
	}

	it("passes a coherent mirrored plan", () => {
		expect(validatePlan(planWithMirror())).toEqual([]);
	});

	it("flags an unknown mirror key as PLAN_UNRESOLVED_REF with its path", () => {
		const plan = planWithMirror();
		plan.deliveryMirrors = [{ outputKey: "ghost" }];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) =>
					i.code === "PLAN_UNRESOLVED_REF" &&
					i.path === "deliveryMirrors.0.outputKey",
			),
		).toBe(true);
	});

	it("flags the same mirror listed twice", () => {
		const plan = planWithMirror();
		plan.deliveryMirrors = [{ outputKey: "mirror" }, { outputKey: "mirror" }];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) =>
					i.code === "PLAN_DUPLICATE_KEY" &&
					i.path === "deliveryMirrors.1.outputKey",
			),
		).toBe(true);
	});

	it("flags a mirror that equals a destination's own output — double write", () => {
		const plan = planWithMirror();
		plan.deliveryMirrors = [{ outputKey: "out" }];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) =>
					i.code === "PLAN_DUPLICATE_KEY" &&
					i.path === "muxings.0.destination.outputKey" &&
					i.message.includes("twice"),
			),
		).toBe(true);
	});

	it("C4: a per-title plan ACCEPTS a GCS mirror — the flagship pairing (115-A1: the old allowlist rejected GCS while its own message listed it as supported)", () => {
		const plan = planWithMirror();
		const rendition = plan.renditions.at(0);
		const muxing = plan.muxings.at(0);
		if (!rendition || !muxing || rendition.codec !== "H264") {
			throw new Error("fixture is missing entries");
		}
		rendition.mode = "PER_TITLE_TEMPLATE";
		muxing.destination = { outputKey: "out", path: "x/{uuid}/video" };
		expect(validatePlan(plan).filter((i) => i.code === "C4")).toEqual([]);
	});

	it("collision scan covers thumbnails too (115-A3 — first cut scanned 3 of 6 families)", () => {
		const plan = planWithMirror();
		plan.thumbnails = [
			{
				key: "thumb",
				streamKey: "v",
				height: 180,
				pattern: "thumb-%number%.png",
				unit: "SECONDS",
				positions: [1],
				destination: { outputKey: "mirror", path: "x/thumbs" },
			},
		];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) =>
					i.code === "PLAN_DUPLICATE_KEY" &&
					i.path === "thumbnails.0.destination.outputKey",
			),
		).toBe(true);
	});

	it("C4: a per-title plan refuses an SFTP mirror by KIND", () => {
		const plan = planWithMirror();
		const rendition = plan.renditions.at(0);
		const muxing = plan.muxings.at(0);
		if (!rendition || !muxing || rendition.codec !== "H264") {
			throw new Error("fixture is missing entries");
		}
		rendition.mode = "PER_TITLE_TEMPLATE";
		muxing.destination = {
			outputKey: "out",
			path: "x/{uuid}/video",
		};
		plan.outputs.push({
			key: "sftp-mirror",
			kind: "SFTP",
			credentialId: "00000000-0000-4000-8000-000000000004",
			name: "SFTP Output",
		});
		plan.deliveryMirrors = [{ outputKey: "sftp-mirror" }];
		const issues = validatePlan(plan);
		expect(
			issues.some(
				(i) => i.code === "C4" && i.path === "deliveryMirrors.0.outputKey",
			),
		).toBe(true);
	});
});

/**
 * A per-title plan whose single output is `kind`, self-contained so only the
 * output varies between cases.
 */
function perTitlePlanWithOutputKind(kind: string) {
	const cred = "00000000-0000-4000-8000-000000000002";
	const output: Record<string, unknown> =
		kind === "AKAMAI_MSL"
			? {
					key: "out",
					kind,
					credentialId: "00000000-0000-4000-8000-000000000003",
					streamFormat: "HLS",
					mslVersion: "MSL4",
				}
			: kind === "SFTP" ||
					kind === "AKAMAI_NETSTORAGE" ||
					kind === "LIVE_MEDIA_INGEST"
				? { key: "out", kind, credentialId: cred }
				: kind === "AZURE"
					? { key: "out", kind, credentialId: cred, container: "c" }
					: { key: "out", kind, credentialId: cred, bucket: "b" };
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "per-title",
		bitmovin: {},
		inputs: [
			{
				key: "in",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "b",
			},
		],
		outputs: [output],
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
				mode: "PER_TITLE_TEMPLATE",
			},
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				// Placeholders present, so any C4 issue is about the OUTPUT KIND
				// rather than about the path (C4 checks both).
				destination: {
					outputKey: "out",
					path: "x/video/{height}p_{bitrate}_{uuid}/",
				},
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
		perTitle: { h264Configuration: {} },
	});
}

describe("C4's per-title allowlist, pinned PER KIND against the schema (ledger #138)", () => {
	/**
	 * The allowlist has now been wrong twice in the same way: a storage kind
	 * the error message NAMES as supported was missing from the Set, so the
	 * plan was refused by a sentence that listed the thing it refused. GCS in
	 * review-250 115-A1, Akamai NetStorage here.
	 *
	 * Both times the fix moved the Set and pinned nothing about its contents,
	 * which is why it could happen twice. This derives the population from the
	 * schema and states each kind's verdict, so the next output kind cannot
	 * join by omission — and a disagreement between the Set and the message is
	 * a failing test rather than a support ticket.
	 */
	const outputKinds = planOutputSchema.options.map(
		(o) => o.shape.kind.value as string,
	);

	/**
	 * Per-title CANNOT write here, and each has a reason that is not "we did
	 * not get to it":
	 *  - SFTP: no object placeholders — per-title paths need {uuid}/{bitrate}.
	 *  - AKAMAI_MSL: a live ingest target with no path at all .
	 */
	const REFUSED = new Set(["SFTP", "AKAMAI_MSL", "LIVE_MEDIA_INGEST"]);

	it("found the schema's output kinds", () => {
		expect(outputKinds.length).toBeGreaterThan(6);
	});

	it("accepts every storage kind except the live-only and unsupported targets", () => {
		for (const kind of outputKinds) {
			const plan = perTitlePlanWithOutputKind(kind);
			const c4 = validatePlan(plan).filter((i) => i.code === "C4");
			if (REFUSED.has(kind)) {
				expect(c4.length, `${kind} must be refused`).toBeGreaterThan(0);
			} else {
				expect(c4, `${kind} must be accepted`).toEqual([]);
			}
		}
	});

	it("never refuses a kind its own message lists as supported", () => {
		// The invariant both regressions violated, stated directly.
		for (const kind of outputKinds) {
			const c4 = validatePlan(perTitlePlanWithOutputKind(kind)).filter(
				(i) => i.code === "C4",
			);
			for (const issue of c4) {
				const named = /per-title supports ([^—]+?) only/.exec(issue.message);
				if (!named) {
					continue;
				}
				const listed = named[1] ?? "";
				const alias =
					kind === "AKAMAI_NETSTORAGE"
						? "Akamai NetStorage"
						: kind === "GCS_SERVICE_ACCOUNT"
							? "GCS"
							: kind === "GENERIC_S3"
								? "GenericS3"
								: kind;
				expect(
					listed.includes(alias),
					`C4 refused ${kind} with a message that lists it: "${issue.message}"`,
				).toBe(false);
			}
		}
	});
});

describe("C31's tables cover the whole schema, not the kinds I happened to think of", () => {
	/**
	 * review-5 S2. The output-kind hole was closed in preflight in the same
	 * commit that left this one open: a SIXTH muxing kind (or a fourth manifest
	 * family) would land in neither `muxings` nor `forbidden` and be silently
	 * tolerated on every MSL output — pass by omission, one layer down.
	 *
	 * Populations derived from the schema unions, never typed out here.
	 */
	const muxingKinds = planMuxingSchema.options.map(
		(o) => o.shape.kind.value as string,
	);
	const manifestKinds = planManifestSchema.options.map(
		(o) => o.shape.kind.value as string,
	);

	/**
	 * Deliberate tolerances, stated with their reason. CHUNKED_TEXT is a WebVTT
	 * companion: legal beside any ladder on any format, so it belongs in
	 * neither list and that is a decision, not an oversight.
	 */
	const TOLERATED_MUXINGS = new Set(["CHUNKED_TEXT"]);

	it("found both populations, so this does not pass over an empty list", () => {
		expect(muxingKinds.length).toBeGreaterThan(3);
		expect(manifestKinds.length).toBeGreaterThan(2);
	});

	it("places every muxing kind in exactly one list per format", () => {
		for (const [format, need] of Object.entries(AKAMAI_MSL_REQUIREMENTS)) {
			const covered = new Set<string>([...need.muxings, ...need.forbidden]);
			const missed = muxingKinds.filter(
				(k) => !covered.has(k) && !TOLERATED_MUXINGS.has(k),
			);
			expect(
				missed,
				`${format} classifies neither as required nor forbidden: ${missed.join(", ")}`,
			).toEqual([]);
			// And no kind may be in BOTH, which would make the messages
			// contradict each other on the same plan.
			// Widened deliberately: `satisfies` keeps the tuples literal, so a
			// bare `.includes` narrows to the members it already has and the
			// overlap check would not compile. The comparison wants plain
			// strings.
			expect(
				(need.muxings as readonly string[]).filter((k) =>
					(need.forbidden as readonly string[]).includes(k),
				),
			).toEqual([]);
		}
	});

	it("places every manifest kind in exactly one list per format", () => {
		for (const [format, need] of Object.entries(AKAMAI_MSL_REQUIREMENTS)) {
			const covered = new Set<string>([
				...need.manifests,
				...need.forbiddenManifests,
			]);
			const missed = manifestKinds.filter((k) => !covered.has(k));
			expect(
				missed,
				`${format} classifies no manifest family: ${missed.join(", ")}`,
			).toEqual([]);
			expect(
				(need.manifests as readonly string[]).filter((k) =>
					(need.forbiddenManifests as readonly string[]).includes(k),
				),
			).toEqual([]);
		}
	});
});

describe("C31 — an Akamai MSL stream format constrains the encoding (ledger #137)", () => {
	/**
	 * A plan whose MSL output sits beside an ordinary one, so "scoped by
	 * destination" has something to be wrong about: a plan-wide check would
	 * pass on muxings that never reach MSL.
	 */
	function mslPlan(opts: {
		streamFormat: "DASH" | "HLS" | "CMAF";
		muxingKind: "FMP4" | "TS";
		manifestKinds: ("HLS" | "DASH" | "SMOOTH")[];
		muxingTo?: string;
		manifestTo?: string;
		/**
		 * Route the muxing to the MSL output through a DRM entry instead of a
		 * destination of its own — the shape a CENC ladder actually has.
		 */
		viaDrm?: boolean;
		/** Name the MSL output as a delivery MIRROR rather than a destination. */
		viaMirror?: boolean;
		/**
		 * Route the MANIFESTS through the mirror too. Separate from `viaMirror`
		 * because the first cut moved only the muxing, which left
		 * `manifestKindsReaching`'s own mirror branch unpinned — the identical
		 * defect as I1, in the sibling function (review-6 I2).
		 */
		manifestsViaMirror?: boolean;
		/** A second muxing bound wherever `muxingTo` points, to test tolerance. */
		extraMuxing?: "FMP4" | "TS" | "MP4" | "WEBM" | "CHUNKED_TEXT";
		/**
		 * Segment naming for the primary muxing. Defaults to the MSL-conforming
		 * grammar, because every case here is about the CONTAINER rule and a
		 * non-conforming name would make each of them fail for the other
		 * reason. `null` omits it — that is what the segment-naming tests below
		 * use, since an unset name means the S3-shaped schema default applies.
		 */
		segmentNaming?: string | null;
	}) {
		return encodingPlanSchema.parse({
			planVersion: 1,
			name: "msl",
			bitmovin: {},
			inputs: [
				{
					key: "in",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
				},
			],
			outputs: [
				{
					key: "msl",
					kind: "AKAMAI_MSL",
					credentialId: "00000000-0000-4000-8000-000000000003",
					streamFormat: opts.streamFormat,
				},
				{
					key: "s3",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "b",
				},
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			muxings: [
				{
					key: "v",
					kind: opts.muxingKind,
					streamKey: "v",
					...(opts.segmentNaming === null
						? {}
						: {
								segmentNaming:
									opts.segmentNaming ??
									`seg-{rand_chars:8}-%number%.${opts.muxingKind === "TS" ? "ts" : "m4s"}`,
							}),
					// A DRM'd muxing carries NO destination of its own — it
					// writes through the DRM entry. A mirrored plan points its
					// muxing at the ordinary output; the mirror is what carries
					// it to MSL.
					...(opts.viaDrm
						? {}
						: {
								destination: {
									outputKey: opts.viaMirror ? "s3" : (opts.muxingTo ?? "msl"),
									path: "x/video",
								},
							}),
				},
				...(opts.extraMuxing
					? [
							{
								key: "v2",
								kind: opts.extraMuxing,
								streamKey: "v",
								destination: {
									outputKey: opts.viaMirror ? "s3" : (opts.muxingTo ?? "msl"),
									path: "x/video2",
								},
							},
						]
					: []),
			],
			...(opts.viaDrm
				? {
						drm: [
							{
								key: "d",
								kind: "CENC" as const,
								muxingKey: "v",
								credentialId: "00000000-0000-4000-8000-000000000003",
								kid: "00000000000000000000000000000001",
								destination: { outputKey: "msl", path: "x/video" },
							},
						],
					}
				: {}),
			...(opts.viaMirror ? { deliveryMirrors: [{ outputKey: "msl" }] } : {}),
			manifests: opts.manifestKinds.map((kind, index) => ({
				key: `m${index}`,
				kind,
				// SMOOTH names its two manifests separately; the other two take
				// a single `manifestName`.
				...(kind === "SMOOTH"
					? {}
					: { manifestName: kind === "HLS" ? "stream.m3u8" : "stream.mpd" }),
				destination: {
					outputKey: opts.manifestsViaMirror
						? "s3"
						: (opts.manifestTo ?? "msl"),
					path: "x/",
				},
			})),
			generation: { timing: "JUST_IN_TIME" },
		});
	}

	const c31 = (plan: unknown) =>
		validatePlan(plan as never).filter((i) => i.code === "C31");

	it("HLS accepts TS + an HLS manifest", () => {
		expect(
			c31(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
				}),
			),
		).toEqual([]);
	});

	it("HLS refuses fMP4 — BOTH halves fire: the missing kind and the wrong one", () => {
		const issues = c31(
			mslPlan({
				streamFormat: "HLS",
				muxingKind: "FMP4",
				manifestKinds: ["HLS"],
			}),
		);
		// TWO issues, not one. "at least one right kind" was the first cut, and
		// it is a false NEGATIVE: an output carrying the right container beside
		// a wrong one passed it (review-4 #2). The second message is what
		// catches a ladder with an extra container bound to the same output.
		expect(issues).toHaveLength(2);
		// The messages have to name the output AND the format, because
		// Bitmovin's own error names neither.
		for (const issue of issues) {
			expect(issue.message).toMatch(/"msl"/);
			expect(issue.message).toMatch(/HLS/);
		}
		// And the two halves carry DIFFERENT strengths (review-5 I4): the
		// missing container is an error under any reading, the extra one is our
		// inference and must not hard-block a plan nobody has tested.
		expect(issues[0]?.message).toMatch(/needs TS muxings/);
		expect(issues[0]?.level).toBe("error");
		expect(issues[1]?.message).toMatch(/do not expect to accept FMP4/);
		expect(issues[1]?.level).toBe("warning");
		expect(issues[1]?.message).toMatch(/unverified/);
	});

	it("a manifest written somewhere ELSE does not satisfy the output", () => {
		// The destination filter on MANIFESTS was unpinned: every fixture aimed
		// its manifests at the MSL output, so deleting the filter left the suite
		// green (review-4 #8). This arm kills that mutation.
		const issues = c31(
			mslPlan({
				streamFormat: "HLS",
				muxingKind: "TS",
				manifestKinds: ["HLS"],
				manifestTo: "s3",
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/missing HLS/);
	});

	it("DASH needs a DASH manifest, and says which one is missing", () => {
		const issues = c31(
			mslPlan({
				streamFormat: "DASH",
				muxingKind: "FMP4",
				manifestKinds: ["DASH"],
			}),
		);
		expect(issues).toEqual([]);
		const missing = c31(
			mslPlan({
				streamFormat: "DASH",
				muxingKind: "FMP4",
				manifestKinds: [],
			}),
		);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.message).toMatch(/missing DASH/);
		expect(missing[0]?.level).toBe("error");
	});

	it("a DASH output carrying an HLS manifest too is CMAF wearing a DASH label", () => {
		// review-5 I3: `forbiddenManifests` was declared three times and read
		// zero times, and this is the case it was named for — it passed
		// silently. Warning, for the same reason the container half is.
		const issues = c31(
			mslPlan({
				streamFormat: "DASH",
				muxingKind: "FMP4",
				manifestKinds: ["DASH", "HLS"],
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.level).toBe("warning");
		expect(issues[0]?.message).toMatch(/do not expect to accept HLS manifest/);
	});

	it("SMOOTH is refused by every format — MSL has no Smooth family at all", () => {
		for (const streamFormat of ["DASH", "HLS", "CMAF"] as const) {
			const manifestKinds =
				streamFormat === "DASH"
					? (["DASH", "SMOOTH"] as const)
					: streamFormat === "HLS"
						? (["HLS", "SMOOTH"] as const)
						: (["DASH", "HLS", "SMOOTH"] as const);
			const issues = c31(
				mslPlan({
					streamFormat,
					muxingKind: streamFormat === "HLS" ? "TS" : "FMP4",
					manifestKinds: [...manifestKinds],
				}),
			);
			expect(issues, `${streamFormat} must object to SMOOTH`).toHaveLength(1);
			expect(issues[0]?.message).toMatch(/SMOOTH/);
		}
	});

	it("counts a DRM'd muxing, which has no destination of its own", () => {
		// review-5 I1: this route shipped UNPINNED and the mutation survived
		// the whole 2388-test suite. A CENC ladder's muxings write through the
		// DRM entry, so a checker reading only `muxing.destination` tells a
		// correct plan it has no muxings at all.
		expect(
			c31(
				mslPlan({
					streamFormat: "CMAF",
					muxingKind: "FMP4",
					manifestKinds: ["DASH", "HLS"],
					viaDrm: true,
				}),
			),
		).toEqual([]);
	});

	it("judges the DRM route rather than merely tolerating it", () => {
		// The negative twin. Without it the arm above passes just as well when
		// the checker does nothing at all for DRM'd muxings.
		const issues = c31(
			mslPlan({
				streamFormat: "HLS",
				muxingKind: "FMP4",
				manifestKinds: ["HLS"],
				viaDrm: true,
			}),
		);
		expect(issues).toHaveLength(2);
		expect(issues[0]?.message).toMatch(/needs TS muxings/);
		expect(issues[1]?.message).toMatch(/do not expect to accept FMP4/);
	});

	it("counts what a delivery mirror carries to the MSL output", () => {
		// The other unpinned route. The muxing points at "s3"; the mirror is
		// what puts it on MSL, so an MSL output appears in no destination and
		// still receives everything.
		expect(
			c31(
				mslPlan({
					streamFormat: "CMAF",
					muxingKind: "FMP4",
					manifestKinds: ["DASH", "HLS"],
					viaMirror: true,
				}),
			),
		).toEqual([]);
	});

	it("judges the mirror route rather than merely tolerating it", () => {
		const issues = c31(
			mslPlan({
				streamFormat: "CMAF",
				muxingKind: "FMP4",
				manifestKinds: ["DASH", "HLS"],
				viaMirror: true,
				extraMuxing: "WEBM",
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/do not expect to accept WEBM/);
	});

	it("sees the QC mirror MP4 the COMPILER synthesizes, which the plan never declares", () => {
		// review-6 I3, and the root cause it named: C31 judges `plan.muxings`,
		// while the compiler emits `qc-muxing:<rendition>` → CREATE_MUXING_MP4
		// to `renditionOutputBase(...)` whenever qc.vmaf or qc.psnr is on. So a
		// ladder pointed at an MSL output writes MP4 files there that appear
		// nowhere in the plan — and MP4 is on every format's `forbidden` list
		// precisely to stop that.
		const plan = mslPlan({
			streamFormat: "HLS",
			muxingKind: "TS",
			manifestKinds: ["HLS"],
		}) as unknown as Record<string, unknown>;
		expect(c31(plan)).toEqual([]);
		const withQc = encodingPlanSchema.parse({
			...plan,
			qc: { vmaf: true },
		});
		const issues = c31(withQc);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/do not expect to accept MP4/);
	});

	it("names the VP9 mirror's REAL container — WebM, not MP4 (review-324 I1)", () => {
		//  moved the VP9 mirror to a progressive WebM and said two
		// readers "cannot drift"; this checker was the third, with "MP4"
		// hard-coded, so a VP9 ladder on an MSL output was refused for a file
		// the compiler never writes. Same verdict (WebM is forbidden on every
		// MSL format too), wrong diagnosis — and the diagnosis is what an
		// operator debugging a real Akamai delivery reads.
		const plan = mslPlan({
			streamFormat: "HLS",
			muxingKind: "TS",
			manifestKinds: ["HLS"],
		}) as unknown as Record<string, unknown>;
		const vp9 = encodingPlanSchema.parse({
			...plan,
			renditions: [
				{
					key: "v",
					codec: "VP9",
					ingestKey: "video",
					height: 360,
					bitrate: 300000,
				},
			],
			qc: { vmaf: true },
		});
		const issues = c31(vp9);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/WEBM/);
		expect(issues[0]?.message).not.toMatch(/accept MP4/);
	});

	it("does not demand delivery muxings from a qc.only plan, but still judges what it writes", () => {
		// Two halves of one decision. Under qc.only the compiler builds no
		// delivery muxings and no manifests, so objecting that they are missing
		// judges a topology nobody constructs. What it DOES build is the mirror
		// MP4 — my first cut returned early on qc.only and lost exactly that.
		const bare = mslPlan({
			streamFormat: "CMAF",
			muxingKind: "FMP4",
			manifestKinds: [],
		}) as unknown as Record<string, unknown>;
		// Without qc.only this is one error naming BOTH missing families (the
		// checker lists them in a single message rather than one per family).
		const plain = c31(encodingPlanSchema.parse(bare));
		expect(plain).toHaveLength(1);
		expect(plain[0]?.level).toBe("error");
		expect(plain[0]?.message).toMatch(/missing DASH, HLS/);
		const qcOnly = encodingPlanSchema.parse({
			...bare,
			qc: { vmaf: true, only: true },
		});
		const issues = c31(qcOnly);
		// The missing-manifest errors are gone; the mirror MP4 is not.
		expect(issues).toHaveLength(1);
		expect(issues[0]?.level).toBe("warning");
		expect(issues[0]?.message).toMatch(/do not expect to accept MP4/);
	});

	it("does not demand the format's own CONTAINER from a qc.only plan either", () => {
		// The muxings half of the same guard, and it needs its own arm: the
		// case above declares a container that already satisfies the format, so
		// removing `!input.qcOnly` from the missing-container check changed
		// nothing and the mutation SURVIVED. Here the declared container is
		// wrong for the format, which is what makes the guard observable.
		const bare = mslPlan({
			streamFormat: "HLS",
			muxingKind: "FMP4",
			manifestKinds: [],
		}) as unknown as Record<string, unknown>;
		const plain = c31(encodingPlanSchema.parse(bare));
		expect(
			plain.filter((i) => i.level === "error").map((i) => i.message),
		).toEqual([
			expect.stringMatching(/needs TS muxings/),
			expect.stringMatching(/missing HLS/),
		]);
		const qcOnly = c31(
			encodingPlanSchema.parse({ ...bare, qc: { vmaf: true, only: true } }),
		);
		// Nothing is BUILT to satisfy either demand, so neither is made.
		expect(qcOnly.filter((i) => i.level === "error")).toEqual([]);
		// What is built — the wrong container it declares, plus the mirror —
		// is still reported.
		expect(qcOnly.map((i) => i.message).join(" ")).toMatch(
			/do not expect to accept FMP4, MP4/,
		);
	});

	it("counts MANIFESTS a delivery mirror carries, not only muxings", () => {
		// review-6 I2. `manifestKindsReaching` has its own mirror branch, and
		// nulling it left all 2,398 core tests green because every fixture
		// pointed its manifests straight at the MSL output. Here they point at
		// "s3" and only the mirror puts them on MSL.
		expect(
			c31(
				mslPlan({
					streamFormat: "CMAF",
					muxingKind: "FMP4",
					manifestKinds: ["DASH", "HLS"],
					viaMirror: true,
					manifestsViaMirror: true,
				}),
			),
		).toEqual([]);
	});

	it("judges the manifest mirror route rather than merely tolerating it", () => {
		// The negative twin: mirrored manifests that are WRONG for the format
		// must still be reported, or the arm above passes just as well when the
		// branch attributes nothing.
		const issues = c31(
			mslPlan({
				streamFormat: "HLS",
				muxingKind: "TS",
				manifestKinds: ["HLS", "SMOOTH"],
				viaMirror: true,
				manifestsViaMirror: true,
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/do not expect to accept SMOOTH/);
	});

	it("refuses a streamFormat that only LOOKS like a table key", () => {
		// review-6 S8. `REQUIREMENTS["constructor"]` is truthy and has no
		// `.muxings`, so a truthiness test would throw rather than skip. Every
		// caller passes parsed data, which is why this calls the checker
		// directly — latent is not the same as absent.
		expect(() =>
			checkAkamaiMslConstraints({
				encodingKind: "VOD",
				credentialHasPublishingAuth: undefined,
				outputs: [
					{ key: "msl", kind: "AKAMAI_MSL", streamFormat: "constructor" },
				],
				muxings: [],
				manifests: [],
			}),
		).not.toThrow();
		expect(
			checkAkamaiMslConstraints({
				encodingKind: "VOD",
				credentialHasPublishingAuth: undefined,
				outputs: [
					{ key: "msl", kind: "AKAMAI_MSL", streamFormat: "constructor" },
				],
				muxings: [],
				manifests: [],
			}),
		).toEqual([]);
	});

	/**
	 * Segment naming — the rule real contact found (2026-08-21).
	 *
	 * Everything above is about containers and manifests. This is the one that
	 * cost a full provision: thirty ops, every resource created, and then
	 * `live/start` refused with code 2025 because our S3-shaped default segment
	 * names do not match the grammar Akamai requires. Nobody had written a BAD
	 * name; they had written none, and the schema default filled it in.
	 */
	describe("segment naming (measured — Bitmovin code 2025)", () => {
		it("refuses a muxing whose plan never mentioned segmentNaming", () => {
			/*
			 * Written `null` here, but the checker never sees `undefined` on a
			 * PARSED plan — `encodingPlanSchema` fills the per-kind default
			 * first, so what arrives is the S3-shaped `seg_%number%.ts`. That
			 * is precisely the defect's shape and worth stating: the operator
			 * wrote nothing, the schema wrote something, and Akamai refused it.
			 * (My first version of this test asserted the word "unset" and
			 * failed — the `undefined` branch only fires for a caller passing a
			 * raw object, which is why it still exists.)
			 */
			const plan = mslPlan({
				streamFormat: "HLS",
				muxingKind: "TS",
				manifestKinds: ["HLS"],
				segmentNaming: null,
			});
			// The muxing union includes kinds with no segmentNaming (MP4), so
			// read it off a narrowed record rather than the union.
			// The schema fills the S3-shaped default on parse — which is exactly
			// the shape Bitmovin refused (arm 1 of the measured matrix).
			const parsed = plan.muxings[0] as { segmentNaming?: string };
			expect(parsed.segmentNaming).toBe("seg_%number%.ts");
			const naming = validatePlan(plan).filter((i) =>
				/segmentNaming/.test(i.path ?? ""),
			);
			expect(naming).toHaveLength(1);
			expect(naming[0]?.level).toBe("error");
			expect(naming[0]?.message).toContain("rand_chars");
		});

		it("refuses the S3-shaped default explicitly", () => {
			// The exact string the schema would have filled in, and the exact
			// string the real API refused.
			const issues = validatePlan(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					segmentNaming: "seg_%number%.ts",
				}),
			);
			expect(issues.some((i) => /segmentNaming/.test(i.path ?? ""))).toBe(true);
		});

		it("accepts the grammar that actually reached RUNNING", () => {
			// The literal token, verbatim — the ONLY config Bitmovin starts
			// (measured four-arm matrix; this one ran, published and PLAYED).
			const issues = validatePlan(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					segmentNaming: "seg-{rand_chars:8}-%number%.ts",
				}),
			);
			expect(issues.filter((i) => /segmentNaming/.test(i.path ?? ""))).toEqual(
				[],
			);
		});

		it("accepts the grammar WITHOUT the optional character count", () => {
			// The API documents `[:number]` as optional; a rule that demanded it
			// would refuse a plan Akamai accepts.
			const issues = validatePlan(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					segmentNaming: "chunk-{rand_chars}-%number%.ts",
				}),
			);
			expect(issues.filter((i) => /segmentNaming/.test(i.path ?? ""))).toEqual(
				[],
			);
		});

		it("refuses a PRE-EXPANDED name — the shape reading lost", () => {
			// `seg-k7Qw2xP9-%number%.ts` looks like what the token would
			// produce, and Bitmovin refused it at live/start (code 2025,
			// measured). The check wants the token itself, so C31 must too —
			// accepting this would green a plan that cannot start.
			const issues = validatePlan(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					segmentNaming: "seg-k7Qw2xP9-%number%.ts",
				}),
			);
			expect(issues.some((i) => /segmentNaming/.test(i.path ?? ""))).toBe(true);
		});

		it("refuses a TEMPLATE on the MSL path — measured, not inferred", () => {
			// Per the SDK docs the template is the right field; per the real
			// API, MSL live/start refuses it (nothing conforming sits in
			// segmentNaming when the check runs). An intermediate revision of
			// the wizard emitted the template BECAUSE the docs say to, and
			// every MSL channel it built was unable to start.
			const plan = mslPlan({
				streamFormat: "HLS",
				muxingKind: "TS",
				manifestKinds: ["HLS"],
				segmentNaming: null,
			});
			const withTemplate = {
				encodingKind: "VOD" as const,
				credentialHasPublishingAuth: undefined,
				...plan,
				muxings: plan.muxings.map((m) => ({
					...m,
					segmentNamingTemplate: "seg-{rand_chars:8}-%number%.ts",
				})),
			};
			const issues = checkAkamaiMslConstraints(withTemplate);
			expect(
				issues.some((i) => /segmentNamingTemplate/.test(i.path ?? "")),
			).toBe(true);
		});

		it("says nothing about a muxing that writes somewhere ELSE", () => {
			// Scope. The rule is about what reaches MSL; an S3 sibling with our
			// ordinary naming is perfectly fine and must not be flagged.
			const issues = validatePlan(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					muxingTo: "s3",
					segmentNaming: null,
				}),
			);
			expect(issues.filter((i) => /segmentNaming/.test(i.path ?? ""))).toEqual(
				[],
			);
		});
	});

	it("tolerates CHUNKED_TEXT beside any ladder — subtitles are not a container clash", () => {
		// Why `forbidden` is a list rather than "anything unlisted": a WebVTT
		// companion is legal on every format, and a subset check would refuse
		// a correct plan.
		expect(
			c31(
				mslPlan({
					streamFormat: "HLS",
					muxingKind: "TS",
					manifestKinds: ["HLS"],
					extraMuxing: "CHUNKED_TEXT",
				}),
			),
		).toEqual([]);
	});

	it("CMAF needs BOTH manifests — one is not enough", () => {
		expect(
			c31(
				mslPlan({
					streamFormat: "CMAF",
					muxingKind: "FMP4",
					manifestKinds: ["DASH"],
				}),
			),
		).toHaveLength(1);
		expect(
			c31(
				mslPlan({
					streamFormat: "CMAF",
					muxingKind: "FMP4",
					manifestKinds: ["DASH", "HLS"],
				}),
			),
		).toEqual([]);
	});

	it("is scoped BY DESTINATION — a muxing bound for S3 does not satisfy MSL", () => {
		// The failure a plan-wide check would miss: the right muxing kind
		// exists in the plan, and none of it reaches the MSL output.
		const issues = c31(
			mslPlan({
				streamFormat: "HLS",
				muxingKind: "TS",
				manifestKinds: ["HLS"],
				muxingTo: "s3",
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/it has none/);
	});
});
