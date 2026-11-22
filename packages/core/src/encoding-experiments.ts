import { z } from "zod";

export const experimentCodecs = ["H264", "HEVC", "AV1"] as const;
export const experimentScoringProfile = "official-vmaf-cuda-0.6.1";
export const experimentScope = "encoding-experiments";
export const experimentBatchLimit = 128;
export const experimentSourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const experimentDigest = z.string().regex(/^[0-9a-f]{64}$/);

const uint = z.number().int().min(0).max(0xffffffff);
const positive = uint.min(1);
const maxSigned32 = 0x7fffffff;
const positiveSigned32 = positive.max(maxSigned32);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const positiveDecimal = z.string().regex(/^[1-9][0-9]{0,17}$/);
const timeBase = z.strictObject({
	num: positiveSigned32,
	den: positiveSigned32,
});

const windowSchema = z
	.strictObject({
		timeBase,
		startPts: decimal,
		endPtsExclusive: positiveDecimal,
	})
	.transform((window, ctx) => {
		const multiplier = BigInt(window.timeBase.num) * 30n;
		const divisor = BigInt(window.timeBase.den);
		const start = BigInt(window.startPts) * multiplier;
		const end = BigInt(window.endPtsExclusive) * multiplier;
		if (
			start % divisor !== 0n ||
			end % divisor !== 0n ||
			end <= start ||
			end - start > divisor * 3600n ||
			end / divisor > BigInt(maxSigned32)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Use a positive window of 1 to 3600 frames on the 30 fps timeline",
			});
			return z.NEVER;
		}
		return {
			timeBase: { num: 1, den: 30 },
			startPts: (start / divisor).toString(),
			endPtsExclusive: (end / divisor).toString(),
		};
	});

export const experimentTrialSchema = z.strictObject({
	sourceId: experimentSourceId,
	replicateId: experimentSourceId.optional(),
	window: windowSchema,
	codec: z.enum(experimentCodecs),
	preset: z.enum(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]),
	tuning: z.literal("HIGH_QUALITY"),
	config: z.strictObject({
		gopLength: positiveSigned32,
		frameIntervalP: z.number().int().min(1).max(5).optional(),
		rcParams: z
			.strictObject({
				rateControlMode: z.literal("VBR"),
				averageBitRate: positive,
				maxBitRate: positiveSigned32.optional(),
				vbvBufferSize: positiveSigned32.optional(),
				enableAQ: z.boolean().optional(),
				enableTemporalAQ: z.boolean().optional(),
				lookaheadDepth: uint.max(32).optional(),
			})
			.refine(
				(rate) =>
					rate.maxBitRate === undefined ||
					rate.maxBitRate >= rate.averageBitRate,
				{
					path: ["maxBitRate"],
					message: "Peak bitrate must be at least the average target",
				},
			),
	}),
});
export type ExperimentTrialInput = z.infer<typeof experimentTrialSchema>;

export const experimentBatchSchema = z.strictObject({
	schemaVersion: z.literal(1),
	trials: z.array(experimentTrialSchema).min(1).max(experimentBatchLimit),
});

export const experimentCampaignInputSchema = z.strictObject({
	schemaVersion: z.literal(1),
	name: z.string().trim().min(1).max(120),
	capabilityId: experimentDigest,
});

export const experimentQualityRequestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	sourceId: experimentSourceId,
	window: windowSchema,
	constraints: z.strictObject({
		codec: z.enum(experimentCodecs).optional(),
		bitrateLimitBps: positive.optional(),
		encodeTimeLimitMs: uint.optional(),
		gopFrames: positive.optional(),
	}),
});

export const experimentResultSchema = z.strictObject({
	schemaVersion: z.literal(1),
	scoringProfileId: z.literal(experimentScoringProfile),
	runtimeId: experimentDigest,
	scoreMilli: z.number().int(),
	meanVmaf: z.number(),
	frameCount: positive.max(3600),
	videoBytes: positiveDecimal,
	durationTicks: positiveDecimal,
	timeBase,
	encodeMs: uint,
	scoreMs: uint,
	observedGopFrames: positive.optional(),
});

export const experimentRuntimeSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runtimeId: experimentDigest,
	gpuUuid: z.string().regex(/^GPU-[0-9a-fA-F-]{36}$/),
	gpuName: z.string().min(1).max(128),
	driverVersion: z.string().regex(/^[0-9.]{1,32}$/),
	supportedCodecs: z.array(z.enum(experimentCodecs)).min(1).max(3),
	scoringProfileId: z.literal(experimentScoringProfile),
	ffmpegSha256: experimentDigest,
	ffprobeSha256: experimentDigest,
	modelSha256: experimentDigest,
	runnerSha256: experimentDigest,
	sdkProbeSha256: experimentDigest,
	maxNvencApiVersion: uint.min(208),
});

export const experimentWorkerHealthSchema = z.strictObject({
	checkedAt: z.number().int().nonnegative(),
	runtime: experimentRuntimeSchema,
});

export const experimentSourceSchema = z.strictObject({
	id: experimentSourceId,
	label: z.string().trim().min(1).max(120),
	sha256: experimentDigest,
});

export type ExperimentResult = z.infer<typeof experimentResultSchema>;
export type ExperimentRuntime = z.infer<typeof experimentRuntimeSchema>;
export const experimentFrameCount = (window: ExperimentTrialInput["window"]) =>
	Number(
		((BigInt(window.endPtsExclusive) - BigInt(window.startPts)) *
			BigInt(window.timeBase.num) *
			30n) /
			BigInt(window.timeBase.den),
	);
