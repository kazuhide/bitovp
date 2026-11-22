import { describe, expect, it } from "vitest";
import {
	experimentBatchSchema,
	experimentQualityRequestSchema,
	experimentResultSchema,
	experimentRuntimeSchema,
	experimentTrialSchema,
} from "./encoding-experiments";

const v1Profile = "bitovp-vmaf-cuda-1.0.16-3d0h";
const officialProfile = "official-vmaf-cuda-0.6.1";
const digest = "a".repeat(64);

const trial = {
	sourceId: "test-source",
	window: {
		timeBase: { num: 1, den: 90_000 },
		startPts: "900000",
		endPtsExclusive: "1800000",
	},
	codec: "HEVC",
	preset: "P5",
	tuning: "HIGH_QUALITY",
	config: {
		gopLength: 60,
		rcParams: { rateControlMode: "VBR", averageBitRate: 3_500_000 },
	},
};

describe("the NVIDIA experiment request and receipt", () => {
	it("keeps omission, false, and zero distinct", () => {
		const raw = {
			...trial,
			config: {
				...trial.config,
				rcParams: {
					...trial.config.rcParams,
					enableAQ: false,
					lookaheadDepth: 0,
				},
			},
		};
		expect(experimentTrialSchema.parse(raw)).toEqual({
			...raw,
			window: {
				timeBase: { num: 1, den: 30 },
				startPts: "300",
				endPtsExclusive: "600",
			},
		});
		expect(experimentTrialSchema.parse(trial).config.rcParams).toEqual(
			trial.config.rcParams,
		);
		const equivalent = experimentBatchSchema.parse({
			schemaVersion: 1,
			trials: [
				trial,
				{
					...trial,
					window: {
						timeBase: { num: 2, den: 60 },
						startPts: "300",
						endPtsExclusive: "600",
					},
				},
			],
		});
		expect(equivalent.trials[0]).toEqual(equivalent.trials[1]);
		expect(
			experimentQualityRequestSchema.parse({
				schemaVersion: 1,
				sourceId: trial.sourceId,
				window: trial.window,
				constraints: {},
			}).window,
		).toEqual(equivalent.trials[0]?.window);
	});

	it("rejects unaligned, inverted, and noncanonical windows", () => {
		for (const [startPts, endPtsExclusive] of [
			["1", "900000"],
			["900000", "900000"],
			["0900000", "1800000"],
		]) {
			expect(
				experimentTrialSchema.safeParse({
					...trial,
					window: { ...trial.window, startPts, endPtsExclusive },
				}).success,
			).toBe(false);
		}
	});

	it("accepts a bounded batch of the three codecs without arbitrary options", () => {
		expect(
			experimentBatchSchema.parse({
				schemaVersion: 1,
				trials: ["H264", "HEVC", "AV1"].map((codec) => ({ ...trial, codec })),
			}).trials,
		).toHaveLength(3);
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				config: { ...trial.config, raw: ["-i", "movie"] },
			}).success,
		).toBe(false);
	});

	it("accepts one optional VMAF v1 profile and defaults selection to official VMAF", () => {
		expect(experimentTrialSchema.parse(trial)).not.toHaveProperty(
			"additionalScoringProfiles",
		);
		expect(
			experimentTrialSchema.parse({
				...trial,
				additionalScoringProfiles: [v1Profile],
			}).additionalScoringProfiles,
		).toEqual([v1Profile]);
		for (const profiles of [[], [officialProfile], [v1Profile, v1Profile]]) {
			expect(
				experimentTrialSchema.safeParse({
					...trial,
					additionalScoringProfiles: profiles,
				}).success,
			).toBe(false);
		}
		const selection = {
			schemaVersion: 1,
			sourceId: trial.sourceId,
			window: trial.window,
			constraints: {},
		};
		expect(
			experimentQualityRequestSchema.parse(selection).scoringProfileId,
		).toBe(officialProfile);
		expect(
			experimentQualityRequestSchema.parse({
				...selection,
				scoringProfileId: v1Profile,
			}).scoringProfileId,
		).toBe(v1Profile);
		expect(
			experimentQualityRequestSchema.safeParse({
				...selection,
				scoringProfileId: "unrecognized-model",
			}).success,
		).toBe(false);
	});

	it("canonicalizes SDK field and picture order while preserving zero and false", () => {
		const sdk = {
			version: "13.0",
			session: {
				"NV_ENC_RC_PARAMS.enableAQ": false,
				"NV_ENC_RC_PARAMS.aqStrength": 0,
			},
			pictures: [2, 0].map((frameIndex) => ({
				frameIndex,
				fields: { "NV_ENC_PIC_PARAMS.encodePicFlags": 2 },
			})),
		};
		const first = experimentTrialSchema.parse({ ...trial, sdk });
		const second = experimentTrialSchema.parse({
			...trial,
			sdk: {
				...sdk,
				session: Object.fromEntries(Object.entries(sdk.session).reverse()),
				pictures: [...sdk.pictures].reverse(),
			},
		});
		expect(first.sdk?.session).toEqual(sdk.session);
		expect(first.sdk?.pictures?.map((picture) => picture.frameIndex)).toEqual([
			0, 2,
		]);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(experimentTrialSchema.parse(trial)).not.toHaveProperty("sdk");
	});

	it("rejects ambiguous or out-of-window SDK fields", () => {
		const session = { "NV_ENC_RC_PARAMS.aqStrength": 6 };
		const picture = {
			frameIndex: 0,
			fields: { "NV_ENC_PIC_PARAMS.encodePicFlags": 2 },
		};
		for (const sdk of [
			{ version: "12.2", session },
			{ version: "13.0" },
			{ version: "13.0", session: {} },
			{ version: "13.0", session: { "NV_ENC_RC_PARAMS.aqStrength\n": 1 } },
			{ version: "13.0", session: { "NV_ENC_RC_PARAMS.aqStrength": 1.5 } },
			{
				version: "13.0",
				session: { "NV_ENC_RC_PARAMS.aqStrength": Number.MAX_SAFE_INTEGER + 1 },
			},
			{ version: "13.0", pictures: [picture, picture] },
			{ version: "13.0", pictures: [{ ...picture, frameIndex: 300 }] },
		]) {
			expect(experimentTrialSchema.safeParse({ ...trial, sdk }).success).toBe(
				false,
			);
		}
	});

	it("validates picture QP maps and allows reconfiguration without scalar picture fields", () => {
		const sdk = {
			version: "13.0",
			session: { "NV_ENC_RC_PARAMS.qpMapMode": 2 },
			pictures: [
				{ frameIndex: 5, qpMap: "ff".repeat(2040) },
				{
					frameIndex: 0,
					reconfigure: { "NV_ENC_RC_PARAMS.averageBitRate": 2_000_000 },
				},
			],
		};
		expect(
			experimentTrialSchema.parse({ ...trial, sdk }).sdk?.pictures,
		).toEqual([sdk.pictures[1], sdk.pictures[0]]);
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				sdk: { ...sdk, pictures: [sdk.pictures[1]] },
			}).success,
		).toBe(false);
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				sdk: { ...sdk, session: { "NV_ENC_RC_PARAMS.qpMapMode": 0 } },
			}).success,
		).toBe(false);
		for (const qpMap of [
			"",
			"fF".repeat(2040),
			"f".repeat(4081),
			"ff".repeat(510),
		]) {
			expect(
				experimentTrialSchema.safeParse({
					...trial,
					sdk: { ...sdk, pictures: [{ frameIndex: 5, qpMap }] },
				}).success,
			).toBe(false);
		}
		const emphasis = {
			...sdk,
			session: { "NV_ENC_RC_PARAMS.qpMapMode": 1 },
			pictures: [{ frameIndex: 0, qpMap: "05".repeat(8160) }],
		};
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				codec: "H264",
				sdk: emphasis,
			}).success,
		).toBe(true);
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				codec: "H264",
				sdk: {
					...emphasis,
					pictures: [{ frameIndex: 0, qpMap: "06".repeat(8160) }],
				},
			}).success,
		).toBe(false);
	});

	it("validates ordered per-picture metadata and codec-specific types", () => {
		const metadata = [
			{ type: 5, payload: "00ff" },
			{ type: 1, payload: "abcd" },
		];
		const candidate = (codec: string, items: unknown) => ({
			...trial,
			codec,
			sdk: { version: "13.0", pictures: [{ frameIndex: 1, metadata: items }] },
		});
		expect(
			experimentTrialSchema.parse(candidate("AV1", metadata)).sdk?.pictures?.[0]
				?.metadata,
		).toEqual(metadata);
		for (const type of [0, 6, 0xffffffff]) {
			const items = [{ type, payload: "aa" }];
			expect(
				experimentTrialSchema.safeParse(candidate("AV1", items)).success,
			).toBe(false);
			expect(
				experimentTrialSchema.safeParse(candidate("HEVC", items)).success,
			).toBe(true);
		}
		for (const payload of ["", "A0", "0", "00".repeat(16385)]) {
			expect(
				experimentTrialSchema.safeParse(
					candidate("AV1", [{ type: 1, payload }]),
				).success,
			).toBe(false);
		}
	});

	it("admits both legacy capabilities and a pinned VMAF v1 runtime descriptor", () => {
		const runtime = {
			schemaVersion: 1,
			runtimeId: digest,
			gpuUuid: "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			gpuName: "Example GPU",
			driverVersion: "580.178.04",
			supportedCodecs: ["HEVC"],
			scoringProfileId: officialProfile,
			ffmpegSha256: digest,
			ffprobeSha256: digest,
			modelSha256: digest,
			runnerSha256: digest,
			sdkProbeSha256: digest,
			maxNvencApiVersion: 208,
		};
		const descriptorWithoutDecoderRuntime = {
			scoringProfileId: v1Profile,
			scorerSha256: "b".repeat(64),
			modelSha256: "c".repeat(64),
			sourceSha256: "d".repeat(64),
			officialRevision: "e".repeat(40),
		};
		const descriptor = {
			...descriptorWithoutDecoderRuntime,
			decoderRuntimeSha256: "f".repeat(64),
		};
		expect(experimentRuntimeSchema.parse(runtime)).toEqual(runtime);
		expect(
			experimentRuntimeSchema.parse({
				...runtime,
				additionalScoringProfiles: [descriptor],
			}).additionalScoringProfiles,
		).toEqual([descriptor]);
		for (const invalid of [
			descriptorWithoutDecoderRuntime,
			{ ...descriptor, decoderRuntimeSha256: "F".repeat(64) },
			{ ...descriptor, decoderRuntimeSha256: "f".repeat(63) },
			{ ...descriptor, officialRevision: digest },
		]) {
			expect(
				experimentRuntimeSchema.safeParse({
					...runtime,
					additionalScoringProfiles: [invalid],
				}).success,
			).toBe(false);
		}
	});

	it("rejects requests outside the native FFmpeg adapter's limits", () => {
		for (const input of [
			{ ...trial, config: { ...trial.config, gopLength: 0x80000000 } },
			{
				...trial,
				window: {
					...trial.window,
					timeBase: { num: 1, den: 0x80000000 },
					startPts: "0",
					endPtsExclusive: "1073741824",
				},
			},
			{
				...trial,
				window: {
					timeBase: { num: 1, den: 30 },
					startPts: "2147483647",
					endPtsExclusive: "2147483648",
				},
			},
			{
				...trial,
				config: {
					...trial.config,
					rcParams: { ...trial.config.rcParams, maxBitRate: 1 },
				},
			},
		]) {
			expect(experimentTrialSchema.safeParse(input).success).toBe(false);
		}
	});

	it("enforces FFmpeg's signed bounds for maxrate and bufsize", () => {
		for (const key of ["maxBitRate", "vbvBufferSize"] as const) {
			for (const [value, valid] of [
				[0x7fffffff, true],
				[0x80000000, false],
			] as const) {
				const input = {
					...trial,
					config: {
						...trial.config,
						rcParams: { ...trial.config.rcParams, [key]: value },
					},
				};
				expect(experimentTrialSchema.safeParse(input).success).toBe(valid);
			}
		}
		expect(
			experimentTrialSchema.safeParse({
				...trial,
				config: {
					...trial.config,
					rcParams: { ...trial.config.rcParams, averageBitRate: 0xffffffff },
				},
			}).success,
		).toBe(true);
	});

	it("accepts a complete measured receipt with integer rate components", () => {
		const receipt = {
			schemaVersion: 1,
			scoringProfileId: "official-vmaf-cuda-0.6.1",
			runtimeId: "a".repeat(64),
			scoreMilli: 94100,
			meanVmaf: 94.1,
			frameCount: 300,
			videoBytes: "4062500",
			durationTicks: "300",
			timeBase: { num: 1, den: 30 },
			encodeMs: 1400,
			scoreMs: 100,
		};
		expect(experimentResultSchema.parse(receipt)).toEqual(receipt);
		expect(
			experimentResultSchema.safeParse({ ...receipt, durationTicks: "0" })
				.success,
		).toBe(false);
		const score = {
			scoringProfileId: v1Profile,
			status: "succeeded",
			scoreMilli: 110_000,
			meanVmaf: 110,
			scoreMs: 300,
			scorerSha256: "b".repeat(64),
			modelSha256: "c".repeat(64),
		};
		const failure = {
			scoringProfileId: v1Profile,
			status: "failed",
			failureCode: "VMAF_V1_TIMEOUT",
		};
		for (const additional of [score, failure]) {
			const combined = { ...receipt, additionalScores: [additional] };
			expect(experimentResultSchema.parse(combined)).toEqual(combined);
		}
		for (const invalid of [
			{ ...score, scoreMilli: 110_001 },
			{ ...score, meanVmaf: 110.01 },
			{ ...failure, meanVmaf: 0 },
		]) {
			expect(
				experimentResultSchema.safeParse({
					...receipt,
					additionalScores: [invalid],
				}).success,
			).toBe(false);
		}
	});
});
