import { PER_TITLE_SIMULATOR_MAX_BITRATE } from "./per-title-candidate-api";
import {
	type BitrateInterval,
	boundComplexityRange,
	certifyComplexityIntervals,
	evaluateForcedRenditions,
} from "./per-title-constraints";
import { decimalParameter } from "./per-title-numeric";
import { resolvePerTitleAnalysis } from "./per-title-output-analysis";
import type { PerTitleApiSettings, PerTitleGoal } from "./per-title-simulator";
import { perTitleSchema, perTitleStreamSettingsSchema } from "./schema";

/** A conditional configuration model, never a measured or guaranteed output count. */
export type PerTitleMixedSequenceCertificate = {
	kind: "mixed-role-sequence";
	count: number;
	inputRange: BitrateInterval;
	fixedRowIds: string[];
	lowerRowId: string;
	upperCandidateRowIds: string[];
	upperMaximumCount: 1;
	sourceConditions: {
		/** Optimized analysis probe bitrate after complexityFactor, not output bitrate. */
		lowerProbe: BitrateInterval & {
			status: "not-measured";
			rowId: string;
		};
		geometry: {
			status: "not-measured";
			basis: "height" | "width";
			commonSourceAspectRatio: boolean;
			/** Required source extent in pixels on the declared ordering basis. */
			minimumSourceDimension: number;
			/** Rounded encoder widths must preserve the declared order and equal-size groups. */
			postRoundingWidthOrderPreserved: { status: "not-measured" };
		};
		fixedProbeOrder: {
			status: "not-measured";
			equalDimensionGroups: string[][];
		};
	};
	spacing: {
		maximumWithinRowRatio: number;
		minimumAdjacentRatio: number | null;
		maximumAdjacentRatio: number | null;
		checkedSegments: number;
		firstRange: BitrateInterval;
		upperCheckedSegments: number;
	};
};

type Fraction = { n: bigint; d: bigint };
type Curve = BitrateInterval & { low: number; high: number };
const integer = (value: number | bigint): Fraction => ({
	n: BigInt(value),
	d: 1n,
});
const add = (a: Fraction, b: Fraction): Fraction => ({
	n: a.n * b.d + b.n * a.d,
	d: a.d * b.d,
});
const multiply = (a: Fraction, b: Fraction): Fraction => ({
	n: a.n * b.n,
	d: a.d * b.d,
});
const divide = (a: Fraction, b: Fraction): Fraction => ({
	n: a.n * b.d,
	d: a.d * b.n,
});
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const maximum = (a: Fraction, b: Fraction) => (compare(a, b) >= 0n ? a : b);
const positive = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= PER_TITLE_SIMULATOR_MAX_BITRATE;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function affine(row: Curve, input: Fraction): Fraction {
	if (compare(input, integer(row.low)) <= 0n) return integer(row.minimum);
	if (compare(input, integer(row.high)) >= 0n) return integer(row.maximum);
	return add(
		integer(row.minimum),
		multiply(add(input, integer(-row.low)), {
			n: BigInt(row.maximum - row.minimum),
			d: BigInt(row.high - row.low),
		}),
	);
}

/** Excludes a second ordinary upper target, including floor and tolerance margins. */
function certifyUpper(
	row: Curve,
	input: BitrateInterval,
	step: number,
): number | null {
	const s = decimalParameter(step);
	const ratio = add(s, { n: -1n, d: 100n });
	if (compare(ratio, integer(1)) <= 0n) return null;
	const cuts = [
		integer(input.minimum),
		integer(input.maximum),
		integer(row.low),
		integer(row.high),
		multiply(s, integer(row.minimum + 1)),
		...(row.maximum > row.minimum
			? [
					add(integer(row.low), {
						n: 2n * BigInt(row.high - row.low),
						d: BigInt(row.maximum - row.minimum),
					}),
				]
			: []),
	]
		.filter(
			(value) =>
				compare(value, integer(input.minimum)) >= 0n &&
				compare(value, integer(input.maximum)) <= 0n,
		)
		.sort((a, b) => Number(compare(a, b)));
	// The effective minimum is bounded by both affine pieces below. After each
	// lower clamp, C - bound * ratio² is affine; checking its cuts covers all C.
	// Two bits per step cover floor and floating evaluation at an integer edge.
	for (const value of cuts) {
		const bounds = [
			maximum(integer(row.minimum), add(affine(row, value), integer(-2))),
			maximum(integer(row.minimum), add(divide(value, s), integer(-1))),
		];
		for (const bound of bounds)
			if (
				compare(
					add(add(value, multiply(integer(2), ratio)), integer(2)),
					multiply(multiply(bound, ratio), ratio),
				) >= 0n
			)
				return null;
	}
	return cuts.length;
}

const codecFields = {
	H264: "h264Configuration",
	H265: "h265Configuration",
	H265V2: "h265V2Configuration",
	VP9: "vp9Configuration",
	AV1: "av1Configuration",
} as const;
const rowKeys = [
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
] as const;
const optionalGlobalKeys = [
	"targetQualityCrf",
	"targetQualityQp",
	"complexityFactor",
	"resolutionScaleFactor",
	"codecMinBitrateFactor",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
] as const;
const forcedKeys = [
	"forcedRenditionAboveHighestFixedRepresentation",
	"forcedRenditionAboveHighestFixedRepresentationFactor",
	"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
] as const;

/** Certifies only this topology on the actual emitted settings and matching requirements. */
export function certifyPerTitleMixedSequence(
	goal: PerTitleGoal,
	api: PerTitleApiSettings,
): PerTitleMixedSequenceCertificate | null {
	if (
		!record(goal) ||
		!record(api) ||
		!record(api.global) ||
		!Array.isArray(api.streams) ||
		!Array.isArray(goal.rows) ||
		!Array.isArray(goal.automaticTemplates) ||
		!record(goal.countPolicy) ||
		goal.strategy !== "fixed-ranges" ||
		goal.autoRepresentations !== false ||
		goal.countPolicy.kind !== "exact" ||
		!Number.isSafeInteger(goal.countPolicy.count) ||
		goal.rows.length < 1 ||
		goal.rows.length > 62 ||
		goal.rows.some(
			(row) =>
				!record(row) ||
				(row.mode !== undefined &&
					row.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"),
		) ||
		goal.countPolicy.count !== goal.rows.length + 2 ||
		goal.automaticTemplates.length < 2 ||
		api.global.autoRepresentations !== undefined ||
		!Object.hasOwn(codecFields, goal.codec) ||
		!perTitleSchema.safeParse({ [codecFields[goal.codec]]: api.global }).success
	)
		return null;
	const global = api.global;
	if (
		!positive(global.minBitrate) ||
		!positive(global.maxBitrate) ||
		global.minBitrate > global.maxBitrate ||
		global.minBitrate !== goal.minBitrate ||
		global.maxBitrate !== goal.maxBitrate ||
		global.minBitrateStepSize !== goal.minBitrateStepSize ||
		global.maxBitrateStepSize !== goal.maxBitrateStepSize ||
		optionalGlobalKeys.some((key) => goal[key] !== global[key])
	)
		return null;
	const s = global.minBitrateStepSize,
		t = global.maxBitrateStepSize;
	if (!Number.isFinite(s) || !Number.isFinite(t) || s <= 1.01 || t < s)
		return null;
	const rule = global.fixedResolutionAndBitrateConfiguration;
	const sourceRule = goal.fixedResolutionAndBitrateConfiguration;
	if (
		!record(rule) ||
		!record(sourceRule) ||
		rule.forcedRenditionAboveHighestFixedRepresentation !== 1 ||
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
			"LAST_CALCULATED_BITRATE" ||
		!Number.isFinite(
			rule.forcedRenditionAboveHighestFixedRepresentationFactor,
		) ||
		(rule.forcedRenditionAboveHighestFixedRepresentationFactor ?? 0) <= 1 ||
		Object.keys(sourceRule).some(
			(key) => !forcedKeys.some((allowed) => key === allowed),
		) ||
		forcedKeys.some((key) => sourceRule[key] !== rule[key])
	)
		return null;
	const templates = [...goal.rows, ...goal.automaticTemplates];
	if (
		templates.length !== api.streams.length ||
		templates.length > 64 ||
		templates.some(
			(row) => !record(row) || typeof row.id !== "string" || !row.id,
		) ||
		api.streams.some(
			(row) => !record(row) || typeof row.rowId !== "string" || !row.rowId,
		) ||
		templates.some(
			(row) =>
				(row.height !== undefined && !positive(row.height)) ||
				(row.width !== undefined && !positive(row.width)),
		) ||
		new Set(templates.map((row) => row.id)).size !== templates.length ||
		new Set(api.streams.map((row) => row?.rowId)).size !== api.streams.length
	)
		return null;
	const useWidth = templates.every((row) => positive(row.width));
	const basis = useWidth ? "width" : "height";
	if (
		!useWidth &&
		templates.some((row) => row.width !== undefined || !positive(row.height))
	)
		return null;
	const size = (row: { height?: number; width?: number }) =>
		row[basis] as number;
	for (const axis of ["height", "width"] as const) {
		const declared = axis === "height" ? goal.inputHeight : goal.inputWidth;
		if (
			declared !== undefined &&
			(!positive(declared) ||
				templates.some(
					(row) => row[axis] !== undefined && (row[axis] as number) > declared,
				))
		)
			return null;
	}
	const minimumSourceDimension = Math.max(...templates.map(size));
	const streams = new Map(api.streams.map((stream) => [stream.rowId, stream]));
	for (const template of templates) {
		const stream = streams.get(template.id);
		if (
			!stream ||
			stream.height !== template.height ||
			stream.width !== template.width ||
			(stream.perTitleSettings !== undefined &&
				!perTitleStreamSettingsSchema.safeParse(stream.perTitleSettings)
					.success) ||
			(goal.codec !== "H264" &&
				goal.codec !== "H265" &&
				(stream.perTitleSettings?.codecMaxBitrateFactor !== undefined ||
					stream.perTitleSettings?.codecBufsizeFactor !== undefined)) ||
			rowKeys.some((key) => template[key] !== stream.perTitleSettings?.[key])
		)
			return null;
	}
	const rows = [...goal.rows].sort(
		(a, b) =>
			size(a) - size(b) ||
			(a.minBitrate ?? 0) - (b.minBitrate ?? 0) ||
			(a.maxBitrate ?? 0) - (b.maxBitrate ?? 0),
	);
	const curves: Curve[] = [];
	for (const row of rows) {
		if (
			streams.get(row.id)?.mode !==
				"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
			!positive(row.minBitrate) ||
			!positive(row.maxBitrate) ||
			row.minBitrate < global.minBitrate ||
			row.maxBitrate > global.maxBitrate ||
			row.minBitrate > row.maxBitrate ||
			row.bitrateSelectionMode !== "COMPLEXITY_RANGE" ||
			!positive(row.lowComplexityBoundaryForMaxBitrate) ||
			!positive(row.highComplexityBoundaryForMaxBitrate) ||
			row.lowComplexityBoundaryForMaxBitrate >=
				row.highComplexityBoundaryForMaxBitrate
		)
			return null;
		curves.push({
			minimum: row.minBitrate,
			maximum: row.maxBitrate,
			low: row.lowComplexityBoundaryForMaxBitrate,
			high: row.highComplexityBoundaryForMaxBitrate,
		});
	}
	const first = rows[0],
		top = rows.at(-1);
	if (
		!first ||
		!top ||
		rows.filter((row) => size(row) === size(top)).length !== 1
	)
		return null;
	const lower = goal.automaticTemplates.filter(
		(row) => size(row) < size(first),
	);
	const upper = goal.automaticTemplates.filter((row) => size(row) > size(top));
	if (
		lower.length !== 1 ||
		upper.length < 1 ||
		lower.length + upper.length !== goal.automaticTemplates.length ||
		goal.automaticTemplates.some(
			(row) =>
				streams.get(row.id)?.mode !== "PER_TITLE_TEMPLATE" ||
				rowKeys.some((key) => row[key] !== undefined),
		)
	)
		return null;
	const resolved = resolvePerTitleAnalysis(api, global.minBitrate);
	if (
		!positive(resolved.complexityInput) ||
		resolved.complexityInput > global.maxBitrate
	)
		return null;
	const inputRange = {
		minimum: resolved.complexityInput,
		maximum: global.maxBitrate,
	};
	const proof = certifyComplexityIntervals(curves, inputRange, s);
	const firstCurve = curves[0],
		topCurve = curves.at(-1);
	if (!proof || !firstCurve || !topCurve) return null;
	const firstRange = boundComplexityRange(firstCurve, inputRange, s);
	if (
		!firstRange ||
		proof.maximumWithinRowRatio + 0.01 >= s ||
		(proof.minimumAdjacentRatio ?? Infinity) < s ||
		(proof.maximumAdjacentRatio ?? s) > t ||
		compare(
			integer(firstRange.minimum),
			multiply(integer(global.minBitrate), decimalParameter(s)),
		) < 0n ||
		compare(
			integer(firstRange.maximum),
			multiply(integer(global.minBitrate), decimalParameter(t)),
		) > 0n
	)
		return null;
	const upperSegments = certifyUpper(topCurve, inputRange, s);
	const forced = evaluateForcedRenditions({
		base: { minimum: topCurve.minimum, maximum: topCurve.maximum },
		count: 1,
		factor: rule.forcedRenditionAboveHighestFixedRepresentationFactor as number,
	})?.[0];
	if (
		!upperSegments ||
		!forced ||
		forced.minimum <= topCurve.minimum ||
		forced.maximum > global.maxBitrate
	)
		return null;
	const ratio = add(decimalParameter(s), { n: -1n, d: 100n });
	const lowerMaximum =
		Number((BigInt(global.minBitrate) * ratio.n) / ratio.d) - 2;
	const lowerRow = lower[0];
	if (!lowerRow || !positive(lowerMaximum) || lowerMaximum < global.minBitrate)
		return null;
	const groups = new Map<number, string[]>();
	for (const row of rows)
		groups.set(size(row), [...(groups.get(size(row)) ?? []), row.id]);
	return {
		kind: "mixed-role-sequence",
		count: goal.countPolicy.count,
		inputRange,
		fixedRowIds: rows.map((row) => row.id),
		lowerRowId: lowerRow.id,
		upperCandidateRowIds: upper.map((row) => row.id),
		upperMaximumCount: 1,
		sourceConditions: {
			lowerProbe: {
				status: "not-measured",
				rowId: lowerRow.id,
				minimum: global.minBitrate,
				maximum: lowerMaximum,
			},
			geometry: {
				status: "not-measured",
				basis,
				commonSourceAspectRatio: !useWidth,
				minimumSourceDimension,
				postRoundingWidthOrderPreserved: { status: "not-measured" },
			},
			fixedProbeOrder: {
				status: "not-measured",
				equalDimensionGroups: [...groups.values()].filter(
					(group) => group.length > 1,
				),
			},
		},
		spacing: {
			maximumWithinRowRatio: proof.maximumWithinRowRatio,
			minimumAdjacentRatio: proof.minimumAdjacentRatio ?? null,
			maximumAdjacentRatio: proof.maximumAdjacentRatio ?? null,
			checkedSegments: proof.checkedSegments,
			firstRange,
			upperCheckedSegments: upperSegments,
		},
	};
}
