import {
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleProposal,
	perTitleDimensionAxis,
} from "@bitovp/core";
import {
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
	protectedPerTitleAdviceFields,
} from "./per-title-simulator-advice-fields";
import { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import {
	assessPerTitleLadder,
	perTitleAnalysisCurve,
} from "./per-title-simulator-analysis-ladder";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";
import {
	getPerTitleSetting,
	type PerTitleSettingValue,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

const MAX_STEPS = 12;
const MAX_LAYOUTS = MAX_STEPS * 4;
const rounded = (value: number, upwards: boolean) => {
	const tick = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 2);
	return (upwards ? Math.ceil(value / tick) : Math.floor(value / tick)) * tick;
};

function capInverse(cap: number, factor: number): number | null {
	const estimate = Math.floor(cap / factor);
	for (const rate of [estimate, estimate + 1, estimate - 1, estimate + 2]) {
		if (
			evaluateForcedRenditions({
				base: { minimum: rate, maximum: rate },
				count: 1,
				factor,
			})?.at(-1)?.maximum === cap
		)
			return rate;
	}
	return null;
}

type Band = { minimum: number; maximum: number };
type HeldBand = { minimum: boolean; maximum: boolean };

function nearestRate(
	preferred: number,
	lower: number,
	upper: number,
	held: boolean,
): number | null {
	if (
		![preferred, lower, upper].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		lower > upper
	)
		return null;
	if (held) return preferred >= lower && preferred <= upper ? preferred : null;
	const value = Math.min(upper, Math.max(lower, preferred));
	if (value === preferred) return value;
	const readable = rounded(value, value > preferred);
	return readable >= lower && readable <= upper ? readable : value;
}

function retainedBands({
	curves,
	held,
	minimum,
	cap,
	topMaximum,
	step,
	strictTarget,
}: {
	curves: readonly Band[];
	held: readonly HeldBand[];
	minimum: number;
	cap: number;
	topMaximum: number;
	step: number;
	strictTarget?: number;
}): Band[] | null {
	const first = curves[0];
	const top = curves.at(-1);
	if (!first || !top) return null;
	const budgetTop = strictTarget ?? topMaximum;
	const firstBudget = Math.min(
		Math.ceil(minimum * step * step) - 1,
		Math.floor(budgetTop / step ** (curves.length - 1)) - 1,
	);
	const firstUpper = nearestRate(
		first.maximum,
		first.minimum,
		firstBudget,
		held[0]?.maximum ?? false,
	);
	if (firstUpper === null) return null;
	const bands: Band[] = [{ minimum: first.minimum, maximum: firstUpper }];
	for (let index = 1; index < curves.length - 1; index++) {
		const curve = curves[index];
		const previous = bands.at(-1);
		if (!curve || !previous) return null;
		const minimumFloor =
			strictTarget === undefined
				? Math.ceil(previous.minimum * step) + 1
				: Math.max(curve.minimum, rounded(previous.maximum * step + 1, true));
		const nextMinimum = nearestRate(
			curve.minimum,
			minimumFloor,
			topMaximum,
			held[index]?.minimum ?? false,
		);
		if (nextMinimum === null) return null;
		const maximumFloor =
			strictTarget === undefined
				? Math.max(nextMinimum, Math.ceil(previous.maximum * step) + 1)
				: nextMinimum;
		const budget =
			Math.floor(budgetTop / step ** (curves.length - 1 - index)) - 1;
		const nextMaximum = nearestRate(
			curve.maximum,
			maximumFloor,
			strictTarget === undefined ? budget : rounded(budget, false),
			held[index]?.maximum ?? false,
		);
		if (nextMaximum === null) return null;
		bands.push({ minimum: nextMinimum, maximum: nextMaximum });
	}
	const previous = bands.at(-1);
	if (!previous) return null;
	const topFloor =
		strictTarget === undefined
			? Math.max(
					Math.ceil(previous.minimum * step) + 1,
					Math.round(cap / step) + 1,
				)
			: Math.max(strictTarget, rounded(previous.maximum * step + 1, true));
	const topMinimum = nearestRate(
		top.minimum,
		topFloor,
		topMaximum - 1,
		held.at(-1)?.minimum ?? false,
	);
	if (topMinimum === null) return null;
	bands.push({ minimum: topMinimum, maximum: topMaximum });
	return bands;
}

/**
 * Retain one forced step while repairing the fixed bands on both sides.
 * First-upper < G*s^2 excludes a second lower placement. Reverse budgets from
 * the rounded cap inverse leave room for forward minima between fixed bands.
 * These bounds guide a small search; the emitted API and full domain certify it.
 */
export function perTitleRetainedFactorCandidates(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	options: PerTitleAdviceOptions = {},
): PerTitleGoal[] {
	const reference = options.referenceGoal ?? goal;
	const resolved = tunePerTitleSettings(goal, reference).goal;
	if (
		assessPerTitleCountStructure(resolved, proposal).status !==
		"declared-compatible"
	)
		return [];
	const global = proposal.api.global;
	const fixed = proposal.api.streams.filter(
		(row) => row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	const basis = perTitleDimensionAxis(proposal.api.streams);
	if (!basis) return [];
	const ordered = [...fixed].sort(
		(a, b) =>
			(a[basis] ?? 0) - (b[basis] ?? 0) ||
			(a.perTitleSettings?.minBitrate ?? 0) -
				(b.perTitleSettings?.minBitrate ?? 0),
	);
	const curves = ordered.map(perTitleAnalysisCurve);
	const first = curves[0];
	const top = curves.at(-1);
	const preceding = curves.at(-2);
	const factor =
		global.fixedResolutionAndBitrateConfiguration
			?.forcedRenditionAboveHighestFixedRepresentationFactor;
	if (
		ordered.length < 2 ||
		!first ||
		!top ||
		!preceding ||
		curves.some((curve) => curve === null) ||
		typeof factor !== "number" ||
		factor <= 1
	)
		return [];
	const cap = global.maxBitrate;
	const topMaximum = capInverse(cap, factor);
	if (topMaximum === null) return [];
	const lower = Math.max(
		1,
		factor,
		Math.sqrt(first.minimum / global.minBitrate),
	);
	const upper = Math.min(
		first.minimum / global.minBitrate,
		(topMaximum / first.minimum) ** (1 / (ordered.length - 1)),
		global.maxBitrateStepSize,
	);
	if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper)
		return [];
	// Changes in the active lower bound occur at these intersections, rather
	// than at a content-quality estimate or a preset-specific spacing value.
	const breakpoints = [
		global.minBitrateStepSize,
		Math.sqrt(cap / preceding.minimum),
		Math.sqrt(first.maximum / global.minBitrate),
		Math.sqrt(lower * upper),
		lower,
		upper,
	];
	const steps = [
		...new Set(
			breakpoints.flatMap((value) => [
				value,
				Math.floor(value * 10) / 10,
				Math.ceil(value * 10) / 10,
				Math.floor(value * 100) / 100,
				Math.ceil(value * 100) / 100,
			]),
		),
	]
		.filter((value) => value > lower && value < upper)
		.slice(0, MAX_STEPS);
	const held = new Set(
		protectedPerTitleAdviceFields(goal, options).map(perTitleAdviceFieldKey),
	);
	const isHeld = (key: string, rowId?: string) =>
		held.has(
			perTitleAdviceFieldKey({
				scope: rowId === undefined ? "global" : "stream",
				key,
				rowId,
			}),
		);
	const seen = new Set<string>();
	const result: PerTitleGoal[] = [];
	const saved = curves.filter((curve) => curve !== null);
	const heldBands = ordered.map(({ rowId }) => ({
		minimum: isHeld("minBitrate", rowId),
		maximum: isHeld("maxBitrate", rowId),
	}));
	let attempts = 0;
	for (const step of steps) {
		if (isHeld("minBitrateStepSize") && step !== global.minBitrateStepSize)
			continue;
		let minimumTop = first.minimum;
		for (let index = 1; index < curves.length; index++)
			minimumTop = Math.max(
				curves[index]?.minimum ?? Infinity,
				Math.ceil(minimumTop * step) + 1,
			);
		// Above round(U/s), q cannot clip this highest fixed curve. This is a
		// forced-only family; the normal and forced branches remain alternatives.
		const requiredTop = Math.max(minimumTop, Math.round(cap / step) + 1);
		const targets = [
			...new Set([
				rounded(requiredTop, true),
				rounded(
					Math.max(requiredTop, (topMaximum * top.minimum) / top.maximum),
					true,
				),
				rounded((requiredTop + topMaximum) / 2, true),
			]),
		].filter((value) => value < topMaximum);
		const layout = (strictTarget?: number) =>
			retainedBands({
				curves: saved,
				held: heldBands,
				minimum: global.minBitrate,
				cap,
				topMaximum,
				step,
				strictTarget,
			});
		// The second recipe separates matching low/high endpoints rather than
		// every pair of rates. The same whole-domain certificate checks both.
		for (const bands of [...targets.map(layout), layout()]) {
			if (attempts++ >= MAX_LAYOUTS) return result;
			if (!bands) continue;
			const topMinimum = bands.at(-1)?.minimum ?? Infinity;
			const low = Math.round(topMinimum * factor);
			if (topMinimum >= topMaximum || low >= cap) continue;
			let draft: PerTitleGoal | null = goal;
			const set = (
				key: string,
				value: PerTitleSettingValue,
				rowId?: string,
			) => {
				if (!draft) return;
				const scope = rowId === undefined ? "global" : "stream";
				if (isHeld(key, rowId)) {
					if (
						!Object.is(getPerTitleSetting(proposal, scope, key, rowId), value)
					)
						draft = null;
				} else draft = setPerTitleSetting(draft, scope, key, value, rowId);
			};
			set("minBitrateStepSize", step);
			for (const [index, row] of ordered.entries()) {
				set("minBitrate", bands[index]?.minimum, row.rowId);
				set("maxBitrate", bands[index]?.maximum, row.rowId);
				set("lowComplexityBoundaryForMaxBitrate", low, row.rowId);
				set("highComplexityBoundaryForMaxBitrate", cap, row.rowId);
			}
			if (!draft) continue;
			const candidate: PerTitleGoal = draft;
			const checked = tunePerTitleSettings(candidate, reference);
			const api = checked.proposal.api;
			const ladder = assessPerTitleLadder(checked.goal, checked.proposal);
			const reach = assessPerTitleReach(checked.goal, checked.proposal);
			const intervals = ladder.intervals;
			if (
				checked.proposal.status === "conflict" ||
				checked.proposal.diagnostics.some(
					(item) => item.severity === "conflict",
				) ||
				assessPerTitleCountStructure(checked.goal, checked.proposal).status !==
					"declared-compatible" ||
				api.global.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationFactor !== factor ||
				!intervals ||
				intervals.maximumWithinRowRatio >= api.global.minBitrateStepSize ||
				(intervals.minimumAdjacentRatio ?? Infinity) <
					api.global.minBitrateStepSize ||
				(intervals.maximumAdjacentRatio ?? 0) > api.global.maxBitrateStepSize ||
				ladder.lowerSlots?.minimum !== 1 ||
				ladder.lowerSlots.maximum !== 1 ||
				ladder.upperSlots?.maximum !== 0 ||
				reach.status !== "conditional-reachable" ||
				reach.certainty !== "all-permitted-rates" ||
				reach.adaptation !== "conditional" ||
				assessPerTitleUpperLimit(checked.goal, checked.proposal).status !==
					"satisfied"
			)
				continue;
			const key = JSON.stringify(api);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(candidate);
		}
	}
	return result;
}
