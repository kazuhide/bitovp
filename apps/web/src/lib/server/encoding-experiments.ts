import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
	type ExperimentNvencSdkBinding,
	type ExperimentNvencSdkSettings,
	type ExperimentRuntime,
	type ExperimentSoftwareEncoder,
	type ExperimentTrialInput,
	experimentBatchSchema,
	experimentCampaignInputSchema,
	experimentCodecs,
	experimentCpuScoringProfile,
	experimentNvencSdkVersion,
	experimentQualityRequestSchema,
	experimentResultSchema,
	experimentScoringProfile,
	experimentScoringProfiles,
	experimentTrialSchema,
	isExperimentNvencSdkFieldValue,
} from "@bitovp/core/encoding-experiments";
import {
	getExperimentRoot,
	readExperimentRuntime,
	readExperimentSource,
	readExperimentSources,
} from "@bitovp/core/encoding-experiments-files";
import {
	addExperimentCampaign,
	controlExperimentCampaign,
	EncodingExperimentError,
	type ExperimentContext,
	enqueueExperimentBatch,
	experimentCampaignDetail,
	experimentCampaignPage,
	experimentResultPage,
	experimentSelectionRows,
	experimentTrialPage,
} from "@bitovp/db";
import { type ZodType, z } from "zod";
import sdkCatalog from "../../../../../native/nvenc-experiments/catalog/sdk-13.0.json";

export {
	controlExperimentCampaign as setExperimentCampaignState,
	EncodingExperimentError,
	experimentCampaignDetail as getExperimentCampaign,
	experimentCampaignPage as listExperimentCampaigns,
	experimentResultPage as listExperimentResults,
	experimentTrialPage as listExperimentTrials,
};

export async function getExperimentCatalog(
	kind: "nvenc" | "software" = "nvenc",
) {
	if (kind === "nvenc") return sdkCatalog;
	const { runtime } = await requireRuntime("software");
	return {
		schemaVersion: 1,
		runtimeId: runtime.runtimeId,
		softwareEncoders: runtime.softwareEncoders,
	};
}

const sdkBindings = new Map(
	(
		(sdkCatalog as { sdkBindings?: readonly ExperimentNvencSdkBinding[] })
			.sdkBindings ?? []
	).map((binding) => [`${binding.phase}:${binding.field}`, binding]),
);
// Match the pinned generator's ASCII JSON bytes in the server bundle.
const sdkCatalogSha256 = createHash("sha256")
	.update(`${JSON.stringify(sdkCatalog, null, "\t")}\n`)
	.digest("hex");

function availableNvencSdk(runtime: ExperimentRuntime) {
	const sdk = runtime.nvencSdk;
	return sdk?.version === experimentNvencSdkVersion &&
		sdk.catalogSha256 === sdkCatalogSha256 &&
		sdkBindings.size > 0
		? sdk
		: undefined;
}

function parse<T>(schema: ZodType<T>, value: unknown) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new EncodingExperimentError(
			422,
			"INVALID_EXPERIMENT_REQUEST",
			issue?.message ?? "Invalid request",
			issue?.path.join("."),
		);
	}
	return parsed.data;
}

function sha(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function requireRuntime(kind: "nvenc" | "software") {
	const root = getExperimentRoot();
	const runtime = root
		? await readExperimentRuntime(root, Date.now(), kind)
		: null;
	if (!root || !runtime)
		throw new EncodingExperimentError(
			503,
			kind === "nvenc" ? "GPU_UNAVAILABLE" : "SOFTWARE_UNAVAILABLE",
			"The selected experiment worker is unavailable",
		);
	return { root, runtime };
}

export async function getExperimentCapabilities(
	kind: "nvenc" | "software" = "nvenc",
) {
	const root = getExperimentRoot();
	const runtime = root
		? await readExperimentRuntime(root, Date.now(), kind)
		: null;
	if (!runtime)
		return {
			schemaVersion: 1,
			available: false,
			reason: !root
				? "NOT_CONFIGURED"
				: kind === "nvenc"
					? "GPU_UNAVAILABLE"
					: "SOFTWARE_UNAVAILABLE",
		};
	const { nvencSdk: _, ...base } = runtime;
	const nvencSdk = availableNvencSdk(runtime);
	return {
		...base,
		...(nvencSdk && { nvencSdk }),
		available: true,
		capabilityId: runtime.runtimeId,
	};
}

export async function listExperimentSources(organizationId: string) {
	const root = getExperimentRoot();
	return {
		items: root ? await readExperimentSources(root, organizationId) : [],
		nextCursor: null,
	};
}

function verifyNvencSdkSettings(
	runtime: ExperimentRuntime,
	trial: ExperimentTrialInput,
	settings: ExperimentNvencSdkSettings,
) {
	if (runtime.nvencSdk?.version !== settings.version)
		throw new EncodingExperimentError(
			422,
			"NVENC_SDK_UNAVAILABLE",
			"The worker does not advertise the requested NVENC SDK",
			"sdk.version",
		);
	if (!availableNvencSdk(runtime))
		throw new EncodingExperimentError(
			409,
			"NVENC_SDK_CATALOG_CHANGED",
			"The worker uses a different NVENC SDK field catalog",
			"sdk.version",
		);

	const bags = [
		{ phase: "session", path: "sdk.session", fields: settings.session ?? {} },
		...(settings.pictures ?? []).flatMap(({ fields, reconfigure }, index) => [
			{
				phase: "picture",
				path: `sdk.pictures.${index}.fields`,
				fields: fields ?? {},
			},
			{
				phase: "reconfigure",
				path: `sdk.pictures.${index}.reconfigure`,
				fields: reconfigure ?? {},
			},
		]),
	];
	for (const { phase, path, fields } of bags)
		for (const [field, value] of Object.entries(fields)) {
			const binding = sdkBindings.get(`${phase}:${field}`);
			if (
				!binding?.codecs.includes(trial.codec) ||
				!isExperimentNvencSdkFieldValue(binding, value, trial.codec)
			)
				throw new EncodingExperimentError(
					422,
					"INVALID_NVENC_SDK_SETTING",
					"Use a supported NVENC SDK field and value for this codec and phase",
					`${path}.${field}`,
				);
		}
}

const softwareNumericBounds: Record<string, string> = {
	INT_MIN: "-2147483648",
	INT_MAX: "2147483647",
	I64_MIN: "-9223372036854775808",
	I64_MAX: "9223372036854775807",
	FLT_MAX: "3.40282347e38",
	"-FLT_MAX": "-3.40282347e38",
};

// Native libraries can impose extra constraints when opening the encoder.
function acceptsSoftwareValue(
	field: ExperimentSoftwareEncoder["options"][number],
	value: string,
	native: boolean,
) {
	const name = field.name;
	if (native && name === "zones")
		return value
			.split("/")
			.every((zone) =>
				/^\d+,\d+,(?:q=\d+|b=(?:\d+(?:\.\d*)?|\.\d+))$/.test(zone),
			);
	if (value.includes("=") || (value.includes("/") && !/^\d+\/\d+$/.test(value)))
		return false;
	if (!native && name === "flags") {
		const tokens = value.match(/[+-][a-z0-9_]+/g) ?? [];
		return (
			tokens.join("") === value &&
			tokens.every((token) => field.choices?.includes(token))
		);
	}
	if (!native && name === "force_key_frames")
		return (
			value === "source" ||
			value.split(",").every((t) => /^\d+(?:\.\d+)?$/.test(t))
		);
	if (native && name === "ts_layering_mode")
		return ["0", "2", "3", "4"].includes(value);
	if (
		native &&
		["ts_target_bitrate", "ts_rate_decimator", "ts_layer_id"].includes(name)
	) {
		const layerId = name === "ts_layer_id";
		const parts = value.split(",");
		return (
			parts.length <= (layerId ? 16 : 5) &&
			parts.every(
				(part) =>
					/^\d{1,10}$/.test(part) &&
					Number(part) >= (layerId ? 0 : 1) &&
					Number(part) <= (layerId ? 4 : 0xffffffff),
			)
		);
	}
	if (
		field.name === "passes" ||
		(native && field.type === "string" && field.choices)
	)
		return field.choices?.includes(value) === true;
	if (field.choices?.includes(value)) return true;
	if (field.type === "boolean")
		return (
			["true", "false", "0", "1"].includes(value) ||
			(!native && ["-1", "auto"].includes(value))
		);
	const integer = ["int", "int64", "uint", "uint64"].includes(field.type);
	if (!integer && !["float", "double"].includes(field.type)) return true;
	const syntax = integer
		? /^[+-]?\d+$/
		: /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/;
	if (!syntax.test(value)) return false;
	const numeric = (text: string) =>
		integer && /^[+-]?\d+$/.test(text) ? BigInt(text) : Number(text);
	const actual = numeric(value);
	const min =
		field.minimum === undefined
			? undefined
			: numeric(softwareNumericBounds[field.minimum] ?? field.minimum);
	const max =
		field.maximum === undefined
			? undefined
			: numeric(softwareNumericBounds[field.maximum] ?? field.maximum);
	return (
		!(min !== undefined && actual < min) && !(max !== undefined && actual > max)
	);
}

async function verifyTrial(
	root: string,
	organizationId: string,
	runtime: ExperimentRuntime,
	trial: ExperimentTrialInput,
) {
	if (Boolean(trial.software) !== (runtime.runtimeKind === "software"))
		throw new EncodingExperimentError(
			422,
			"ENCODER_UNAVAILABLE",
			"Use a campaign for the requested encoding backend",
		);
	if (trial.software) {
		const settings = trial.software;
		const encoder = runtime.softwareEncoders?.find(
			(e) => e.encoder === settings.encoder,
		);
		if (!encoder || encoder.codec !== trial.codec)
			throw new EncodingExperimentError(
				422,
				"ENCODER_UNAVAILABLE",
				"Software encoder is unavailable",
			);
		for (const group of ["options", "nativeOptions"] as const) {
			const fields = new Map(encoder[group].map((f) => [f.name, f]));
			for (const [key, value] of Object.entries(settings[group] ?? {})) {
				const field = fields.get(key);
				if (
					!field ||
					!acceptsSoftwareValue(field, value, group === "nativeOptions")
				)
					throw new EncodingExperimentError(
						422,
						"INVALID_ENCODER_SETTING",
						"Use an available encoder setting and a value within its declared range",
						`software.${group}.${key}`,
					);
			}
		}
	}
	if (!runtime.supportedCodecs.some((codec) => codec === trial.codec))
		throw new EncodingExperimentError(
			422,
			"CODEC_UNAVAILABLE",
			"Codec is unavailable on this worker",
			"codec",
		);
	const requestedProfile = trial.additionalScoringProfiles?.[0];
	if (
		requestedProfile &&
		runtime.additionalScoringProfiles?.[0]?.scoringProfileId !==
			requestedProfile
	)
		throw new EncodingExperimentError(
			422,
			"SCORING_PROFILE_UNAVAILABLE",
			"The requested VMAF scoring profile is unavailable",
			"additionalScoringProfiles",
		);
	if (trial.sdk) verifyNvencSdkSettings(runtime, trial, trial.sdk);
	const source = await readExperimentSource(
		root,
		organizationId,
		trial.sourceId,
	);
	if (!source)
		throw new EncodingExperimentError(
			422,
			"SOURCE_NOT_REGISTERED",
			"Source is not registered for this organization",
			"sourceId",
		);
	return source;
}

export async function validateExperimentTrial(
	organizationId: string,
	input: unknown,
) {
	const trial = parse(experimentTrialSchema, input);
	const { root, runtime } = await requireRuntime(
		trial.software ? "software" : "nvenc",
	);
	await verifyTrial(root, organizationId, runtime, trial);
	return { valid: true, trial, capabilityId: runtime.runtimeId };
}

function compareRuntime(expected: string, actual: string) {
	if (expected !== actual)
		throw new EncodingExperimentError(
			409,
			"CAPABILITY_CHANGED",
			"The experiment worker identity changed",
			"capabilityId",
		);
}

export async function createExperimentCampaign(
	ctx: ExperimentContext,
	input: unknown,
) {
	const campaign = parse(experimentCampaignInputSchema, input);
	const root = getExperimentRoot();
	const [gpu, cpu] = root
		? await Promise.all([
				readExperimentRuntime(root, Date.now(), "nvenc"),
				readExperimentRuntime(root, Date.now(), "software"),
			])
		: [];
	const runtime = [gpu, cpu].find(
		(r) => r?.runtimeId === campaign.capabilityId,
	);
	if (!runtime) {
		if (!gpu && !cpu)
			throw new EncodingExperimentError(
				503,
				"ENCODER_UNAVAILABLE",
				"No experiment worker is available",
			);
		throw new EncodingExperimentError(
			409,
			"CAPABILITY_CHANGED",
			"Use the current worker identity",
			"capabilityId",
		);
	}
	return addExperimentCampaign(ctx, {
		name: campaign.name,
		capabilityId: runtime.runtimeId,
		runtime,
	});
}

export function enqueueExperimentTrials(
	ctx: ExperimentContext,
	id: string,
	input: unknown,
	idempotencyKey: string | null,
) {
	if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
		throw new EncodingExperimentError(
			422,
			"INVALID_IDEMPOTENCY_KEY",
			"Use a stable Idempotency-Key (1–128 ASCII characters)",
		);
	const batch = parse(experimentBatchSchema, input);
	return enqueueExperimentBatch(
		ctx,
		id,
		idempotencyKey,
		sha(batch),
		async (campaign) => {
			const kind =
				z
					.object({ runtimeKind: z.literal("software").optional() })
					.parse(campaign.runtime ?? {}).runtimeKind ?? "nvenc";
			const { root, runtime } = await requireRuntime(kind);
			compareRuntime(campaign.capabilityId, runtime.runtimeId);
			const trials = [];
			for (const input of batch.trials) {
				const source = await verifyTrial(
					root,
					ctx.organizationId,
					runtime,
					input,
				);
				trials.push({
					trialKey: sha([1, campaign.capabilityId, source.sha256, input]),
					sourceSha256: source.sha256,
					input,
				});
			}
			return trials;
		},
	);
}

const experimentCodecSchema = z.enum(experimentCodecs);
const selectionResult = z.strictObject({
	schemaVersion: z.literal(1),
	evaluation: z.literal("measured"),
	scoringProfileId: z.enum(experimentScoringProfiles),
	candidateSetSha256: z.string().regex(/^[0-9a-f]{64}$/),
	status: z.enum([
		"selected",
		"no_feasible_candidate",
		"insufficient_evidence",
	]),
	candidateCount: z.number().int().nonnegative(),
	eligibleCount: z.number().int().nonnegative(),
	ineligibleCount: z.number().int().nonnegative(),
	incompleteCount: z.number().int().nonnegative(),
	trialId: z.uuid().optional(),
});

function runSelection(bin: string, request: object): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			bin,
			{
				timeout: 10_000,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024,
				env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
			},
			(error, stdout) => {
				if (error) {
					reject(
						new EncodingExperimentError(
							503,
							"OPTIMIZER_UNAVAILABLE",
							"Lean selection could not be executed",
						),
					);
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch {
					reject(
						new EncodingExperimentError(
							503,
							"OPTIMIZER_INVALID_RESULT",
							"Lean selection returned invalid JSON",
						),
					);
				}
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(request));
	});
}

export async function selectExperimentQuality(
	ctx: ExperimentContext,
	id: string,
	input: unknown,
) {
	const request = parse(experimentQualityRequestSchema, input);
	const campaign = await experimentCampaignDetail(ctx, id);
	const cpu = z
		.object({ runtimeKind: z.literal("software") })
		.safeParse(campaign.runtime).success;
	const explicitProfile =
		typeof input === "object" && input !== null && "scoringProfileId" in input;
	const scoringProfileId = explicitProfile
		? request.scoringProfileId
		: cpu
			? experimentCpuScoringProfile
			: experimentScoringProfile;
	const bin = process.env.BITOVP_EXPERIMENTS_OPTIMIZER;
	if (!bin || !isAbsolute(bin))
		throw new EncodingExperimentError(
			503,
			"OPTIMIZER_UNAVAILABLE",
			"Configure the Lean selection executable",
		);
	const rows = await experimentSelectionRows(
		ctx,
		id,
		request.sourceId,
		request.window.startPts,
		request.window.endPtsExclusive,
	);
	if (new Set(rows.map((row) => row.sourceSha256)).size > 1)
		throw new EncodingExperimentError(
			409,
			"SOURCE_ID_REUSED",
			"The source ID identifies multiple media versions",
		);
	const candidates = rows.map((row) => {
		const identity = {
			trialId: row.id,
			codec: experimentCodecSchema.parse(row.codec),
			scoringProfileId,
		};
		if (row.status !== "SUCCEEDED")
			return { ...identity, scoreMilli: undefined };
		const result = experimentResultSchema.parse(row.result);
		if (result.runtimeId !== campaign.capabilityId)
			throw new EncodingExperimentError(
				409,
				"CAPABILITY_CHANGED",
				"Result uses another worker identity",
			);
		const additional = result.additionalScores?.find(
			(score) => score.scoringProfileId === scoringProfileId,
		);
		const scoreMilli =
			scoringProfileId === result.scoringProfileId
				? result.scoreMilli
				: additional?.status === "succeeded"
					? additional.scoreMilli
					: undefined;
		return {
			...identity,
			scoreMilli,
			encodeMs: result.encodeMs,
			gopFrames: result.observedGopFrames,
			rate: {
				numerator: (
					BigInt(result.videoBytes) *
					8n *
					BigInt(result.timeBase.den)
				).toString(),
				denominator: (
					BigInt(result.durationTicks) * BigInt(result.timeBase.num)
				).toString(),
			},
		};
	});
	const candidateSetSha256 = sha(candidates);
	const checked = selectionResult.safeParse(
		await runSelection(bin, {
			schemaVersion: 1,
			evaluation: "measured",
			scoringProfileId,
			candidateSetSha256,
			constraints: request.constraints,
			candidates,
		}),
	);
	if (
		!checked.success ||
		checked.data.scoringProfileId !== scoringProfileId ||
		checked.data.candidateSetSha256 !== candidateSetSha256 ||
		checked.data.candidateCount !== candidates.length ||
		(checked.data.status === "selected"
			? !candidates.some(
					(candidate) =>
						candidate.trialId === checked.data.trialId &&
						candidate.scoreMilli !== undefined,
				)
			: checked.data.trialId !== undefined)
	)
		throw new EncodingExperimentError(
			503,
			"OPTIMIZER_INVALID_RESULT",
			"Lean selection returned a mismatched result",
		);
	return checked.data;
}
