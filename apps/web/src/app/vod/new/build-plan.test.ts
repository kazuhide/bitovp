import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compilePlan,
	DEFAULT_VMAF_MODEL,
	encodingPlanSchema,
	validatePlan,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	applyMirrorCredentialSelection,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	remapEncodingKeyRefs,
	remapInputKeyRefs,
	type WizardH265Options,
	type WizardKantar,
	type WizardState,
	type WizardVideoRendition,
} from "./build-plan";

const fixturesDir = join(
	__dirname,
	"../../../../../../packages/core/src/plan/__fixtures__",
);

function loadFixture(name: string) {
	return JSON.parse(
		readFileSync(join(fixturesDir, `${name}.plan.json`), "utf8"),
	);
}

describe("buildPlan", () => {
	it.each([
		"H264",
		"H265",
		"VP9",
		"AV1",
	] as const)("clears stale bitrate for %s per-title templates", (codec) => {
		for (const mode of [
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		] as const) {
			const plan = buildPlan({
				...DEFAULT_WIZARD_STATE,
				videos: [{ codec, height: 360, bitrate: 300_000, extras: { mode } }],
			});
			expect(plan.renditions[0]).toHaveProperty("bitrate", null);
		}
	});
	it("compiles a stale standard bitrate into a valid Per-Title start without a codec bitrate", () => {
		const plan = encodingPlanSchema.parse(
			buildPlan({
				...DEFAULT_WIZARD_STATE,
				name: "per-title-defaults",
				inputFiles: [
					{
						key: "main",
						inputKey: "main",
						kind: "S3",
						credentialId: "00000000-0000-4000-8000-000000000001",
						bucket: "input-bucket",
						path: "clip.mp4",
					},
				],
				output: {
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "output-bucket",
					basePath: "per-title-defaults/",
					publicRead: true,
					name: "Output",
				},
				videos: [
					{
						codec: "H264",
						height: 360,
						bitrate: 300_000,
						extras: { mode: "PER_TITLE_TEMPLATE" },
					},
				],
				startOptions: { perTitle: { h264: { autoRepresentations: true } } },
				timing: "POST_ENCODING",
			}),
		);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const operations = compilePlan(plan);
		const codec = operations.find(
			(operation) => operation.kind === "CREATE_CODEC_H264",
		);
		expect(codec).toBeDefined();
		expect(codec?.payload).not.toHaveProperty("bitrate");
		expect(
			operations.find((operation) => operation.kind === "START_ENCODING")
				?.payload,
		).toMatchObject({
			perTitle: { h264Configuration: { autoRepresentations: {} } },
		});
	});
	it("reproduces the hls-on-aws acceptance fixture from wizard state", () => {
		const state: WizardState = {
			name: "h264-aac-fmp4-fixed-bitrate-hls-aws",
			accountId: "",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "sample-input-bucket",
					path: "sintel/Sintel.2010.1080p.mkv",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/",
				publicRead: true,
				name: "Test S3 Output",
			},
			videos: [
				{ height: 360, bitrate: 300_000 },
				{ height: 540, bitrate: 600_000 },
			],
			audios: [
				{ bitrate: 128_000, rate: 48_000 },
				{ bitrate: 64_000, rate: 44_100 },
			],
			audioGuard: false,
			// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
			manifests: {
				hls: true,
				dash: false,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("fixed-bitrate-hls-on-aws")),
		);
	});

	it("reproduces the multi-output fixture from FORM state — mirrors ride additionalOutputs (ledger #115 PR-b)", () => {
		const state: WizardState = {
			name: "Synthetic Multi-Output S3+GCS (multi-output-s3-gcs)",
			accountId: "",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "sample-input-bucket",
					path: "/path/to/your/input/video.mp4",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [
				{
					credentialId: "00000000-0000-4000-8000-000000000003",
					kind: "GCS",
					bucket: "sample-mirror-bucket",
					name: "Test GCS Mirror Output",
				},
			],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath: "output/multi-output-s3-gcs/",
				publicRead: true,
				name: "Test S3 Output",
			},
			videos: [{ height: 720, bitrate: 3_000_000 }],
			audios: [{ bitrate: 128_000, rate: 48_000 }],
			audioGuard: false,
			manifests: {
				hls: true,
				dash: false,
				hlsOptions: { masterVersion: "HLS_V6", mediaVersion: "HLS_V6" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("multi-output-s3-gcs")),
		);
	});

	it("reproduces the sftp post-encoding fixture (SFTP output, both manifests)", () => {
		const state: WizardState = {
			name: "h264-aac-fmp4-dash-hls-sftp-output-post-encoding",
			accountId: "",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "sample-input-bucket",
					path: "big_buck_bunny_1080p_h264_short.mov",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000003",
				kind: "SFTP",
				bucket: "",
				basePath:
					"/content/encoding_test/h264-aac-fmp4-dash-hls-sftp-output-post-encoding/",
				publicRead: false,
				name: "Test SFTP Output",
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
			timing: "POST_ENCODING",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("dash-hls-sftp-output-post-encoding"),
			),
		);
	});

	it("reproduces the sftp just-in-time fixture (timing radio only)", () => {
		const state: WizardState = {
			name: "h264-aac-fmp4-dash-hls-sftp-output-just-in-time",
			accountId: "",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "sample-input-bucket",
					path: "big_buck_bunny_1080p_h264_short.mov",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000003",
				kind: "SFTP",
				bucket: "",
				basePath:
					"/content/encoding_test/h264-aac-fmp4-dash-hls-sftp-output-just-in-time/",
				publicRead: false,
				name: "Test SFTP Output",
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("dash-hls-sftp-output-just-in-time"),
			),
		);
	});

	it("reproduces the streamcondition fixture via the audio-guard toggle", () => {
		const state: WizardState = {
			name: "h264-aac-fmp4-fixed-bitrate-dash-hls-with-stream-condition-aws",
			accountId: "",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "sample-input-bucket",
					path: "sintel/Sintel.2010.1080p.mkv",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "sample-output-bucket",
				basePath:
					"output/h264-aac-fmp4-fixed-bitrate-dash-hls-with-stream-condition-aws/",
				publicRead: true,
				name: "Test S3 Output",
			},
			videos: [
				{ height: 360, bitrate: 300_000 },
				{ height: 540, bitrate: 600_000 },
			],
			audios: [
				{ bitrate: 128_000, rate: 48_000 },
				{ bitrate: 64_000, rate: 44_100 },
			],
			audioGuard: true,
			// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("fixed-bitrate-dash-hls-streamcondition-on-aws"),
			),
		);
	});

	it("suffixes keys for same-height multi-bitrate ladders", () => {
		const plan = buildPlan({
			name: "x",
			accountId: "",
			cloudRegion: "AUTO",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
					path: "in.mp4",
					name: "S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "b",
				basePath: "output/x/",
				publicRead: true,
				name: "S3 Output",
			},
			videos: [
				{ height: 1080, bitrate: 4_000_000 },
				{ height: 1080, bitrate: 8_000_000 },
			],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		});
		const keys = (plan.renditions ?? []).map((r) => r.key);
		expect(keys).toContain("v1080_4000k");
		expect(keys).toContain("v1080_8000k");
		expect(plan.muxings?.[0]?.destination?.path).toBe(
			"output/x/video/1080_4000k",
		);
	});

	it("keeps the wizard-built P1 plans free of the new optional sections", () => {
		// Guards the additive-defaults contract directly: a default-shaped
		// state emits none of the 8b keys, so the P1 fixtures cannot drift.
		const plan = buildPlan({
			name: "x",
			accountId: "",
			cloudRegion: "AUTO",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
					path: "in.mp4",
					name: "S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "b",
				basePath: "output/x/",
				publicRead: true,
				name: "S3 Output",
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		});
		for (const key of [
			"encodings",
			"fileStreams",
			"dolbyStreams",
			"filters",
			"drm",
			"keyframes",
			"sprites",
			"perTitle",
			"aiSceneAnalysis",
		]) {
			expect(plan).not.toHaveProperty(key);
		}
	});

	it("normalizes a base path without trailing slash", () => {
		const state: WizardState = {
			name: "x",
			accountId: "",
			cloudRegion: "AUTO",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
					path: "in.mp4",
					name: "S3 Input",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "b",
				basePath: "output/x",
				publicRead: true,
				name: "S3 Output",
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		};
		const plan = buildPlan(state);
		expect(plan.muxings?.[0]?.destination?.path).toBe("output/x/video/360p");
		expect(plan.manifests?.[0]?.destination.path).toBe("output/x/");
	});

	it.each([
		"H264",
		"H265",
	] as const)("gives every newly-authored %s Per-Title template a stable path marker", (codec) => {
		const state: WizardState = {
			name: `per-title-${codec.toLowerCase()}`,
			accountId: "",
			cloudRegion: "AUTO",
			encoderVersion: "STABLE",
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "b",
					path: "in.mp4",
				},
			],
			additionalOutputs: [],
			output: {
				credentialId: "00000000-0000-4000-8000-000000000002",
				kind: "S3",
				bucket: "b",
				basePath: "output/customer/",
				publicRead: true,
				name: "S3 Output",
			},
			videos: [180, 1080].map((height) => ({
				height,
				bitrate: null,
				codec,
				extras: { mode: "PER_TITLE_TEMPLATE" },
			})),
			audios: [],
			audioGuard: false,
			manifests: { hls: false, dash: true },
			timing: "POST_ENCODING",
			startOptions: {
				perTitle:
					codec === "H264"
						? { h264: { autoRepresentations: true } }
						: { h265: { autoRepresentations: true } },
			},
		};
		const plan = buildPlan(state);
		expect(plan.muxings?.map((muxing) => muxing.destination?.path)).toEqual([
			"output/customer/video/v180/{height}p_{bitrate}_{uuid}",
			"output/customer/video/v1080/{height}p_{bitrate}_{uuid}",
		]);
	});
});

/**
 * P2 8b golden assertions — structured form state reproduces the new
 * fixture families byte-equal (parse → deep-equal, same as the P1 bar).
 * Every encoding examples fixture is now form-reachable; the expert import path
 * (plan-import.ts) remains for hand-written plans and any future surface not
 * yet modeled by the form (e.g. start-request trimming).
 */
describe("buildPlan (P2 structured forms)", () => {
	const awsMain = {
		key: "main",
		inputKey: "main",
		kind: "S3" as const,
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucket: "sample-input-bucket",
		path: "{YOUR INPUT FILE PATH}",
		name: "Test S3 Input",
	};
	const aws = {
		accountId: "",
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		inputFiles: [awsMain],
		additionalOutputs: [],
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			kind: "S3" as const,
			bucket: "sample-output-bucket",
			basePath: "",
			publicRead: true,
			name: "Test S3 Output",
		},
	};

	it("reproduces the cenc-cbc fixture from DRM rows with derived ivSize (C9)", () => {
		const cenc = (muxingKey: string, name: string) => ({
			kind: "CENC" as const,
			muxingKey,
			credentialId: "00000000-0000-4000-8000-000000000005",
			kid: "43214321432143214321432143214321",
			encryptionMode: "CBC" as const,
			widevinePssh: "CAESEAABAgMEBQYHCAkKCwwNDg8aCmludGVydHJ1c3QiASo=",
			playReadyLaUrl: "http://pr.test.drm.com/playready/RightsManager.asmx",
			fairPlayIv: "00000000000000000000000000000000",
			fairPlayUri: "skd://fairplay_token",
			name,
		});
		const state: WizardState = {
			...aws,
			name: "cenc-cbc-drm-wv-pr-fp-dash-hls-aws",
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/cenc-cbc-drm-wv-pr-fp-dash-hls-aws/",
			},
			videos: [
				{ height: 1080, bitrate: 2_500_000 },
				{ height: 720, bitrate: 1_200_000 },
				{ height: 480, bitrate: 750_000 },
				{ height: 360, bitrate: 400_000 },
				{ height: 240, bitrate: 150_000 },
			],
			audios: [{ bitrate: 128_000, rate: 48_000 }],
			audioGuard: true,
			drm: [
				...["v1080", "v720", "v480", "v360", "v240"].map((key) =>
					cenc(key, "Video FMP4 CENC"),
				),
				cenc("a128", "Audio FMP4 CENC"),
			],
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: {
					masterVersion: "HLS_V6",
					mediaVersion: "HLS_V6",
					drmKind: "CENC",
				},
				dashOptions: { audioLanguage: "en", drmKind: "CENC" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("cenc-cbc-drm-on-aws")),
		);
	});

	it("reproduces the per-title H265 fixture from advanced + per-title forms", () => {
		const tuning: WizardH265Options = {
			profile: "MAIN",
			rate: null,
			minKeyframeInterval: 2,
			maxKeyframeInterval: 2,
			rcLookahead: 60,
			subMe: 5,
			maxCtuSize: "S64",
			motionSearch: "STAR",
			tuIntraDepth: "D4",
			tuInterDepth: "D4",
			weightPredictionOnPSlice: true,
			weightPredictionOnBSlice: true,
			sceneCutThreshold: 40,
			motionSearchRange: 92,
			adaptiveQuantizationMode: "AUTO_VARIANCE_DARK_SCENES",
			psyRateDistortionOptimization: 0,
			psyRateDistortionOptimizedQuantization: 0,
			qpMin: 15,
			sao: true,
			colorConfig: {
				colorSpace: "BT709",
				colorPrimaries: "BT709",
				colorTransfer: "BT709",
			},
		};
		const fixedRange = {
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 1_500_000,
			highComplexityBoundaryForMaxBitrate: 3_200_000,
		};
		const template = (
			height: number,
			adaptiveQuantizationStrength: number,
		): WizardVideoRendition => ({
			height,
			bitrate: null,
			codec: "H265",
			h265: { ...tuning, adaptiveQuantizationStrength },
			extras: { mode: "PER_TITLE_TEMPLATE" },
			muxing: {
				segmentNaming: "seg_%number%.m4s",
				path: `video/v${height}/{height}p_{bitrate}_{uuid}/`,
			},
		});
		const fixed = (
			height: number,
			adaptiveQuantizationStrength: number,
			minBitrate: number,
			maxBitrate: number,
			key?: string,
		): WizardVideoRendition => ({
			height,
			bitrate: null,
			codec: "H265",
			h265: { ...tuning, adaptiveQuantizationStrength },
			extras: {
				...(key ? { key } : {}),
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: { minBitrate, maxBitrate, ...fixedRange },
			},
			muxing: {
				segmentNaming: "seg_%number%.m4s",
				path: `video/${key ?? `v${height}`}/{height}p_{bitrate}_{uuid}/`,
			},
		});
		const state: WizardState = {
			...aws,
			name: "per-title-h265-aac-fmp4-dash-hls-aws",
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/per-title-h265-aac-fmp4-dash-hls-aws/",
			},
			videos: [
				template(180, 1.2),
				fixed(480, 1.2, 210_000, 350_000, "v480-210"),
				fixed(480, 1.2, 420_000, 630_000, "v480-420"),
				fixed(540, 1.2, 700_000, 980_000),
				fixed(720, 1, 1_250_000, 1_700_000),
				template(900, 0.8),
				template(1080, 0.5),
			],
			audios: [
				{
					bitrate: 128_000,
					rate: 48_000,
					extras: { name: "AAC Codec Configuration" },
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						name: "Audio FMP4 Muxing",
						path: "audio/",
					},
				},
			],
			audioGuard: true,
			manifests: {
				hls: false,
				dash: false,
				// The sample writes DASH before HLS — extra rows keep order.
				extra: [
					{ kind: "DASH", key: "dash", dash: { audioLanguage: "en" } },
					{
						kind: "HLS",
						key: "hls",
						hls: { masterVersion: "HLS_V6", mediaVersion: "HLS_V6" },
					},
				],
			},
			timing: "POST_ENCODING",
			startOptions: {
				encodingMode: "THREE_PASS",
				perTitle: {
					h265: {
						minBitrate: 128_000,
						maxBitrate: 3_200_000,
						codecMinBitrateFactor: 0.8,
						codecMaxBitrateFactor: 1.2,
						codecBufsizeFactor: 2,
						targetQualityCrf: 17,
						maxBitrateStepSize: 4,
						forcedRenditionAboveHighestFixedRepresentation: 1,
						forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							"LAST_CALCULATED_BITRATE",
					},
				},
			},
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("pertitle-h265-fmp4-dash-hls-on-aws"),
			),
		);
	});

	it("reproduces the AI Scene Analysis passthrough fixture (video-only, MP4)", () => {
		const state: WizardState = {
			...aws,
			name: "h264-mp4-ai-scene-analysis-passthrough-aws",
			encoderVersion: "BETA",
			inputFiles: [{ ...awsMain, path: "big_buck_bunny_1080p_h264.mov" }],
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/h264-mp4-ai-scene-analysis-passthrough-aws/",
			},
			videos: [
				{
					height: 180,
					bitrate: 200_000,
					h264: {
						profile: "HIGH",
						minKeyframeInterval: 2,
						maxKeyframeInterval: 2,
						colorConfig: {
							copyColorPrimariesFlag: true,
							copyColorTransferFlag: true,
							copyColorSpaceFlag: true,
						},
						refFrames: 4,
						bframes: 3,
						cabac: true,
						adaptiveSpatialTransform: true,
						weightedPredictionPFrames: "SMART",
					},
					extras: { streamName: "Stream H264 AI Scene Analysis" },
					muxing: {
						kind: "MP4",
						filename: "180p.mp4",
						name: "Video MP4 Muxing",
						path: "video",
					},
				},
			],
			// No audio rendition ⇒ the implicit audio ingest track is omitted.
			audios: [],
			audioGuard: false,
			manifests: { hls: false, dash: false },
			timing: "POST_ENCODING",
			startOptions: {
				aiSceneAnalysis: {
					filename: "h264-mp4-ai-scene-analysis-passthrough-aws.json",
					path: "ai",
					outputLanguageCodes: ["ja", "ko"],
				},
			},
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("ai-scene-analysis-passthrough")),
		);
	});

	it("reproduces the audio-only Atmos DAMF fixture from a dolbyStream source", () => {
		const state: WizardState = {
			...aws,
			name: "audio-only-dolbyatmos-damf-hls-dash-fmp4",
			inputFiles: [
				{ ...awsMain, path: "" },
				{
					...awsMain,
					key: "atmos1",
					path: "netflix-opencontent/SolLevante/atmos-damf/sollevante_lp_v01_DAMF_Nearfield_48k_24b_24/sollevante_lp_v01_DAMF_Nearfield_48k_24b_24.atmos",
				},
			],
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/audio-only-dolbyatmos-damf-hls-dash-fmp4/",
			},
			sources: {
				dolbyStreams: [
					{
						kind: "ATMOS",
						key: "atmos-in",
						inputFile: "atmos1",
						inputFormat: "DAMF",
					},
				],
			},
			videos: [],
			audios: [
				{
					bitrate: 448_000,
					rate: 48_000,
					codec: "DOLBY_ATMOS",
					extras: { key: "atmos448", source: "atmos-in" },
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						name: "Audio FMP4 Muxing 448000bps",
					},
				},
			],
			audioGuard: false,
			manifests: {
				hls: false,
				dash: false,
				extra: [
					{ kind: "DASH", key: "dash" },
					{
						kind: "HLS",
						key: "hls",
						hls: {
							masterVersion: "HLS_V8",
							mediaVersion: "HLS_V8",
							audioVariantStreams: true,
						},
					},
				],
			},
			timing: "POST_ENCODING",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("dolby-audio-only-atmos-damf")),
		);
	});

	it("reproduces the WebVTT fixture from a fileStream-fed subtitle track", () => {
		const state: WizardState = {
			...aws,
			name: "h264-aac-fmp4-fixed-bitrate-hls-vtt-aws",
			inputFiles: [
				{ ...awsMain, path: "sintel/Sintel.2010.1080p.mkv" },
				{ ...awsMain, key: "vtt1", path: "sintel/subtitles_en.vtt" },
			],
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/h264-aac-fmp4-fixed-bitrate-hls-vtt-aws/",
			},
			sources: {
				fileStreams: [{ key: "vtt-en", inputFile: "vtt1" }],
			},
			videos: [
				{ height: 360, bitrate: 300_000 },
				{ height: 540, bitrate: 600_000 },
			],
			audios: [
				{ bitrate: 128_000, rate: 48_000 },
				{ bitrate: 64_000, rate: 44_100 },
			],
			// Track fields stay unset — the schema defaults ARE the sample
			// values (label/language/groupId/uri); only the source and the
			// muxing path are user input.
			subtitles: [{ source: "vtt-en", muxing: { path: "en" } }],
			audioGuard: false,
			// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
			manifests: {
				hls: true,
				dash: false,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("fixed-bitrate-hls-vtt-on-aws")),
		);
	});

	it("reproduces the two-DASH segment-timeline fixture via extra manifests", () => {
		const muxing = (path: string, name: string) => ({
			segmentLength: 4,
			path,
			name,
		});
		const state: WizardState = {
			...aws,
			name: "h264-aac-fmp4-dash-template-and-timeline-aws",
			inputFiles: [{ ...awsMain, path: "big_buck_bunny_1080p_h264.mov" }],
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "output/h264-aac-fmp4-dash-template-and-timeline-aws/",
			},
			videos: [
				{
					height: 360,
					bitrate: 600_000,
					h264: { profile: "MAIN", presetConfiguration: "VOD_STANDARD" },
					extras: { name: "H264 360p", streamName: "Video 360p" },
					muxing: muxing("video/360p_600000", "Video FMP4 360p"),
				},
				{
					height: 720,
					bitrate: 1_500_000,
					h264: { profile: "HIGH", presetConfiguration: "VOD_STANDARD" },
					extras: { name: "H264 720p", streamName: "Video 720p" },
					muxing: muxing("video/720p_1500000", "Video FMP4 720p"),
				},
			],
			audios: [
				{
					bitrate: 128_000,
					rate: 48_000,
					extras: { streamName: "AAC 128kbps" },
					muxing: muxing("audio/128000", "Audio FMP4 128kbps"),
				},
			],
			audioGuard: false,
			manifests: {
				hls: false,
				dash: false,
				// Two DASH manifests of one kind — RepresentationType TEMPLATE
				// vs TIMELINE side by side (the dash-segment-timeline sample).
				extra: [
					{
						kind: "DASH",
						key: "template",
						manifestName: "template.mpd",
						name: "DASH (SegmentTemplate)",
						dash: { audioLanguage: "en" },
					},
					{
						kind: "DASH",
						key: "timeline",
						manifestName: "timeline.mpd",
						name: "DASH (SegmentTimeline)",
						dash: { audioLanguage: "en", representationType: "TIMELINE" },
					},
				],
			},
			timing: "POST_ENCODING",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("dash-template-and-timeline-on-aws"),
			),
		);
	});

	it("reproduces the DV/SDR 2-ladder multi-encoding fixture", () => {
		const planName = "dolbyvision-hdr10-sdr-2ladder-profile81-hls-dash-fmp4";
		const tuning: WizardH265Options = {
			minKeyframeInterval: 2,
			maxKeyframeInterval: 2,
			rcLookahead: 60,
			subMe: 5,
			maxCtuSize: "S64",
			motionSearch: "STAR",
			tuIntraDepth: "D4",
			tuInterDepth: "D4",
			weightPredictionOnPSlice: true,
			weightPredictionOnBSlice: true,
			sceneCutThreshold: 40,
			motionSearchRange: 92,
			adaptiveQuantizationMode: "AUTO_VARIANCE_DARK_SCENES",
			psyRateDistortionOptimization: 0,
			psyRateDistortionOptimizedQuantization: 0,
			qpMin: 15,
			sao: true,
		};
		const ladderVideo = (
			ladder: "dv81" | "sdr",
			label: "DV81" | "SDR",
			height: number,
			bitrate: number,
			adaptiveQuantizationStrength: number,
		): WizardVideoRendition => ({
			height,
			bitrate,
			codec: "H265",
			h265: {
				...tuning,
				dynamicRangeFormat:
					ladder === "dv81" ? "DOLBY_VISION_PROFILE_8_1" : "SDR",
				adaptiveQuantizationStrength,
				maxBitrate: bitrate * 2,
				bufsize: bitrate * 4,
			},
			extras: {
				key: `${ladder}-v${height}`,
				name: `H265 ${label} ${height}p`,
				streamName: `Stream H265 ${label} ${height}p`,
				source: `${ladder}-vision`,
				encodingKey: ladder,
				hlsVariantLabel: ladder,
				dashSetKey: `video-${ladder}`,
			},
			muxing: {
				segmentNaming: "seg_%number%.m4s",
				path: `video/${ladder}/${height}p_${bitrate}/`,
				name: `Video FMP4 ${label} ${height}p`,
			},
		});
		const state: WizardState = {
			...aws,
			name: planName,
			inputFiles: [
				{ ...awsMain, path: "" },
				{ ...awsMain, key: "aac1", path: "<INSERT_AAC_2_0_MEZZANINE_PATH>" },
				{ ...awsMain, key: "dvvid1", path: "<INSERT_DOLBY_VISION_VIDEO_PATH>" },
				{
					...awsMain,
					key: "dvmeta1",
					path: "<INSERT_DOLBY_VISION_METADATA_PATH>",
				},
				{ ...awsMain, key: "atmos1", path: "<INSERT_DOLBY_ATMOS_DAMF_PATH>" },
			],
			additionalOutputs: [],
			output: { ...aws.output, basePath: `output/${planName}/` },
			sources: {
				encodings: [
					{ key: "dv81", name: `${planName}-dv81` },
					{ key: "sdr", name: `${planName}-sdr` },
				],
				tracks: [
					{
						key: "aac-audio",
						inputFile: "aac1",
						selectionMode: "AUDIO_RELATIVE",
						position: 0,
						encodingKey: "dv81",
					},
				],
				dolbyStreams: [
					{
						kind: "VISION",
						key: "dv81-vision",
						videoInputFile: "dvvid1",
						metadataInputFile: "dvmeta1",
						encodingKey: "dv81",
					},
					{
						kind: "VISION",
						key: "sdr-vision",
						videoInputFile: "dvvid1",
						metadataInputFile: "dvmeta1",
						encodingKey: "sdr",
					},
					{
						kind: "ATMOS",
						key: "atmos-in",
						inputFile: "atmos1",
						inputFormat: "DAMF",
						encodingKey: "dv81",
					},
				],
			},
			videos: [
				ladderVideo("dv81", "DV81", 2160, 15_000_000, 0.5),
				ladderVideo("dv81", "DV81", 1080, 6_000_000, 0.8),
				ladderVideo("dv81", "DV81", 720, 3_000_000, 1),
				ladderVideo("dv81", "DV81", 540, 1_800_000, 1.2),
				ladderVideo("sdr", "SDR", 2160, 12_000_000, 0.5),
				ladderVideo("sdr", "SDR", 1080, 5_000_000, 0.8),
				ladderVideo("sdr", "SDR", 720, 2_500_000, 1),
				ladderVideo("sdr", "SDR", 540, 1_500_000, 1.2),
			],
			audios: [
				{
					bitrate: 448_000,
					rate: 48_000,
					codec: "DOLBY_ATMOS",
					extras: {
						key: "atmos448",
						streamName: "Stream ATMOS 448000bps",
						source: "atmos-in",
						encodingKey: "dv81",
						dashSetKey: "audio-atmos",
						hlsMedia: {
							groupId: "atmos",
							name: "English Atmos",
							uri: "audio_atmos_448000.m3u8",
							isDefault: false,
							autoselect: true,
						},
					},
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						path: "audio/atmos/448000/",
						name: "Audio FMP4 ATMOS 448000bps",
					},
				},
				{
					bitrate: 128_000,
					rate: 48_000,
					extras: {
						key: "aac128",
						name: "AAC 128000bps",
						streamName: "Stream AAC 128000bps",
						source: "aac-audio",
						encodingKey: "dv81",
						dashSetKey: "audio-aac",
						hlsMedia: {
							groupId: "aac",
							name: "English AAC",
							uri: "audio_aac_128000.m3u8",
							isDefault: true,
							autoselect: true,
						},
					},
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						path: "audio/aac/128000/",
						name: "Audio FMP4 AAC 128000bps",
					},
				},
			],
			audioGuard: false,
			manifests: {
				hls: false,
				dash: false,
				extra: [
					{
						kind: "DASH",
						key: "dash",
						dash: {
							adaptationSets: [
								{ key: "video-dv81", type: "VIDEO" },
								{ key: "video-sdr", type: "VIDEO" },
								{ key: "audio-atmos", type: "AUDIO", lang: "en" },
								{ key: "audio-aac", type: "AUDIO", lang: "en" },
							],
						},
					},
					{
						kind: "HLS",
						key: "hls",
						hls: {
							masterVersion: "HLS_V8",
							mediaVersion: "HLS_V8",
							variantsPerAudioGroup: true,
							iframePlaylists: true,
						},
					},
				],
			},
			timing: "POST_ENCODING",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(
				loadFixture("dolby-dv-hdr10-sdr-2ladder-profile81"),
			),
		);
	});

	it("reproduces the HDR10 per-title fixture (MAIN10 + PQ + autoRepresentations)", () => {
		const state: WizardState = {
			...aws,
			name: "Sample HDR10 Encoding",
			inputFiles: [{ ...awsMain, path: "hdr10/Sony Bravia OLED 4K Demo.mp4" }],
			additionalOutputs: [],
			output: {
				...aws.output,
				basePath: "encoding_test/hdr10_2026-06-12__00-00-00/",
			},
			videos: [
				{
					// Per-title template scales freely — height stays null too.
					height: null,
					bitrate: null,
					codec: "H265",
					h265: {
						profile: "MAIN10",
						pixelFormat: "YUV420P10LE",
						rate: null,
						minKeyframeInterval: 2,
						maxKeyframeInterval: 2,
						rcLookahead: 60,
						subMe: 5,
						maxCtuSize: "S64",
						motionSearch: "STAR",
						tuIntraDepth: "D4",
						tuInterDepth: "D4",
						weightPredictionOnPSlice: true,
						weightPredictionOnBSlice: true,
						sceneCutThreshold: 40,
						motionSearchRange: 92,
						adaptiveQuantizationMode: "AUTO_VARIANCE_DARK_SCENES",
						adaptiveQuantizationStrength: 1.2,
						psyRateDistortionOptimization: 0,
						psyRateDistortionOptimizedQuantization: 0,
						qpMin: 15,
						sao: true,
						hdr: true,
						masterDisplay:
							"G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
						maxContentLightLevel: 800,
						maxPictureAverageLightLevel: 400,
						colorConfig: {
							colorSpace: "BT2020_NCL",
							colorPrimaries: "BT2020",
							colorTransfer: "SMPTE2084",
						},
					},
					extras: {
						key: "v-main10",
						name: "Sample video codec configuration",
						streamName: "Stream H265 Nonep",
						mode: "PER_TITLE_TEMPLATE",
					},
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						path: "video/{height}p_{bitrate}/",
						name: "Video FMP4 Muxing Nonep",
					},
				},
			],
			audios: [
				{
					bitrate: 128_000,
					rate: 48_000,
					channelLayout: "CL_5_1_BACK",
					extras: {
						name: "AAC Codec Configuration",
						streamName: "Audio Stream",
					},
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						path: "audio/",
						name: "Audio FMP4 Muxing",
					},
				},
			],
			audioGuard: false,
			manifests: {
				hls: false,
				dash: false,
				extra: [
					{ kind: "DASH", key: "dash" },
					{
						kind: "HLS",
						key: "hls",
						hls: {
							masterVersion: "HLS_V8",
							mediaVersion: "HLS_V8",
							audioMediaUri: "audio.m3u8",
						},
					},
				],
			},
			timing: "POST_ENCODING",
			// Empty-object autoRepresentations enables defaults (the sample).
			startOptions: { perTitle: { h265: { autoRepresentations: true } } },
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("hdr10-pertitle")),
		);
	});

	it("reproduces the DV separated-metadata fixture (second S3 input + linked sources)", () => {
		// The multi-input scenario: the VISION_METADATA sidecar reads from a
		// SECOND S3 input ("metadata") declared as an extra input file, while
		// the DV mezzanine and the Atmos master stay on the primary input.
		const planName =
			"dolbyvision-separated-metadata-dolbyatmos-adm-hls-dash-fmp4";
		const dv = (
			height: number,
			bitrate: number,
			adaptiveQuantizationStrength: number,
		): WizardVideoRendition => ({
			height,
			bitrate,
			codec: "H265",
			h265: {
				adaptiveQuantizationStrength,
				dolbyVisionMetadata: {
					profile: "DVHE_05",
					metadataSource: "INPUT_STREAM",
					metadataStreamKey: "dv-meta",
				},
			},
			extras: {
				key: `v${height}`,
				name: `H265 DV ${height}p`,
				streamName: `Stream H265 DV ${height}p`,
				source: "dv-video",
			},
			muxing: {
				segmentNaming: "seg_%number%.m4s",
				path: `video/${height}/`,
			},
		});
		const state: WizardState = {
			...aws,
			name: planName,
			inputFiles: [
				{ ...awsMain, path: "" },
				{ ...awsMain, key: "dvvid1", path: "<INSERT_DOLBY_VISION_VIDEO_PATH>" },
				{ ...awsMain, key: "atmos1", path: "<INSERT_DOLBY_ATMOS_ADM_PATH>" },
				{
					key: "metadata1",
					inputKey: "metadata",
					kind: "S3" as const,
					credentialId: "00000000-0000-4000-8000-000000000007",
					bucket: "sample-metadata-bucket",
					path: "<INSERT_DOLBY_VISION_METADATA_PATH>",
					name: "Test S3 Input",
				},
			],
			additionalOutputs: [],
			output: { ...aws.output, basePath: `output/${planName}/` },
			sources: {
				tracks: [
					{
						key: "dv-video",
						inputFile: "dvvid1",
						selectionMode: "VIDEO_RELATIVE",
						position: 0,
					},
				],
				dolbyStreams: [
					{
						kind: "VISION_METADATA",
						key: "dv-meta",
						inputFile: "metadata1",
					},
					{
						kind: "ATMOS",
						key: "atmos-in",
						inputFile: "atmos1",
						inputFormat: "ADM",
					},
				],
			},
			videos: [dv(1080, 2_000_000, 0.5), dv(540, 1_000_000, 1.2)],
			audios: [
				{
					bitrate: 448_000,
					rate: 48_000,
					codec: "DOLBY_ATMOS",
					loudness: {
						meteringMode: "ITU_R_BS_1770_4",
						dialogueIntelligence: "ENABLED",
						speechThreshold: 15,
					},
					extras: {
						key: "atmos448",
						streamName: "Stream ATMOS 448000bps",
						source: "atmos-in",
					},
					muxing: {
						segmentNaming: "seg_%number%.m4s",
						path: "audio/448000/",
					},
				},
			],
			audioGuard: false,
			manifests: {
				hls: false,
				dash: false,
				extra: [
					{ kind: "DASH", key: "dash" },
					{
						kind: "HLS",
						key: "hls",
						hls: { masterVersion: "HLS_V8", mediaVersion: "HLS_V8" },
					},
				],
			},
			timing: "JUST_IN_TIME",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("dolby-dv-separated-metadata-adm")),
		);
	});

	it("emits extra inputs and per-row inputKeys (defaults preserved)", () => {
		const state: WizardState = {
			...aws,
			name: "multi-input-shape",
			inputFiles: [
				{ ...awsMain, path: "in.mp4" },
				{ ...awsMain, key: "extra1", path: "extra.mov" },
				{
					key: "subs1",
					inputKey: "subs",
					kind: "S3" as const,
					credentialId: "00000000-0000-4000-8000-000000000007",
					bucket: "subtitle-bucket",
					path: "subs/en.vtt",
				},
			],
			additionalOutputs: [],
			output: { ...aws.output, basePath: "output/x/" },
			sources: {
				tracks: [
					{
						key: "track1",
						inputFile: "extra1",
						selectionMode: "AUTO",
						position: 0,
					},
				],
				fileStreams: [{ key: "vtt-en", inputFile: "subs1" }],
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			subtitles: [{ source: "vtt-en", muxing: { path: "en" } }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		};
		const plan = buildPlan(state);
		expect(plan.inputs.map((i) => i.key)).toEqual(["main", "subs"]);
		// extras without a name let the schema default fill at parse.
		expect(plan.inputs[1]).not.toHaveProperty("name");
		// Rows without inputKey keep today's "main" emission byte-identical.
		expect(plan.ingest?.map((s) => s.inputKey)).toEqual([
			"main",
			"main",
			"main",
		]);
		expect(plan.fileStreams?.[0]?.inputKey).toBe("subs");
		const parsed = encodingPlanSchema.parse(plan);
		expect(
			validatePlan(parsed).filter((i) => i.code === "PLAN_UNRESOLVED_REF"),
		).toEqual([]);
	});

	it("emits inputs in input-file first-occurrence order, not sorted", () => {
		// inputDecls dedupes by inputKey in inputFiles order. Declaring zeta
		// before alpha must yield inputs [zeta, alpha] — proving the emission
		// follows first-occurrence, not an incidental alphabetical sort.
		const state: WizardState = {
			...aws,
			name: "input-order",
			additionalOutputs: [],
			output: { ...aws.output, basePath: "output/x/" },
			inputFiles: [
				{ ...awsMain, key: "z1", inputKey: "zeta", path: "z.mp4" },
				{ ...awsMain, key: "a1", inputKey: "alpha", path: "a.mov" },
			],
			sources: {
				tracks: [
					{ key: "t-a", inputFile: "a1", selectionMode: "AUTO", position: 0 },
				],
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		};
		expect(buildPlan(state).inputs.map((i) => i.key)).toEqual([
			"zeta",
			"alpha",
		]);
	});

	it("remapInputKeyRefs cascades input-file key renames through source rows", () => {
		const state: WizardState = {
			...aws,
			name: "x",
			additionalOutputs: [],
			output: { ...aws.output, basePath: "output/x/" },
			inputFiles: [
				{ ...awsMain, path: "in.mp4" },
				{
					key: "meta",
					inputKey: "meta",
					kind: "S3" as const,
					credentialId: "00000000-0000-4000-8000-000000000007",
					bucket: "b",
					path: "m.xml",
				},
			],
			sources: {
				tracks: [
					{ key: "t1", inputFile: "meta", selectionMode: "AUTO", position: 0 },
				],
				fileStreams: [{ key: "f1", inputFile: "meta" }],
				dolbyStreams: [
					{ kind: "VISION_METADATA", key: "d1", inputFile: "meta" },
					{ kind: "ATMOS", key: "d2", inputFile: "main", inputFormat: "DAMF" },
				],
			},
			videos: [{ height: 360, bitrate: 300_000 }],
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "JUST_IN_TIME",
		};
		const renamed = remapInputKeyRefs(state, "meta", "metadata");
		expect(renamed.sources?.tracks?.[0]?.inputFile).toBe("metadata");
		expect(renamed.sources?.fileStreams?.[0]?.inputFile).toBe("metadata");
		// The Dolby Vision-metadata row cascades; the Atmos row on "main" stays.
		const dolby = JSON.stringify(renamed.sources?.dolbyStreams ?? []);
		expect(dolby).toContain('"inputFile":"metadata"');
		expect(dolby).toContain('"inputFile":"main"');
	});

	it("assigns implicit ingest tracks to an encoding in partitioned plans", () => {
		// A partition over the DEFAULT ladder (implicit video/audio tracks)
		// must be expressible — the validator requires every ingest entry of
		// a multi-encoding plan to reference one of plan.encodings.
		const state: WizardState = {
			...aws,
			name: "partitioned-implicit-tracks",
			inputFiles: [{ ...awsMain, path: "in.mp4" }],
			additionalOutputs: [],
			output: { ...aws.output, basePath: "output/x/" },
			sources: {
				encodings: [{ key: "enc1", name: "partitioned-implicit-tracks-enc1" }],
				implicitEncodingKeys: { video: "enc1", audio: "enc1" },
			},
			videos: [
				{ height: 360, bitrate: 300_000, extras: { encodingKey: "enc1" } },
			],
			audios: [
				{ bitrate: 64_000, rate: 44_100, extras: { encodingKey: "enc1" } },
			],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "POST_ENCODING",
		};
		const parsed = encodingPlanSchema.parse(buildPlan(state));
		expect(parsed.ingest.map((s) => s.encodingKey)).toEqual(["enc1", "enc1"]);
		expect(
			validatePlan(parsed).filter((i) => i.code === "PLAN_UNRESOLVED_REF"),
		).toEqual([]);
	});

	it("remapEncodingKeyRefs cascades renames and removals through every ref", () => {
		const state: WizardState = {
			...aws,
			name: "x",
			additionalOutputs: [],
			output: { ...aws.output, basePath: "output/x/" },
			sources: {
				encodings: [{ key: "dv81", name: "x-dv81" }],
				tracks: [
					{
						key: "t1",
						inputFile: "main",
						selectionMode: "AUDIO_RELATIVE",
						position: 0,
						encodingKey: "dv81",
					},
				],
				fileStreams: [{ key: "f1", inputFile: "main", encodingKey: "dv81" }],
				dolbyStreams: [
					{
						kind: "ATMOS",
						key: "d1",
						inputFile: "main",
						inputFormat: "DAMF",
						encodingKey: "dv81",
					},
				],
				keyframes: [{ key: "k1", time: 1, encodingKey: "dv81" }],
				implicitEncodingKeys: { video: "dv81", audio: "other" },
			},
			videos: [
				{ height: 360, bitrate: 300_000, extras: { encodingKey: "dv81" } },
			],
			audios: [
				{ bitrate: 64_000, rate: 44_100, extras: { encodingKey: "dv81" } },
			],
			subtitles: [{ source: "f1", extras: { encodingKey: "dv81" } }],
			audioGuard: false,
			manifests: { hls: true, dash: false },
			timing: "POST_ENCODING",
		};
		const renamed = remapEncodingKeyRefs(state, "dv81", "main");
		expect(renamed.videos?.[0]?.extras?.encodingKey).toBe("main");
		expect(renamed.audios?.[0]?.extras?.encodingKey).toBe("main");
		expect(renamed.subtitles?.[0]?.extras?.encodingKey).toBe("main");
		expect(renamed.sources?.tracks?.[0]?.encodingKey).toBe("main");
		expect(renamed.sources?.fileStreams?.[0]?.encodingKey).toBe("main");
		expect(renamed.sources?.dolbyStreams?.[0]?.encodingKey).toBe("main");
		expect(renamed.sources?.keyframes?.[0]?.encodingKey).toBe("main");
		expect(renamed.sources?.implicitEncodingKeys).toEqual({
			video: "main",
			audio: "other",
		});
		const removed = remapEncodingKeyRefs(state, "dv81", undefined);
		expect(removed.videos?.[0]?.extras?.encodingKey).toBeUndefined();
		expect(removed.sources?.tracks?.[0]?.encodingKey).toBeUndefined();
		expect(removed.sources?.keyframes?.[0]?.encodingKey).toBeUndefined();
		expect(removed.sources?.implicitEncodingKeys).toEqual({
			video: undefined,
			audio: "other",
		});
		expect(removed.audios?.[0]?.extras?.encodingKey).toBeUndefined();
		expect(removed.sources?.dolbyStreams?.[0]?.encodingKey).toBeUndefined();
	});
});

describe("buildPlan qc (VMAF quality control)", () => {
	const baseState: WizardState = {
		name: "qc-test",
		accountId: "",
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in",
				path: "src.mkv",
				name: "S3 Input",
			},
		],
		additionalOutputs: [],
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			kind: "S3",
			bucket: "out",
			basePath: "output/qc-test/",
			publicRead: true,
			name: "S3 Output",
		},
		videos: [{ height: 360, bitrate: 300_000 }],
		audios: [{ bitrate: 64_000, rate: 44_100 }],
		audioGuard: false,
		manifests: { hls: true, dash: false },
		timing: "POST_ENCODING",
	};

	it("omits the qc key entirely when qc is absent (goldens stay clean)", () => {
		const plan = buildPlan(baseState);
		expect("qc" in plan).toBe(false);
	});

	it("omits the qc key when qc is present but vmaf+psnr are both off", () => {
		const plan = buildPlan({
			...baseState,
			qc: { vmaf: false, model: DEFAULT_VMAF_MODEL, psnr: false },
		});
		expect("qc" in plan).toBe(false);
	});

	it("emits qc with the default model pruned when only vmaf is on", () => {
		const plan = buildPlan({
			...baseState,
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
		});
		// model === the schema default is pruned (stays sample-minimal); the
		// parse step re-materializes it, so the parsed plan carries the default.
		expect(plan.qc).toEqual({ vmaf: true });
		const parsed = encodingPlanSchema.parse(plan);
		expect(parsed.qc).toEqual({ vmaf: true, model: DEFAULT_VMAF_MODEL });
	});

	it("emits the chosen model and psnr when set", () => {
		const plan = buildPlan({
			...baseState,
			qc: { vmaf: true, model: "vmaf_4k_v0.6.1", psnr: true },
		});
		expect(plan.qc).toEqual({
			vmaf: true,
			model: "vmaf_4k_v0.6.1",
			psnr: true,
		});
	});

	it("normalizes psnr-without-vmaf to vmaf:true (PSNR rides the libvmaf pass)", () => {
		const plan = buildPlan({
			...baseState,
			qc: { vmaf: false, model: DEFAULT_VMAF_MODEL, psnr: true },
		});
		expect(plan.qc).toEqual({ vmaf: true, psnr: true });
	});

	it("emits the QC MP4 mirror op per video rendition when qc is on", () => {
		const onPlan = encodingPlanSchema.parse(
			buildPlan({
				...baseState,
				videos: [
					{ height: 360, bitrate: 300_000 },
					{ height: 540, bitrate: 600_000 },
				],
				qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false },
			}),
		);
		const offPlan = encodingPlanSchema.parse(
			buildPlan({
				...baseState,
				videos: [
					{ height: 360, bitrate: 300_000 },
					{ height: 540, bitrate: 600_000 },
				],
			}),
		);
		const qcMirrorSteps = (plan: typeof onPlan) =>
			compilePlan(plan)
				.map((op) => op.step)
				.filter((step) => step.startsWith("qc-muxing:"));
		// On: one qc-muxing op per VIDEO rendition; off: none (goldens unchanged).
		expect(qcMirrorSteps(onPlan)).toEqual(["qc-muxing:v360", "qc-muxing:v540"]);
		expect(qcMirrorSteps(offPlan)).toEqual([]);
	});
});

describe("buildPlan qc.only (VMAF-only encode)", () => {
	// A state that WOULD carry delivery outputs (manifests + thumbnails +
	// keyframes), so the test proves qc.only clears them rather than vacuously
	// passing on an already-empty plan.
	const richState: WizardState = {
		name: "vmaf-only-ui",
		accountId: "",
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in",
				path: "src.mkv",
				name: "S3 Input",
			},
		],
		additionalOutputs: [],
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			kind: "S3",
			bucket: "out",
			basePath: "output/vmaf-only-ui/",
			publicRead: true,
			name: "S3 Output",
		},
		videos: [
			{ height: 360, bitrate: 300_000 },
			{ height: 540, bitrate: 600_000 },
		],
		audios: [{ bitrate: 64_000, rate: 44_100 }],
		audioGuard: false,
		manifests: { hls: true, dash: true },
		timing: "POST_ENCODING",
		thumbnails: [
			{
				key: "thumb",
				streamKey: "v360",
				height: 180,
				positions: [1],
				path: "thumbs/",
			},
		],
		sources: { keyframes: [{ key: "kf1", time: 5 }] },
		startOptions: {
			aiSceneAnalysis: {
				filename: "ai.json",
				path: "ai",
				outputLanguageCodes: ["ja"],
			},
		},
	};

	it("emits qc.only:true and clears manifests/thumbnails/keyframes/audio/ai", () => {
		const plan = buildPlan({
			...richState,
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false, only: true },
		});
		expect(plan.qc).toEqual({ vmaf: true, only: true });
		// Delivery collections are cleared so the plan passes validation.
		expect(plan.manifests).toEqual([]);
		expect("thumbnails" in plan).toBe(false);
		expect("keyframes" in plan).toBe(false);
		expect("sprites" in plan).toBe(false);
		expect("drm" in plan).toBe(false);
		// Audio (non-video) renditions are dropped — VMAF scores video only.
		expect(
			(plan.renditions ?? []).every((r) =>
				["H264", "H265", "VP9", "AV1"].includes(r.codec),
			),
		).toBe(true);
		// AI Scene Analysis (a non-mirror output) is cleared too.
		expect("aiSceneAnalysis" in plan).toBe(false);
		// Muxings STAY — they carry each qc mirror's destination — but only the
		// video ones (no audio/subtitle muxings).
		expect((plan.muxings ?? []).length).toBeGreaterThan(0);
		expect(
			(plan.muxings ?? []).every((m) =>
				(plan.renditions ?? []).some((r) => r.key === m.streamKey),
			),
		).toBe(true);
	});

	it("the qc.only plan validates clean and compiles to only the qc mirrors", () => {
		const parsed = encodingPlanSchema.parse(
			buildPlan({
				...richState,
				qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false, only: true },
			}),
		);
		expect(validatePlan(parsed).filter((i) => i.level === "error")).toEqual([]);
		const muxingKinds = compilePlan(parsed)
			.filter((op) => op.kind.startsWith("CREATE_MUXING_"))
			.map((op) => op.kind);
		// Every emitted muxing is a qc mirror MP4 — no delivery fMP4.
		expect(muxingKinds.every((k) => k === "CREATE_MUXING_MP4")).toBe(true);
		expect(muxingKinds).toHaveLength(2);
	});

	it("does NOT clear delivery outputs when only is off (qc still emits mirrors)", () => {
		const plan = buildPlan({
			...richState,
			qc: { vmaf: true, model: DEFAULT_VMAF_MODEL, psnr: false, only: false },
		});
		// only:false ⇒ a normal qc plan: manifests + thumbnails survive.
		expect(plan.manifests).not.toEqual([]);
		expect("thumbnails" in plan).toBe(true);
		expect(plan.qc).toEqual({ vmaf: true });
	});
});

describe("labels / infrastructure / start tweaks / preview placement (P5)", () => {
	const baseState: WizardState = {
		name: "infra-ops-ui",
		accountId: "",
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "in",
				path: "src.mkv",
				name: "S3 Input",
			},
		],
		additionalOutputs: [],
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			kind: "S3",
			bucket: "out",
			basePath: "output/infra-ops-ui/",
			publicRead: true,
			name: "S3 Output",
		},
		videos: [{ height: 360, bitrate: 300_000 }],
		audios: [{ bitrate: 64_000, rate: 44_100 }],
		audioGuard: false,
		manifests: { hls: true, dash: true },
		timing: "JUST_IN_TIME",
	};

	it("preserves explicit pool overrides, including empty lists, while leaving unset pools absent", () => {
		const plan = buildPlan({
			...baseState,
			prewarmedEncoderPoolIds: [
				"00000000-0000-4000-8000-0000000000p1".replace("p", "e"),
				"00000000-0000-4000-8000-0000000000e2",
			],
		});
		expect(plan.bitmovin.prewarmedEncoderPoolIds).toHaveLength(2);
		const empty = buildPlan({ ...baseState, prewarmedEncoderPoolIds: [] });
		expect(empty.bitmovin.prewarmedEncoderPoolIds).toEqual([]);
		expect("prewarmedEncoderPoolIds" in buildPlan(baseState).bitmovin).toBe(
			false,
		);
	});

	it("emits bitmovin.labels/.infrastructure, generation tweaks and jitPlacement", () => {
		const plan = buildPlan({
			...baseState,
			// C18: an infrastructure-pinned plan must run in cloudRegion
			// EXTERNAL (the wizard auto-switches; validated below).
			cloudRegion: "EXTERNAL",
			labels: ["campaign-a", "uhd"],
			infrastructure: {
				infrastructureId: "00000000-0000-4000-8000-0000000000aa",
				cloudRegion: "EU_WEST_1",
			},
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { jitPlacement: "VOD_AND_PREVIEW" },
				dashOptions: { jitPlacement: "PREVIEW" },
				extra: [{ kind: "DASH", key: "dash2", dash: { jitPlacement: "VOD" } }],
			},
			startOptions: {
				audioVideoSyncMode: "RESYNC_AT_START",
				handleVariableInputFps: true,
			},
		});
		expect(plan.bitmovin.labels).toEqual(["campaign-a", "uhd"]);
		expect(plan.bitmovin.infrastructure).toEqual({
			infrastructureId: "00000000-0000-4000-8000-0000000000aa",
			cloudRegion: "EU_WEST_1",
		});
		// Absent pools emit NO key (golden byte-stability), pinned by the
		// baseState assertion below in this same suite family.
		expect("prewarmedEncoderPoolIds" in plan.bitmovin).toBe(false);
		expect(plan.generation).toEqual({
			timing: "JUST_IN_TIME",
			audioVideoSyncMode: "RESYNC_AT_START",
			handleVariableInputFps: true,
		});
		expect(
			(plan.manifests ?? []).map((m) => [
				m.key,
				"jitPlacement" in m ? m.jitPlacement : undefined,
			]),
		).toEqual([
			["hls", "VOD_AND_PREVIEW"],
			["dash", "PREVIEW"],
			["dash2", "VOD"],
		]);
		// The plan parses AND validates clean (preview placements ride JIT).
		const parsed = encodingPlanSchema.parse(plan);
		expect(validatePlan(parsed).filter((i) => i.level === "error")).toEqual([]);
	});

	it("rejects extra HLS masters that overwrite the primary child playlists", () => {
		const parsed = encodingPlanSchema.parse(
			buildPlan({
				...baseState,
				manifests: {
					hls: true,
					dash: true,
					extra: [{ kind: "HLS", key: "hls2", hls: { jitPlacement: "VOD" } }],
				},
			}),
		);
		expect(validatePlan(parsed).filter((i) => i.level === "error")).toEqual([
			expect.objectContaining({
				code: "PLAN_HLS_MEDIA_URI_COLLISION",
				path: "manifests[2]",
			}),
			expect.objectContaining({
				code: "PLAN_HLS_MEDIA_URI_COLLISION",
				path: "manifests[2]",
			}),
		]);
	});

	it("default state emits NO new keys (bitmovin/generation/manifests stay minimal)", () => {
		const plan = buildPlan(baseState);
		expect("labels" in plan.bitmovin).toBe(false);
		expect("infrastructure" in plan.bitmovin).toBe(false);
		expect(plan.generation).toEqual({ timing: "JUST_IN_TIME" });
		for (const manifest of plan.manifests ?? []) {
			expect("jitPlacement" in manifest).toBe(false);
		}
	});

	it("empty labels emit no bitmovin.labels key (schema-minimal)", () => {
		const plan = buildPlan({ ...baseState, labels: [] });
		expect("labels" in plan.bitmovin).toBe(false);
	});

	it("emits a half-filled infrastructure VERBATIM so the schema rejects it (end-to-end, never a silent drop)", () => {
		// Review catch: the half-filled rail was only asserted at the UI-patch
		// layer — a future "cleanup" wrapping the emission in str/pruning
		// would silently drop the user's id with the suite still green. Pin
		// the whole contract: build emits verbatim, schema rejects.
		const plan = buildPlan({
			...baseState,
			infrastructure: { infrastructureId: "abc", cloudRegion: "" },
		});
		expect(plan.bitmovin.infrastructure).toEqual({
			infrastructureId: "abc",
			cloudRegion: "",
		});
		expect(encodingPlanSchema.safeParse(plan).success).toBe(false);
	});

	it("an explicit handleVariableInputFps:false is emitted (SET ≠ unset)", () => {
		const plan = buildPlan({
			...baseState,
			startOptions: { handleVariableInputFps: false },
		});
		expect(plan.generation).toEqual({
			timing: "JUST_IN_TIME",
			handleVariableInputFps: false,
		});
	});

	it("preview placement on a POST_ENCODING plan is railed, not dropped", () => {
		// buildPlan emits state verbatim; the PLAN_PREVIEW_REQUIRES_JIT rail
		// (not a silent drop) rejects it — the wizard hides the select and the
		// preview surfaces the error for stale imported state.
		const parsed = encodingPlanSchema.parse(
			buildPlan({
				...baseState,
				timing: "POST_ENCODING",
				manifests: {
					hls: true,
					dash: false,
					hlsOptions: { jitPlacement: "PREVIEW" },
				},
			}),
		);
		expect(validatePlan(parsed).map((issue) => issue.code)).toContain(
			"PLAN_PREVIEW_REQUIRES_JIT",
		);
	});
});

describe("buildPlan kantar (audio watermarking, P5)", () => {
	// The golden's wizard state: the fixed-bitrate-hls-on-aws shape (2 video +
	// 2 audio renditions, JIT HLS, PUBLIC_READ output) with the Kantar block
	// bolted on. The report path is stored RELATIVE to the base output path, and
	// its ACL is PRIVATE while every delivery destination stays PUBLIC_READ —
	// the two must be independently representable for a byte-exact round-trip.
	const goldenKantar: WizardKantar = {
		credentialId: "00000000-0000-4000-8000-0000000000b1",
		licenseId: 4711,
		channelName: "Demo Channel JP",
		contentReference: "bbb-2026-08-06-ep01",
		serverUrl: "https://kantar.example.com/watermark",
		reportPath: "reports",
		reportPrivate: true,
	};
	const baseState: WizardState = {
		name: "kantar-audio-watermark",
		accountId: "",
		cloudRegion: "AWS_AP_NORTHEAST_1",
		encoderVersion: "STABLE",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "sample-input-bucket",
				path: "sintel/Sintel.2010.1080p.mkv",
				name: "Test S3 Input",
			},
		],
		additionalOutputs: [],
		output: {
			credentialId: "00000000-0000-4000-8000-000000000002",
			kind: "S3",
			bucket: "sample-output-bucket",
			basePath: "output/kantar-audio-watermark/",
			publicRead: true,
			name: "Test S3 Output",
		},
		videos: [
			{ height: 360, bitrate: 300_000 },
			{ height: 540, bitrate: 600_000 },
		],
		audios: [
			{ bitrate: 128_000, rate: 48_000 },
			{ bitrate: 64_000, rate: 44_100 },
		],
		audioGuard: false,
		// V4 spelled out : the vendor sample chose it, and the wizard now defaults fMP4 to V6.
		manifests: {
			hls: true,
			dash: false,
			hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
		},
		timing: "JUST_IN_TIME",
	};
	const kantarState: WizardState = { ...baseState, kantar: goldenKantar };

	it("reproduces the kantar-audio-watermark golden from wizard state", () => {
		const parsed = encodingPlanSchema.parse(buildPlan(kantarState));
		expect(parsed).toEqual(
			encodingPlanSchema.parse(loadFixture("kantar-audio-watermark")),
		);
		// …and it validates clean: the audio renditions satisfy the
		// PLAN_KANTAR_NEEDS_AUDIO rail and the report output resolves.
		expect(validatePlan(parsed).filter((i) => i.level === "error")).toEqual([]);
	});

	it("emits ONE plan-root block, compiled to one op per encoding", () => {
		const parsed = encodingPlanSchema.parse(buildPlan(kantarState));
		expect(parsed.kantar).toEqual({
			credentialId: "00000000-0000-4000-8000-0000000000b1",
			licenseId: 4711,
			channelName: "Demo Channel JP",
			contentReference: "bbb-2026-08-06-ep01",
			serverUrl: "https://kantar.example.com/watermark",
			reportDestination: {
				outputKey: "origin",
				path: "output/kantar-audio-watermark/reports",
				acl: "PRIVATE",
			},
		});
		// Encoding-level SINGLETON: exactly one CREATE_KANTAR_WATERMARK op for
		// this single-encoding plan (a ladder gets the same config per encoding).
		expect(
			compilePlan(parsed).filter((op) => op.kind === "CREATE_KANTAR_WATERMARK"),
		).toHaveLength(1);
	});

	it("an untouched wizard emits NO kantar key (goldens stay byte-identical)", () => {
		expect("kantar" in buildPlan(baseState)).toBe(false);
	});

	it("an unchecked report ACL inherits the output's publicRead", () => {
		const plan = buildPlan({
			...baseState,
			kantar: { ...goldenKantar, reportPrivate: undefined },
		});
		expect(plan.kantar?.reportDestination).toEqual({
			outputKey: "origin",
			path: "output/kantar-audio-watermark/reports",
			acl: "PUBLIC_READ",
		});
	});

	it("a private output emits no report acl at all (inherit ⇒ no key)", () => {
		const plan = buildPlan({
			...baseState,
			additionalOutputs: [],
			output: { ...baseState.output, publicRead: false },
			kantar: { ...goldenKantar, reportPrivate: undefined },
		});
		expect(plan.kantar?.reportDestination).toEqual({
			outputKey: "origin",
			path: "output/kantar-audio-watermark/reports",
		});
	});

	it("emits a half-filled kantar block VERBATIM so the schema rejects it", () => {
		// Same contract as the half-filled infrastructure rail above: enabling the
		// section and leaving fields blank must reach zod and fail loudly in the
		// preview — never a silent prune that swallows what the user typed.
		// licenseId stays `undefined` (not coerced to 0) for the same reason: the
		// error must say the field is missing, not invent a license.
		const plan = buildPlan({
			...baseState,
			kantar: {
				credentialId: "",
				channelName: "Demo Channel JP",
				contentReference: "",
				serverUrl: "",
				reportPath: "",
			},
		});
		expect(plan.kantar).toEqual({
			credentialId: "",
			licenseId: undefined,
			channelName: "Demo Channel JP",
			contentReference: "",
			serverUrl: "",
			reportDestination: {
				outputKey: "origin",
				path: "output/kantar-audio-watermark/",
				acl: "PUBLIC_READ",
			},
		});
		const result = encodingPlanSchema.safeParse(plan);
		expect(result.success).toBe(false);
		if (!result.success) {
			// Every blank FIELD is reported, so the user sees all of them at once.
			// Deduped by path: a blank serverUrl trips three rails at once
			// (non-empty, parses-as-URL, and https-only — it is a
			// secret-egress destination), and asserting the raw issue list
			// would break whenever a rail is added to a field.
			expect(
				[
					...new Set(result.error.issues.map((issue) => issue.path.join("."))),
				].sort(),
			).toEqual([
				"kantar.contentReference",
				"kantar.credentialId",
				"kantar.licenseId",
				"kantar.serverUrl",
			]);
			// And the https rail specifically is among them.
			expect(JSON.stringify(result.error.issues)).toMatch(/https/i);
		}
	});

	it("a video-only kantar plan is railed by PLAN_KANTAR_NEEDS_AUDIO", () => {
		// The UI warns, but the plan validator is the hard rail — Kantar embeds an
		// inaudible signal in the AUDIO, so a video-only encode watermarks nothing.
		const parsed = encodingPlanSchema.parse(
			buildPlan({ ...kantarState, audios: [] }),
		);
		expect(validatePlan(parsed).map((i) => i.code)).toContain(
			"PLAN_KANTAR_NEEDS_AUDIO",
		);
	});
});

/**
 * Review-251 B4: the mirror credential-select guard — the one genuinely
 * conditional piece of the inline mirrors UI, extracted pure. The unmapped-
 * provider branch is the review-223 F4 class (never collapse to S3); the
 * empty re-selection preserves kind while blanking the credential, and the
 * schema's z.uuid refuses the blank at submit — loud, not silent.
 */
describe("applyMirrorCredentialSelection (ledger #115 PR-b)", () => {
	const rows = [
		{ credentialId: "a", kind: "S3" as const, bucket: "b", name: "M" },
	];

	it("applies a valid pick with its mapped kind", () => {
		const next = applyMirrorCredentialSelection(rows, 0, "c-gcs", "GCS");
		expect(next?.[0]).toMatchObject({ credentialId: "c-gcs", kind: "GCS" });
	});

	it("IGNORES an unmapped provider — returns null, never collapses to S3", () => {
		expect(applyMirrorCredentialSelection(rows, 0, "c-role", null)).toBeNull();
		expect(rows[0]?.credentialId).toBe("a");
	});

	it("empty re-selection blanks the credential and keeps the kind", () => {
		const next = applyMirrorCredentialSelection(rows, 0, "", null);
		expect(next?.[0]).toMatchObject({ credentialId: "", kind: "S3" });
	});

	it("out-of-range index returns null", () => {
		expect(applyMirrorCredentialSelection(rows, 5, "x", "S3")).toBeNull();
	});
});
describe("concatenation padding unit (ledger #149 enum sweep)", () => {
	/**
	 * The schema has carried SECONDS|FRAMES since the padding landed, and the
	 * form hardcoded `unit: "SECONDS"` on every edit — so FRAMES was a member
	 * of the plan language no form could reach. The enum-reachability sweep is
	 * what noticed; this pins the path it opened.
	 */
	it("a FRAMES padding survives buildPlan verbatim", () => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.name = "frames-padding";
		// The real shape: concatenation sources reference INPUT-STREAM keys,
		// and the streams live under sources.concatenationStreams. The first
		// draft of this test invented a `concatenations` field and measured a
		// plan with no concatenation in it at all.
		state.sources = {
			ingest: [
				{ key: "in-a", inputPath: "a.mp4" },
				{ key: "in-b", inputPath: "b.mp4" },
			],
			fileStreams: [],
			dolbyStreams: [],
			concatenationStreams: [
				{
					key: "concat",
					sources: [
						{
							sourceKey: "in-a",
							isMain: true,
							position: 0,
							paddingAfter: { duration: 48, unit: "FRAMES" },
						},
						{ sourceKey: "in-b", position: 1 },
					],
				},
			],
		} as never;
		const plan = buildPlan(state) as unknown as {
			concatenationStreams?: {
				sources: { paddingAfter?: { duration: number; unit?: string } }[];
			}[];
		};
		const padded = plan.concatenationStreams?.[0]?.sources[0]?.paddingAfter;
		expect(padded).toEqual({ duration: 48, unit: "FRAMES" });
	});
});
