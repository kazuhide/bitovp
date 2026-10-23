import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
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
	getPerTitleGoalSetting,
	getPerTitleSetting,
	type PerTitleSettingValue,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const FACTOR =
	"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor";
const LOW = "lowComplexityBoundaryForMaxBitrate";
const HIGH = "highComplexityBoundaryForMaxBitrate";
const above = (value: number) => {
	const tick = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 2);
	return Math.ceil((value + 1) / tick) * tick;
};

/**
 * One bounded family for an explicitly declared mixed count. With first band
 * [m,u], start G, cap M and N fixed rows, one lower placement suggests
 * sqrt(u/G) < s <= m/G. Forward projection suggests s <= (M/u)^(1/(N-1));
 * s > (M/m)^(1/N) can postpone the top q activation past M. These only guide
 * search: every rounded result must pass the unchanged interval and reach proofs.
 * Ordinary selection and native output count remain media dependent.
 */
export function perTitleCountDirectedCandidates(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	options: PerTitleAdviceOptions = {},
): PerTitleGoal[] {
	if (
		assessPerTitleCountStructure(goal, proposal).status !==
		"declared-compatible"
	)
		return [];
	const fixed = proposal.api.streams.filter(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	const basis = fixed.every((row) => row.width === undefined)
		? "height"
		: "width";
	const ordered = [...fixed].sort(
		(a, b) =>
			(a[basis] ?? 0) - (b[basis] ?? 0) ||
			(a.perTitleSettings?.minBitrate ?? 0) -
				(b.perTitleSettings?.minBitrate ?? 0),
	);
	const curves = ordered.map(perTitleAnalysisCurve);
	const first = curves[0];
	if (ordered.length < 2 || !first || curves.some((curve) => curve === null))
		return [];
	const global = proposal.api.global;
	const cap = global.maxBitrate;
	const lower = Math.max(
		1,
		Math.sqrt(first.maximum / global.minBitrate),
		(cap / first.minimum) ** (1 / ordered.length),
	);
	const upper = Math.min(
		first.minimum / global.minBitrate,
		(cap / first.maximum) ** (1 / (ordered.length - 1)),
		global.maxBitrateStepSize,
	);
	if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper)
		return [];
	const strictLower = lower + Number.EPSILON * Math.max(1, lower);
	const steps = [
		...new Set([
			global.minBitrateStepSize,
			Math.ceil(strictLower * 10) / 10,
			Math.ceil(strictLower * 100) / 100,
			Math.sqrt(strictLower * upper),
		]),
	].filter((value) => value > lower && value <= upper);
	const protectedFields = protectedPerTitleAdviceFields(goal, options);
	const held = new Set(protectedFields.map(perTitleAdviceFieldKey));
	const result: PerTitleGoal[] = [];
	const seen = new Set<string>();
	for (const step of steps) {
		let draft: PerTitleGoal | null = goal;
		const set = (key: string, value: PerTitleSettingValue, rowId?: string) => {
			if (!draft) return;
			const scope = rowId === undefined ? "global" : "stream";
			const field = { scope, key, rowId } as const;
			if (held.has(perTitleAdviceFieldKey(field))) {
				if (!Object.is(getPerTitleSetting(proposal, scope, key, rowId), value))
					draft = null;
				return;
			}
			draft = setPerTitleSetting(draft, scope, key, value, rowId);
		};
		const bands = curves.map((curve) => ({
			minimum: curve?.minimum ?? 0,
			maximum: curve?.maximum ?? 0,
		}));
		for (let index = 1; index < bands.length; index++) {
			const previous = bands[index - 1];
			const current = bands[index];
			if (!previous || !current) continue;
			current.minimum = Math.max(
				current.minimum,
				above(previous.minimum * step),
			);
			current.maximum = Math.max(
				current.maximum,
				above(previous.maximum * step),
			);
		}
		const top = bands.at(-1);
		if (
			!top ||
			bands.some(
				(band) =>
					!Number.isSafeInteger(band.minimum) ||
					!Number.isSafeInteger(band.maximum) ||
					band.minimum > band.maximum ||
					band.maximum >= cap,
			)
		)
			continue;
		const factor = cap / top.maximum;
		const low = Math.round(top.minimum * factor);
		if (low <= 0 || low >= cap || Math.round(top.maximum * factor) !== cap)
			continue;
		set("minBitrateStepSize", step);
		set(FACTOR, factor);
		for (const [index, row] of ordered.entries()) {
			const band = bands[index];
			if (!band) continue;
			if (index > 0) {
				set("minBitrate", band.minimum, row.rowId);
				set("maxBitrate", band.maximum, row.rowId);
			}
			set(LOW, low, row.rowId);
			set(HIGH, cap, row.rowId);
		}
		if (!draft) continue;
		const candidate: PerTitleGoal = draft;
		const checked = tunePerTitleSettings(
			candidate,
			options.referenceGoal ?? goal,
		).proposal;
		if (
			checked.status === "conflict" ||
			checked.diagnostics.some((item) => item.severity === "conflict") ||
			protectedFields.some(
				(field) =>
					!Object.is(
						getPerTitleGoalSetting(goal, field.scope, field.key, field.rowId),
						getPerTitleGoalSetting(
							candidate,
							field.scope,
							field.key,
							field.rowId,
						),
					),
			) ||
			assessPerTitleCountStructure(candidate, checked).status !==
				"declared-compatible"
		)
			continue;
		const ladder = assessPerTitleLadder(candidate, checked);
		const interval = ladder.intervals;
		const reach = assessPerTitleReach(candidate, checked);
		if (
			!interval ||
			interval.maximumWithinRowRatio >= step ||
			(interval.minimumAdjacentRatio ?? Infinity) < step ||
			(interval.maximumAdjacentRatio ?? 0) > global.maxBitrateStepSize ||
			ladder.lowerSlots?.minimum !== 1 ||
			ladder.lowerSlots.maximum !== 1 ||
			ladder.upperSlots?.maximum !== 0 ||
			reach.status !== "conditional-reachable" ||
			reach.certainty !== "all-permitted-rates" ||
			reach.adaptation !== "conditional" ||
			reach.high?.minimum !== cap ||
			reach.high.maximum !== cap
		)
			continue;
		const key = JSON.stringify(checked.api);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(candidate);
	}
	return result;
}
