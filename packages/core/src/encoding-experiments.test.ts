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
		const descriptor = {
			scoringProfileId: v1Profile,
			scorerSha256: "b".repeat(64),
			modelSha256: "c".repeat(64),
			sourceSha256: "d".repeat(64),
			officialRevision: "e".repeat(40),
		};
		expect(experimentRuntimeSchema.parse(runtime)).toEqual(runtime);
		expect(
			experimentRuntimeSchema.parse({
				...runtime,
				additionalScoringProfiles: [descriptor],
			}).additionalScoringProfiles,
		).toEqual([descriptor]);
		expect(
			experimentRuntimeSchema.safeParse({
				...runtime,
				additionalScoringProfiles: [
					{ ...descriptor, officialRevision: digest },
				],
			}).success,
		).toBe(false);
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
