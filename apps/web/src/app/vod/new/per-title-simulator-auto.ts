import {
	type PerTitleGoal,
	type PerTitleGoalRow,
	perTitleDimensionAxis,
	resolvePerTitleFixedMode,
} from "@bitovp/core";

export type PerTitleManualBounds = Record<
	string,
	{ min?: boolean; max?: boolean }
>;

const MAX_BITRATE = 2_147_483_647;
const validRate = (value: number | undefined): value is number =>
	value !== undefined &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= MAX_BITRATE;
const validGlobal = (goal: PerTitleGoal) =>
	validRate(goal.minBitrate) &&
	validRate(goal.maxBitrate) &&
	goal.minBitrate <= goal.maxBitrate;

/** Keep the slider domain anchored while allowing four times the loaded limit. */
export function bitrateSliderBounds(anchor: PerTitleGoal) {
	const min = validRate(anchor.minBitrate) ? anchor.minBitrate : 100_000;
	const loadedMaximum = validRate(anchor.maxBitrate)
		? Math.max(min, anchor.maxBitrate)
		: Math.max(min, 8_000_000);
	const max = Math.min(MAX_BITRATE, loadedMaximum * 4);
	const step = Math.max(
		1,
		10 ** Math.floor(Math.log10(Math.max(1, max - min)) - 3),
	);
	return { min, max, step };
}

function withoutRowTuning(row: PerTitleGoalRow): PerTitleGoalRow {
	const next = { ...row };
	delete next.bitrateSelectionMode;
	delete next.lowComplexityBoundaryForMaxBitrate;
	delete next.highComplexityBoundaryForMaxBitrate;
	return next;
}

/** Geometry of requested ranges only; this does not estimate content quality. */
export function autoTunePerTitleGoal(
	goal: PerTitleGoal,
	anchor: PerTitleGoal,
	manual: PerTitleManualBounds,
): PerTitleGoal {
	const next = { ...goal };
	delete next.minBitrateStepSize;
	delete next.maxBitrateStepSize;
	// Inactive row collections keep their parked data.
	if (
		goal.strategy === "automatic" ||
		goal.strategy === "count" ||
		!validGlobal(goal) ||
		!goal.rows?.length ||
		goal.rows.length > 64
	) {
		return next;
	}
	const rows = goal.rows;
	const axis = perTitleDimensionAxis(rows);
	if (axis === null) return next;
	const requested =
		goal.countPolicy.kind !== "unrestricted" &&
		Number.isSafeInteger(goal.countPolicy.count) &&
		goal.countPolicy.count > 0 &&
		goal.countPolicy.count <= 256
			? goal.countPolicy.count
			: rows.length;
	const slots = Math.max(rows.length, requested);
	const ordered = rows
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) => (a.row[axis] ?? 0) - (b.row[axis] ?? 0) || a.index - b.index,
		);
	const ranks = new Map(ordered.map(({ index }, rank) => [index, rank]));
	const logMinimum = Math.log(goal.minBitrate);
	const logSpan = Math.log(goal.maxBitrate) - logMinimum;
	const at = (fraction: number) =>
		Math.min(
			goal.maxBitrate,
			Math.max(
				goal.minBitrate,
				Math.round(Math.exp(logMinimum + fraction * logSpan)),
			),
		);
	const usableAnchor =
		anchor.codec === goal.codec && (anchor.rows?.length ?? 0) <= 64;
	const anchors = usableAnchor ? (anchor.rows ?? []) : [];
	const unchangedGlobal =
		goal.minBitrate === anchor.minBitrate &&
		goal.maxBitrate === anchor.maxBitrate;
	const validAnchorGlobal = validGlobal(anchor);
	const anchorSpan = validAnchorGlobal
		? Math.log(anchor.maxBitrate) - Math.log(anchor.minBitrate)
		: 0;

	next.rows = rows.map((row, index) => {
		if (
			resolvePerTitleFixedMode(goal, row) !==
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
		)
			return row;
		const matches = anchors.filter(
			(candidate) =>
				candidate.id === row.id &&
				candidate.height === row.height &&
				candidate.width === row.width &&
				resolvePerTitleFixedMode(anchor, candidate) ===
					"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		);
		const original = matches.length === 1 ? matches[0] : undefined;
		const originalMinimum = original?.minBitrate;
		const originalMaximum = original?.maxBitrate;
		const validOriginal =
			validAnchorGlobal &&
			validRate(originalMinimum) &&
			validRate(originalMaximum) &&
			originalMinimum <= originalMaximum &&
			originalMinimum >= anchor.minBitrate &&
			originalMaximum <= anchor.maxBitrate;
		const invalidExplicitOriginal =
			original !== undefined &&
			!validOriginal &&
			(originalMinimum !== undefined || originalMaximum !== undefined);
		// Equal logarithmic bands alternate with equally wide gaps. Extra requested
		// slots stay above the required rows. Integer rounding can collapse tiny
		// intervals; the solver must still diagnose feasibility and actual count.
		const rank = ranks.get(index) ?? index;
		const cells = 2 * slots - 1;
		let minimum: number | undefined = at((2 * rank) / cells);
		let maximum: number | undefined = at((2 * rank + 1) / cells);
		if (validOriginal) {
			if (unchangedGlobal) {
				minimum = originalMinimum;
				maximum = originalMaximum;
			} else if (anchorSpan > 0) {
				const position = (value: number) =>
					(Math.log(value) - Math.log(anchor.minBitrate)) / anchorSpan;
				minimum = at(position(originalMinimum));
				maximum = at(position(originalMaximum));
			}
		} else if (invalidExplicitOriginal) {
			// Explicit loaded constraints must reach validation unchanged; an invalid
			// interval is not a missing band to replace with an automatic suggestion.
			minimum = originalMinimum;
			maximum = originalMaximum;
		}
		const pinned = manual[row.id];
		const pinMinimum = pinned?.min === true;
		const pinMaximum = pinned?.max === true;
		const inGlobal = (value: number | undefined): value is number =>
			validRate(value) && value >= goal.minBitrate && value <= goal.maxBitrate;
		if (
			!invalidExplicitOriginal &&
			pinMinimum &&
			!pinMaximum &&
			inGlobal(row.minBitrate) &&
			maximum !== undefined
		) {
			maximum = Math.max(maximum, row.minBitrate);
		}
		if (
			!invalidExplicitOriginal &&
			pinMaximum &&
			!pinMinimum &&
			inGlobal(row.maxBitrate) &&
			minimum !== undefined
		) {
			minimum = Math.min(minimum, row.maxBitrate);
		}
		return {
			...withoutRowTuning(row),
			minBitrate: pinMinimum ? row.minBitrate : minimum,
			maxBitrate: pinMaximum ? row.maxBitrate : maximum,
		};
	});
	return next;
}
