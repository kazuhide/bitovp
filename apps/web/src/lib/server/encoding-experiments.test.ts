import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExperimentContext } from "@bitovp/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	enqueueExperimentTrials,
	getExperimentCapabilities,
	selectExperimentQuality,
	validateExperimentTrial,
} from "./encoding-experiments";

const fake = vi.hoisted(() => ({
	readRuntime: vi.fn(),
	readSource: vi.fn(),
	enqueue: vi.fn(),
	rows: vi.fn(),
	execFile: vi.fn(),
	solve: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		default: { ...actual, execFile: fake.execFile },
		execFile: fake.execFile,
	};
});
vi.mock("@bitovp/core/encoding-experiments-files", () => ({
	getExperimentRoot: () => "/experiment-fixture",
	readExperimentRuntime: fake.readRuntime,
	readExperimentSource: fake.readSource,
}));
vi.mock("@bitovp/db", () => ({
	EncodingExperimentError: class extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string,
			readonly field?: string,
		) {
			super(message);
		}
	},
	enqueueExperimentBatch: fake.enqueue,
	experimentCampaignDetail: () => ({ capabilityId: "a".repeat(64) }),
	experimentSelectionRows: fake.rows,
}));

const primaryProfile = "official-vmaf-cuda-0.6.1";
const additionalProfile = "bitovp-vmaf-cuda-1.0.16-3d0h";
const runtimeId = "a".repeat(64);
const sourceSha256 = "b".repeat(64);
const campaign = "11111111-1111-4111-8111-111111111111";
const legacyId = "22222222-2222-4222-8222-222222222222";
const dualId = "33333333-3333-4333-8333-333333333333";
const failedId = "44444444-4444-4444-8444-444444444444";
const modelSha256 = "c".repeat(64);
const scorerSha256 = "d".repeat(64);
const additionalDescriptor = {
	scoringProfileId: additionalProfile,
	modelSha256,
	scorerSha256,
	sourceSha256: "e".repeat(64),
	officialRevision: "f".repeat(40),
	decoderRuntimeSha256: "9".repeat(64),
};
const ctx: ExperimentContext = {
	organizationId: "00000000-0000-4000-8000-000000000001",
	prisma: {} as ExperimentContext["prisma"],
};
const trial = {
	sourceId: "fixture",
	window: {
		timeBase: { num: 1, den: 30 },
		startPts: "0",
		endPtsExclusive: "60",
	},
	codec: "HEVC",
	preset: "P5",
	tuning: "HIGH_QUALITY",
	config: {
		gopLength: 30,
		rcParams: { rateControlMode: "VBR", averageBitRate: 1000000 },
	},
};
const dualTrial = { ...trial, additionalScoringProfiles: [additionalProfile] };
const runtime = { runtimeId, supportedCodecs: ["HEVC"] };
const catalogSha256 = createHash("sha256")
	.update(
		readFileSync(
			resolve(
				import.meta.dirname,
				"../../../../../native/nvenc-experiments/catalog/sdk-13.0.json",
			),
		),
	)
	.digest("hex");
const sdkRuntime = {
	...runtime,
	nvencSdk: { version: "13.0", catalogSha256 },
};
const sdkTrial = {
	...trial,
	sdk: {
		version: "13.0",
		session: {
			"NV_ENC_RC_PARAMS.enableAQ": true,
			"NV_ENC_RC_PARAMS.aqStrength": 8,
		},
	},
};
const selection = {
	schemaVersion: 1,
	sourceId: trial.sourceId,
	window: trial.window,
	constraints: { bitrateLimitBps: 4500000 },
};
const primaryResult = {
	schemaVersion: 1,
	runtimeId,
	scoringProfileId: primaryProfile,
	scoreMilli: 91200,
	meanVmaf: 91.2,
	frameCount: 60,
	videoBytes: "1000000",
	durationTicks: "60",
	timeBase: trial.window.timeBase,
	encodeMs: 123,
	scoreMs: 456,
	observedGopFrames: 30,
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("BITOVP_EXPERIMENTS_OPTIMIZER", "/fixture/lean");
	fake.readRuntime.mockResolvedValue(runtime);
	fake.readSource.mockResolvedValue({
		id: trial.sourceId,
		sha256: sourceSha256,
	});
	fake.enqueue.mockImplementation((_ctx, _id, _key, _hash, prepare) =>
		prepare({ capabilityId: runtimeId }),
	);
	fake.rows.mockResolvedValue([
		{
			id: legacyId,
			codec: trial.codec,
			status: "SUCCEEDED",
			result: primaryResult,
			sourceSha256,
		},
		{
			id: dualId,
			codec: dualTrial.codec,
			status: "SUCCEEDED",
			result: {
				...primaryResult,
				scoreMilli: 89100,
				meanVmaf: 89.1,
				additionalScores: [
					{
						scoringProfileId: additionalProfile,
						status: "succeeded",
						scoreMilli: 0,
						meanVmaf: 0,
						scoreMs: 543,
						scorerSha256,
						modelSha256,
					},
				],
			},
			sourceSha256,
		},
		{
			id: failedId,
			codec: dualTrial.codec,
			status: "SUCCEEDED",
			result: {
				...primaryResult,
				scoreMilli: 85000,
				meanVmaf: 85,
				additionalScores: [
					{
						scoringProfileId: additionalProfile,
						status: "failed",
						failureCode: "VMAF_V1_SCORE_FAILED",
					},
				],
			},
			sourceSha256,
		},
	]);
	fake.execFile.mockImplementation((_bin, _options, done) => ({
		stdin: {
			on: () => {},
			end: (payload: string) => {
				const input = JSON.parse(payload);
				const output = {
					schemaVersion: 1,
					evaluation: "measured",
					scoringProfileId: input.scoringProfileId,
					candidateSetSha256: input.candidateSetSha256,
					candidateCount: input.candidates.length,
					status: "selected",
					eligibleCount: 1,
					ineligibleCount: 0,
					incompleteCount: 2,
					...fake.solve(input),
				};
				done(null, JSON.stringify(output));
			},
		},
	}));
});

afterEach(() => vi.unstubAllEnvs());

it("admits a primary-only trial without a v1 scorer and rejects a dual trial in both intake paths", async () => {
	await expect(
		validateExperimentTrial(ctx.organizationId, trial),
	).resolves.toMatchObject({
		valid: true,
		trial,
	});
	const unavailable = {
		status: 422,
		code: "SCORING_PROFILE_UNAVAILABLE",
		field: "additionalScoringProfiles",
	};
	await expect(
		validateExperimentTrial(ctx.organizationId, dualTrial),
	).rejects.toMatchObject(unavailable);
	await expect(
		enqueueExperimentTrials(
			ctx,
			campaign,
			{ schemaVersion: 1, trials: [dualTrial] },
			"request-1",
		),
	).rejects.toMatchObject(unavailable);
});

it("admits the requested additional profile only when the runtime advertises it", async () => {
	fake.readRuntime.mockResolvedValue({
		...runtime,
		additionalScoringProfiles: [additionalDescriptor],
	});
	await expect(
		validateExperimentTrial(ctx.organizationId, dualTrial),
	).resolves.toMatchObject({
		valid: true,
		trial: dualTrial,
	});
	await expect(
		enqueueExperimentTrials(
			ctx,
			campaign,
			{ schemaVersion: 1, trials: [dualTrial] },
			"request-1",
		),
	).resolves.toMatchObject([
		{ input: dualTrial, trialKey: expect.any(String) },
	]);
});

it("admits SDK settings against the worker's exact catalog and fingerprints them", async () => {
	fake.readRuntime.mockResolvedValue(sdkRuntime);
	await expect(getExperimentCapabilities()).resolves.toMatchObject({
		available: true,
		nvencSdk: sdkRuntime.nvencSdk,
	});
	await expect(
		validateExperimentTrial(ctx.organizationId, sdkTrial),
	).resolves.toMatchObject({
		valid: true,
		trial: sdkTrial,
	});
	const reversed = {
		...sdkTrial,
		sdk: {
			...sdkTrial.sdk,
			session: Object.fromEntries(
				Object.entries(sdkTrial.sdk.session).reverse(),
			),
		},
	};
	for (const input of [sdkTrial, reversed])
		await expect(
			enqueueExperimentTrials(
				ctx,
				campaign,
				{ schemaVersion: 1, trials: [input] },
				"sdk-order",
			),
		).resolves.toMatchObject([
			{ input: sdkTrial, trialKey: expect.any(String) },
		]);
	expect(fake.enqueue.mock.calls[0]?.[3]).toBe(fake.enqueue.mock.calls[1]?.[3]);
});

it("rejects SDK settings without a compatible worker catalog", async () => {
	await expect(
		validateExperimentTrial(ctx.organizationId, sdkTrial),
	).rejects.toMatchObject({
		status: 422,
		code: "NVENC_SDK_UNAVAILABLE",
	});
	fake.readRuntime.mockResolvedValue({
		...sdkRuntime,
		nvencSdk: { ...sdkRuntime.nvencSdk, catalogSha256: "d".repeat(64) },
	});
	expect(await getExperimentCapabilities()).not.toHaveProperty("nvencSdk");
	await expect(
		enqueueExperimentTrials(
			ctx,
			campaign,
			{ schemaVersion: 1, trials: [sdkTrial] },
			"sdk-catalog",
		),
	).rejects.toMatchObject({ status: 409, code: "NVENC_SDK_CATALOG_CHANGED" });
});

it("admits QP maps and timed field writes using different phase bindings", async () => {
	fake.readRuntime.mockResolvedValue(sdkRuntime);
	const input = {
		...trial,
		sdk: {
			version: "13.0",
			session: {
				"NV_ENC_RC_PARAMS.qpMapMode": 2,
				"NV_ENC_RC_PARAMS.averageBitRate": 1_500_000,
			},
			pictures: [
				{
					frameIndex: 3,
					qpMap: "ff".repeat(2040),
					reconfigure: { "NV_ENC_RC_PARAMS.averageBitRate": 2_000_000 },
				},
			],
		},
	};
	await expect(
		validateExperimentTrial(ctx.organizationId, input),
	).resolves.toMatchObject({
		valid: true,
		trial: input,
	});
	await expect(
		validateExperimentTrial(ctx.organizationId, {
			...input,
			sdk: {
				...input.sdk,
				pictures: [
					{
						frameIndex: 3,
						qpMap: "ff".repeat(2040),
						reconfigure: { "NV_ENC_RC_PARAMS.aqStrength": 5 },
					},
				],
			},
		}),
	).rejects.toMatchObject({ status: 422, code: "INVALID_NVENC_SDK_SETTING" });
});

it.each([
	{ session: { "NV_ENC_RC_PARAMS.enableAQ": 1 } },
	{ session: { "NV_ENC_RC_PARAMS.aqStrength": -1 } },
	{ session: { "NV_ENC_CONFIG_H264.idrPeriod": 60 } },
	{ session: { "NV_ENC_RC_PARAMS.thisFieldDoesNotExist": 1 } },
	{
		pictures: [{ frameIndex: 0, fields: { "NV_ENC_RC_PARAMS.aqStrength": 6 } }],
	},
])("rejects SDK fields outside their catalog type, phase or codec", async (settings) => {
	fake.readRuntime.mockResolvedValue(sdkRuntime);
	await expect(
		validateExperimentTrial(ctx.organizationId, {
			...trial,
			sdk: { version: "13.0", ...settings },
		}),
	).rejects.toMatchObject({ status: 422, code: "INVALID_NVENC_SDK_SETTING" });
});

it("defaults to the historical v0.6.1 score and selects the v1 profile independently", async () => {
	fake.solve
		.mockReturnValueOnce({ trialId: legacyId })
		.mockReturnValueOnce({ trialId: dualId });
	await expect(
		selectExperimentQuality(ctx, campaign, selection),
	).resolves.toMatchObject({
		scoringProfileId: primaryProfile,
		trialId: legacyId,
	});
	await expect(
		selectExperimentQuality(ctx, campaign, {
			...selection,
			scoringProfileId: additionalProfile,
		}),
	).resolves.toMatchObject({
		scoringProfileId: additionalProfile,
		trialId: dualId,
	});

	expect(
		fake.solve.mock.calls[0]?.[0].candidates.map(
			(row: { scoreMilli: number }) => row.scoreMilli,
		),
	).toEqual([91200, 89100, 85000]);
	expect(fake.solve.mock.calls[1]?.[0].candidates).toEqual(
		[legacyId, dualId, failedId].map((id) => ({
			trialId: id,
			codec: "HEVC",
			scoringProfileId: additionalProfile,
			...(id === dualId ? { scoreMilli: 0 } : {}),
			rate: { numerator: "240000000", denominator: "60" },
			encodeMs: 123,
			gopFrames: 30,
		})),
	);
});

it.each([
	["another profile", { trialId: dualId, scoringProfileId: primaryProfile }],
	["a trial without a v1 score", { trialId: legacyId }],
	["an unknown trial", { trialId: campaign }],
])("rejects a Lean response selecting %s", async (_label, response) => {
	fake.solve.mockReturnValue(response);
	await expect(
		selectExperimentQuality(ctx, campaign, {
			...selection,
			scoringProfileId: additionalProfile,
		}),
	).rejects.toMatchObject({ status: 503, code: "OPTIMIZER_INVALID_RESULT" });
});

it("keeps trials without measurements in Lean's projected candidate set", async () => {
	const observed = {
		id: legacyId,
		codec: "HEVC",
		status: "SUCCEEDED",
		result: primaryResult,
		sourceSha256,
	};
	const unobserved = ["PENDING", "RUNNING", "FAILED", "CANCELED"].map(
		(status, index) => ({
			id: `11111111-1111-4111-8111-11111111111${index}`,
			codec: "H264",
			status,
			result: null,
			sourceSha256,
		}),
	);
	fake.rows.mockResolvedValue([observed, ...unobserved]);
	fake.solve.mockReturnValue({ trialId: observed.id, incompleteCount: 4 });
	await expect(
		selectExperimentQuality(ctx, campaign, selection),
	).resolves.toMatchObject({ candidateCount: 5, incompleteCount: 4 });
	const [request] = fake.solve.mock.calls[0] ?? [];
	expect(request.candidates).toEqual([
		{
			trialId: observed.id,
			codec: "HEVC",
			scoringProfileId: primaryProfile,
			scoreMilli: 91200,
			rate: { numerator: "240000000", denominator: "60" },
			encodeMs: 123,
			gopFrames: 30,
		},
		...unobserved.map(({ id, codec }) => ({
			trialId: id,
			codec,
			scoringProfileId: primaryProfile,
		})),
	]);
});

const cpuProfile = "official-vmaf-cpu-0.6.1";
const cpuRuntime = {
	runtimeId,
	runtimeKind: "software",
	scoringProfileId: cpuProfile,
	supportedCodecs: ["VP9"],
	softwareEncoders: [
		{
			encoder: "libvpx-vp9",
			codec: "VP9",
			options: [{ name: "b", type: "int", description: "" }],
			nativeOptions: [],
			limitations: [],
		},
	],
};
const cpuTrial = {
	window: trial.window,
	sourceId: trial.sourceId,
	codec: "VP9",
	software: { encoder: "libvpx-vp9", options: { b: "2000000" } },
};

it("validates software trials against the software worker and its installed catalog", async () => {
	fake.readRuntime.mockResolvedValue(cpuRuntime);
	await expect(
		validateExperimentTrial(ctx.organizationId, cpuTrial),
	).resolves.toMatchObject({ valid: true });
	expect(fake.readRuntime).toHaveBeenCalledWith(
		"/experiment-fixture",
		expect.any(Number),
		"software",
	);
	await expect(
		validateExperimentTrial(ctx.organizationId, {
			...cpuTrial,
			software: { ...cpuTrial.software, options: { unlisted: "1" } },
		}),
	).rejects.toMatchObject({ code: "INVALID_ENCODER_SETTING" });
	await expect(
		validateExperimentTrial(ctx.organizationId, trial),
	).rejects.toMatchObject({ code: "ENCODER_UNAVAILABLE" });
});

it("uses the CPU campaign identity for software batch admission", async () => {
	fake.enqueue.mockImplementationOnce((_ctx, _id, _key, _hash, prepare) =>
		prepare({ capabilityId: runtimeId, runtime: cpuRuntime }),
	);
	fake.readRuntime.mockResolvedValue(cpuRuntime);
	await expect(
		enqueueExperimentTrials(
			ctx,
			campaign,
			{ schemaVersion: 1, trials: [cpuTrial] },
			"cpu-trial",
		),
	).resolves.toMatchObject([{ input: { software: cpuTrial.software } }]);
});

it("does not reuse a CPU measurement for a requested CUDA profile", async () => {
	fake.rows.mockResolvedValue([
		{
			id: legacyId,
			codec: "VP9",
			status: "SUCCEEDED",
			result: { ...primaryResult, scoringProfileId: cpuProfile },
			sourceSha256,
		},
	]);
	fake.solve.mockReturnValueOnce({
		status: "insufficient_evidence",
		eligibleCount: 0,
		incompleteCount: 1,
	});
	await selectExperimentQuality(ctx, campaign, {
		...selection,
		scoringProfileId: primaryProfile,
	});
	expect(
		fake.solve.mock.calls.at(-1)?.[0].candidates[0].scoreMilli,
	).toBeUndefined();
	fake.solve.mockReturnValueOnce({ trialId: legacyId, incompleteCount: 0 });
	await selectExperimentQuality(ctx, campaign, {
		...selection,
		scoringProfileId: cpuProfile,
	});
	expect(fake.solve.mock.calls.at(-1)?.[0].candidates[0].scoreMilli).toBe(
		primaryResult.scoreMilli,
	);
});
