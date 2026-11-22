import { z } from "zod";

export const experimentCodecs = ["H264", "HEVC", "AV1"] as const;
export const experimentScoringProfile = "official-vmaf-cuda-0.6.1";
export const experimentVmafV1Profile = "bitovp-vmaf-cuda-1.0.16-3d0h";
export const experimentScoringProfiles = [
	experimentScoringProfile,
	experimentVmafV1Profile,
] as const;
export const experimentScope = "encoding-experiments";
export const experimentBatchLimit = 128;
export const experimentRequestByteLimit = 256 * 1024;
export const experimentSourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const experimentDigest = z.string().regex(/^[0-9a-f]{64}$/);
export const experimentNvencSdkVersion = "13.0";

const uint = z.number().int().min(0).max(0xffffffff);
const positive = uint.min(1);
const maxSigned32 = 0x7fffffff;
const maxTrialFrames = 3600;
const maxSdkFieldCount = 4096;
// Two hex characters per signed-byte QP entry for each codec's 1080p block grid.
const qpMapLengths = { H264: 16_320, HEVC: 4_080, AV1: 1_020 };
const positiveSigned32 = positive.max(maxSigned32);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const positiveDecimal = z.string().regex(/^[1-9][0-9]{0,17}$/);
const vmafV1Profile = z.literal(experimentVmafV1Profile);
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
			end - start > divisor * BigInt(maxTrialFrames) ||
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

const sdkValue = z.union([z.boolean(), z.int()]);
const sdkHex = (maxCharacters: number) =>
	z
		.string()
		.max(maxCharacters)
		.regex(/^(?:[0-9a-f]{2})+(?![\s\S])/);
const sdkFields = z
	.record(
		z
			.string()
			.max(128)
			.regex(
				/^NV_ENC_[A-Z][A-Z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[(?:0|[1-9][0-9]{0,2})\])?)+(?![\s\S])/,
			),
		sdkValue,
	)
	.refine((fields) => {
		const count = Object.keys(fields).length;
		return count > 0 && count <= 512;
	}, "Specify 1 to 512 fields per NVENC SDK settings object")
	.transform((fields) =>
		Object.fromEntries(
			Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : Number(a > b))),
		),
	);

export const experimentNvencSdkSettingsSchema = z
	.strictObject({
		version: z.literal(experimentNvencSdkVersion),
		session: sdkFields.optional(),
		pictures: z
			.array(
				z
					.strictObject({
						frameIndex: uint.max(maxTrialFrames - 1),
						fields: sdkFields.optional(),
						qpMap: sdkHex(qpMapLengths.H264).optional(),
						reconfigure: sdkFields.optional(),
						metadata: z
							.array(
								z.strictObject({
									type: uint,
									payload: sdkHex(16_384 * 2),
								}),
							)
							.min(1)
							.max(32)
							.optional(),
					})
					.refine(
						(picture) =>
							picture.fields ||
							picture.qpMap ||
							picture.reconfigure ||
							picture.metadata,
						"Specify at least one NVENC SDK control for this frame",
					),
			)
			.min(1)
			.max(maxTrialFrames)
			.optional(),
	})
	.superRefine((settings, ctx) => {
		let count = Object.keys(settings.session ?? {}).length;
		const frames = new Set<number>();
		for (const [index, picture] of (settings.pictures ?? []).entries()) {
			if (frames.has(picture.frameIndex))
				ctx.addIssue({
					code: "custom",
					path: ["pictures", index, "frameIndex"],
					message: "Provide one NVENC SDK settings object per frame",
				});
			frames.add(picture.frameIndex);
			count += Object.keys(picture.fields ?? {}).length;
			count += Object.keys(picture.reconfigure ?? {}).length;
			if (picture.qpMap) count++;
			count += picture.metadata?.length ?? 0;
		}
		if (count < 1 || count > maxSdkFieldCount)
			ctx.addIssue({
				code: "custom",
				message: "Specify 1 to 4096 NVENC SDK settings",
			});
	})
	.transform((settings) => ({
		...settings,
		...(settings.pictures && {
			pictures: settings.pictures.toSorted(
				(a, b) => a.frameIndex - b.frameIndex,
			),
		}),
	}));

export type ExperimentNvencSdkSettings = z.infer<
	typeof experimentNvencSdkSettingsSchema
>;
export type ExperimentNvencSdkFieldValue = z.infer<typeof sdkValue>;
export type ExperimentNvencSdkBinding = {
	field: string;
	phase: "session" | "picture" | "reconfigure";
	codecs: readonly (typeof experimentCodecs)[number][];
	type: "integer" | "boolean";
	minimum: number;
	maximum: number;
	values?: readonly number[];
	choices?: readonly {
		name: string;
		value: number;
		codecs?: readonly (typeof experimentCodecs)[number][];
	}[];
};

export function isExperimentNvencSdkFieldValue(
	binding: ExperimentNvencSdkBinding,
	value: ExperimentNvencSdkFieldValue,
	codec: (typeof experimentCodecs)[number],
) {
	if (binding.type === "boolean") return typeof value === "boolean";
	const choice = binding.choices?.find((entry) => entry.value === value);
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= binding.minimum &&
		value <= binding.maximum &&
		(binding.values?.includes(value) ?? true) &&
		(choice?.codecs?.includes(codec) ?? true)
	);
}

export const experimentTrialSchema = z
	.strictObject({
		sourceId: experimentSourceId,
		replicateId: experimentSourceId.optional(),
		window: windowSchema,
		codec: z.enum(experimentCodecs),
		preset: z.enum(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]),
		tuning: z.literal("HIGH_QUALITY"),
		additionalScoringProfiles: z.tuple([vmafV1Profile]).optional(),
		sdk: experimentNvencSdkSettingsSchema.optional(),
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
	})
	.superRefine((trial, ctx) => {
		const frameCount = experimentFrameCount(trial.window);
		const mode = trial.sdk?.session?.["NV_ENC_RC_PARAMS.qpMapMode"];
		const pictures = trial.sdk?.pictures ?? [];
		if ((mode === 1 || mode === 2) && !pictures.some(({ qpMap }) => qpMap))
			ctx.addIssue({
				code: "custom",
				path: ["sdk", "session", "NV_ENC_RC_PARAMS.qpMapMode"],
				message: "Supply at least one picture QP map for the selected mode",
			});
		for (const [index, picture] of pictures.entries()) {
			if (picture.frameIndex >= frameCount)
				ctx.addIssue({
					code: "custom",
					path: ["sdk", "pictures", index, "frameIndex"],
					message: "Use a zero-based frame index inside the trial window",
				});
			if (trial.codec === "AV1")
				for (const [metadataIndex, item] of (picture.metadata ?? []).entries())
					if (item.type < 1 || item.type > 5)
						ctx.addIssue({
							code: "custom",
							path: [
								"sdk",
								"pictures",
								index,
								"metadata",
								metadataIndex,
								"type",
							],
							message: "Use an AV1 metadata type from 1 to 5",
						});
			if (!picture.qpMap) continue;
			const path = ["sdk", "pictures", index, "qpMap"];
			if (picture.qpMap.length !== qpMapLengths[trial.codec])
				ctx.addIssue({
					code: "custom",
					path,
					message: `Provide ${qpMapLengths[trial.codec]} lowercase hex characters for the 1080p ${trial.codec} QP map`,
				});
			if (mode !== 1 && mode !== 2)
				ctx.addIssue({
					code: "custom",
					path,
					message: "Select a session QP map mode before providing QP map data",
				});
			if (
				mode === 1 &&
				(trial.codec !== "H264" || !/^(?:0[0-5])+$/.test(picture.qpMap))
			)
				ctx.addIssue({
					code: "custom",
					path,
					message: "Emphasis mode requires H.264 and QP map values from 0 to 5",
				});
		}
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
	scoringProfileId: z
		.enum(experimentScoringProfiles)
		.default(experimentScoringProfile),
	constraints: z.strictObject({
		codec: z.enum(experimentCodecs).optional(),
		bitrateLimitBps: positive.optional(),
		encodeTimeLimitMs: uint.optional(),
		gopFrames: positive.optional(),
	}),
});

const vmafV1Score = z.discriminatedUnion("status", [
	z.strictObject({
		scoringProfileId: vmafV1Profile,
		status: z.literal("succeeded"),
		scoreMilli: z.number().int().min(0).max(110_000),
		meanVmaf: z.number().min(0).max(110),
		scoreMs: uint,
		scorerSha256: experimentDigest,
		modelSha256: experimentDigest,
	}),
	z.strictObject({
		scoringProfileId: vmafV1Profile,
		status: z.literal("failed"),
		failureCode: z.string().regex(/^[A-Z][A-Z_0-9]{1,63}$/),
	}),
]);

export const experimentResultSchema = z.strictObject({
	schemaVersion: z.literal(1),
	scoringProfileId: z.literal(experimentScoringProfile),
	runtimeId: experimentDigest,
	scoreMilli: z.number().int(),
	meanVmaf: z.number(),
	frameCount: positive.max(maxTrialFrames),
	videoBytes: positiveDecimal,
	durationTicks: positiveDecimal,
	timeBase,
	encodeMs: uint,
	scoreMs: uint,
	observedGopFrames: positive.optional(),
	additionalScores: z.tuple([vmafV1Score]).optional(),
	nvencSdkApplied: z
		.strictObject({
			fieldCount: positive.max(maxSdkFieldCount),
			manifestSha256: experimentDigest,
		})
		.optional(),
});

const vmafV1Runtime = z.strictObject({
	scoringProfileId: vmafV1Profile,
	scorerSha256: experimentDigest,
	modelSha256: experimentDigest,
	sourceSha256: experimentDigest,
	officialRevision: z.string().regex(/^[0-9a-f]{40}$/),
	decoderRuntimeSha256: experimentDigest,
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
	additionalScoringProfiles: z.tuple([vmafV1Runtime]).optional(),
	nvencSdk: z
		.strictObject({
			version: z.literal(experimentNvencSdkVersion),
			catalogSha256: experimentDigest,
		})
		.optional(),
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
