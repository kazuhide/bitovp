import type { PerTitleCodec, PerTitleGoal } from "@bitovp/core";
import { z } from "zod";

const MAX_BYTES = 128 * 1024;
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = nonnegative.refine((value) => value > 0);
const id = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_.:-]+$/);
const symbol = z
	.string()
	.min(1)
	.max(80)
	.regex(/^[A-Z0-9_]+$/);
const codec = z.enum(["H264", "H265", "H265V2", "VP9", "AV1"]);
const selection = z.enum(["OPTIMIZED", "COMPLEXITY_RANGE"]);
const rangeFields = {
	minBitrate: integer.optional(),
	maxBitrate: integer.optional(),
	bitrateSelectionMode: selection.optional(),
	lowComplexityBoundaryForMaxBitrate: integer.optional(),
	highComplexityBoundaryForMaxBitrate: integer.optional(),
};
const forced = z
	.object({
		forcedRenditionAboveHighestFixedRepresentation: z
			.number()
			.int()
			.min(0)
			.max(64)
			.optional(),
		forcedRenditionAboveHighestFixedRepresentationFactor: positive.optional(),
		forcedRenditionAboveHighestFixedRepresentationCalculationMode: z
			.enum(["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"])
			.optional(),
	})
	.strict();
const row = z
	.object({ id, height: integer, width: integer.optional(), ...rangeFields })
	.strict();
const automatic = z
	.object({
		id,
		height: integer.optional(),
		width: integer.optional(),
		...rangeFields,
	})
	.strict();
const stepFields = {
	minBitrateStepSize: positive.refine((n) => n > 1).optional(),
	maxBitrateStepSize: positive.refine((n) => n > 1).optional(),
};
const goalSchema = z
	.object({
		strategy: z.enum([
			"automatic",
			"count",
			"required-resolutions",
			"fixed-resolutions",
			"fixed-ranges",
		]),
		codec,
		minBitrate: integer,
		maxBitrate: integer,
		...stepFields,
		countPolicy: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("unrestricted") }).strict(),
			z
				.object({ kind: z.enum(["exact", "maximum"]), count: integer.max(256) })
				.strict(),
		]),
		rows: z.array(row).max(64).optional(),
		automaticTemplates: z.array(automatic).max(64).optional(),
		fixedResolutionAndBitrateConfiguration: forced.optional(),
		inputHeight: integer.optional(),
		inputWidth: integer.optional(),
		scenarioFractions: z
			.array(z.number().finite().min(0).max(1))
			.max(9)
			.optional(),
	})
	.strict();
const perTitleSettings = z.object(rangeFields).strict();
const referenceStream = z
	.object({
		id,
		codec: codec.optional(),
		mode: z.enum([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		]),
		height: integer.optional(),
		width: integer.optional(),
		bitrate: integer.nullable().optional(),
		perTitleSettings: perTitleSettings.optional(),
		sao: z.boolean().optional(),
		level: symbol.nullable().optional(),
		qpMin: nonnegative.optional(),
		subMe: nonnegative.optional(),
		profile: symbol.optional(),
		maxCtuSize: symbol.optional(),
		colorConfig: z
			.object({
				colorSpace: symbol.optional(),
				colorTransfer: symbol.optional(),
				colorPrimaries: symbol.optional(),
			})
			.strict()
			.optional(),
		rcLookahead: nonnegative.optional(),
		motionSearch: symbol.optional(),
		tuInterDepth: symbol.optional(),
		tuIntraDepth: symbol.optional(),
		motionSearchRange: nonnegative.optional(),
		sceneCutThreshold: nonnegative.optional(),
		maxKeyframeInterval: positive.optional(),
		minKeyframeInterval: nonnegative.optional(),
		adaptiveQuantizationMode: symbol.optional(),
		weightPredictionOnBSlice: z.boolean().optional(),
		weightPredictionOnPSlice: z.boolean().optional(),
		adaptiveQuantizationStrength: nonnegative.optional(),
		psyRateDistortionOptimization: nonnegative.optional(),
		psyRateDistortionOptimizedQuantization: nonnegative.optional(),
	})
	.strict();
const referenceSchema = z
	.object({
		codec,
		global: z
			.object({
				minBitrate: integer,
				maxBitrate: integer,
				...stepFields,
				targetQualityCrf: nonnegative.optional(),
				codecBufsizeFactor: positive.optional(),
				codecMaxBitrateFactor: positive.optional(),
				codecMinBitrateFactor: positive.optional(),
				fixedResolutionAndBitrateConfiguration: forced.optional(),
			})
			.strict(),
		streams: z.array(referenceStream).min(1).max(64),
	})
	.strict();

/** A local comparison baseline, without account, input or storage bindings. */
export type PerTitleReference = z.infer<typeof referenceSchema>;
const preset = z
	.object({
		version: z.literal(1),
		goal: goalSchema.optional(),
		reference: referenceSchema.optional(),
	})
	.strict();

export class PerTitlePresetError extends Error {
	readonly code = "INVALID_PRESET";
	constructor() {
		super("Invalid Per-Title preset.");
		this.name = "PerTitlePresetError";
	}
}
function invalid(): never {
	throw new PerTitlePresetError();
}
function checkRange(
	value: z.infer<typeof automatic>,
	requireBounds = false,
): void {
	if (
		requireBounds &&
		(value.minBitrate === undefined || value.maxBitrate === undefined)
	)
		invalid();
	if (
		value.minBitrate !== undefined &&
		value.maxBitrate !== undefined &&
		value.minBitrate > value.maxBitrate
	)
		invalid();
	const low = value.lowComplexityBoundaryForMaxBitrate;
	const high = value.highComplexityBoundaryForMaxBitrate;
	if (
		value.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
		(low === undefined || high === undefined || low >= high)
	)
		invalid();
}

function checkGoal(
	goal: PerTitleGoal,
	allowed: readonly PerTitleCodec[],
): void {
	if (!allowed.includes(goal.codec) || goal.minBitrate > goal.maxBitrate)
		invalid();
	if ((goal.maxBitrateStepSize ?? 1.9) < (goal.minBitrateStepSize ?? 1.5))
		invalid();
	const storedRows = goal.rows ?? [];
	const rows =
		goal.strategy === "automatic" || goal.strategy === "count"
			? []
			: storedRows;
	const automaticRows = goal.automaticTemplates;
	const implicitAutomatic =
		automaticRows === undefined &&
		goal.strategy !== "fixed-ranges" &&
		goal.strategy !== "fixed-resolutions"
			? 1
			: 0;
	const templates = [...storedRows, ...(automaticRows ?? [])];
	if (
		templates.length + implicitAutomatic > 64 ||
		new Set(templates.map((row) => row.id)).size !== templates.length
	)
		invalid();
	if (
		goal.strategy !== "automatic" &&
		goal.strategy !== "count" &&
		!rows.length
	)
		invalid();
	if (goal.strategy === "count" && goal.countPolicy.kind === "unrestricted")
		invalid();
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		rows.length > goal.countPolicy.count
	)
		invalid();
	// Fixed-bitrate settings on ordinary templates are retained source data.
	// Their semantics do not constrain the automatic template's output.
	for (const item of goal.strategy === "fixed-ranges" ? rows : []) {
		checkRange(item, true);
		if (
			goal.strategy === "fixed-ranges" &&
			(item.minBitrate === undefined || item.maxBitrate === undefined)
		)
			invalid();
		if (
			(item.minBitrate !== undefined && item.minBitrate < goal.minBitrate) ||
			(item.maxBitrate !== undefined && item.maxBitrate > goal.maxBitrate)
		)
			invalid();
	}
}
function referenceGoal(reference: PerTitleReference): PerTitleGoal {
	const fixed = reference.streams.filter(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	const ranged = fixed.filter(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	// A single goal strategy cannot silently replace mixed fixed template modes.
	if (ranged.length && ranged.length !== fixed.length) invalid();
	const ids = new Set<string>();
	for (const stream of reference.streams) {
		if (
			ids.has(stream.id) ||
			(stream.codec !== undefined && stream.codec !== reference.codec)
		)
			invalid();
		ids.add(stream.id);
		if (stream.mode !== "PER_TITLE_TEMPLATE" && stream.height === undefined)
			invalid();
		if (
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
			!stream.perTitleSettings
		)
			invalid();
		if (stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
			checkRange({ id: stream.id, ...stream.perTitleSettings }, true);
	}
	const project = (stream: PerTitleReference["streams"][number]) => ({
		id: stream.id,
		...(stream.height !== undefined ? { height: stream.height } : {}),
		...(stream.width !== undefined ? { width: stream.width } : {}),
		...stream.perTitleSettings,
	});
	const {
		minBitrate,
		maxBitrate,
		minBitrateStepSize,
		maxBitrateStepSize,
		fixedResolutionAndBitrateConfiguration,
	} = reference.global;
	return {
		strategy: ranged.length
			? "fixed-ranges"
			: fixed.length
				? reference.streams.some(
						(stream) => stream.mode === "PER_TITLE_TEMPLATE",
					)
					? "required-resolutions"
					: "fixed-resolutions"
				: "automatic",
		codec: reference.codec,
		minBitrate,
		maxBitrate,
		...(minBitrateStepSize !== undefined ? { minBitrateStepSize } : {}),
		...(maxBitrateStepSize !== undefined ? { maxBitrateStepSize } : {}),
		countPolicy: { kind: "unrestricted" },
		rows: fixed.map((stream) => ({
			...project(stream),
			height: stream.height as number,
		})),
		automaticTemplates: reference.streams
			.filter((stream) => stream.mode === "PER_TITLE_TEMPLATE")
			.map(project),
		...(fixedResolutionAndBitrateConfiguration
			? { fixedResolutionAndBitrateConfiguration }
			: {}),
	};
}
function validate(
	value: unknown,
	allowed: readonly PerTitleCodec[],
): { goal: PerTitleGoal; reference?: PerTitleReference } {
	const parsed = preset.parse(value);
	if (!parsed.goal && !parsed.reference) invalid();
	if (parsed.reference) checkGoal(referenceGoal(parsed.reference), allowed);
	const goal =
		parsed.goal ?? referenceGoal(parsed.reference as PerTitleReference);
	checkGoal(goal, allowed);
	if (parsed.reference && goal.codec !== parsed.reference.codec) invalid();
	return { goal, ...(parsed.reference ? { reference: parsed.reference } : {}) };
}

/** Parses only bounded, allowlisted local data. Errors never include source text. */
export function parsePerTitlePreset(
	text: string,
	allowedCodecs: readonly PerTitleCodec[],
): { goal: PerTitleGoal; reference?: PerTitleReference } {
	try {
		if (
			typeof text !== "string" ||
			text.length > MAX_BYTES ||
			new TextEncoder().encode(text).byteLength > MAX_BYTES
		)
			invalid();
		return validate(JSON.parse(text), allowedCodecs);
	} catch {
		return invalid();
	}
}
export function serializePerTitlePreset(
	goal: PerTitleGoal,
	reference?: PerTitleReference,
): string {
	try {
		const checked = validate(
			{ version: 1, goal, ...(reference ? { reference } : {}) },
			["H264", "H265", "H265V2", "VP9", "AV1"],
		);
		const text = JSON.stringify({ version: 1, ...checked }, null, 2);
		if (new TextEncoder().encode(text).byteLength > MAX_BYTES) invalid();
		return text;
	} catch {
		return invalid();
	}
}
