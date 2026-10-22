import {
	certifyComplexityIntervals,
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleProposal,
} from "@bitovp/core";
import {
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
	protectedPerTitleAdviceFields,
} from "./per-title-simulator-advice-fields";
import type { PerTitleReachAssessment } from "./per-title-simulator-analysis-reach";
import {
	type PerTitleSettingValue,
	setPerTitleAdjustment,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const RULE = "fixedResolutionAndBitrateConfiguration.";
const COUNT = `${RULE}forcedRenditionAboveHighestFixedRepresentation`;
const FACTOR = `${COUNT}Factor`;
const MODE = `${COUNT}CalculationMode`;
const HIGH = "highComplexityBoundaryForMaxBitrate";

/** Directed decimal rounding never tightens a derived feasibility boundary. */
const down = (value: number) => Math.floor(value * 10_000) / 10_000;
const up = (value: number) => Math.ceil(value * 10_000) / 10_000;

/**
 * Find factors using the same integer recurrence as the constraint model.
 * The power estimate only brackets the monotone search; it is not the result.
 */
function capFactors(base: number, count: number, cap: number): number[] {
	if (
		!Number.isSafeInteger(base) ||
		base < 1 ||
		base >= cap ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 256
	)
		return [];
	const end = (factor: number) =>
		evaluateForcedRenditions({
			base: { minimum: base, maximum: base },
			count,
			factor,
		})?.at(-1)?.maximum ?? Infinity;
	let low = 1;
	let high = Math.max(2, (cap / base) ** (1 / count) * 2);
	for (let i = 0; i < 64; i++) {
		const middle = (low + high) / 2;
		if (end(middle) <= cap) low = middle;
		else high = middle;
	}
	const candidates = [2, 3, 4, 6, 8, 10].map(
		(digits) => Math.floor(low * 10 ** digits) / 10 ** digits,
	);
	candidates.push(low);
	return [...new Set(candidates)]
		.filter((factor) => factor > 1 && end(factor) === cap)
		.slice(0, 1);
}

/** Bounded, requirement-preserving candidates; each still needs independent certification. */
export function perTitleAnalysisCandidates(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	reach: PerTitleReachAssessment,
	intent: "cap" | "bandwidth" | "count",
	options: PerTitleAdviceOptions,
): PerTitleGoal[] {
	const held = new Set(
		protectedPerTitleAdviceFields(goal, options).map(perTitleAdviceFieldKey),
	);
	const can = (key: string, rowId?: string) =>
		!held.has(
			perTitleAdviceFieldKey({
				scope: rowId === undefined ? "global" : "stream",
				key,
				rowId,
			}),
		);
	const set = (
		draft: PerTitleGoal,
		key: string,
		value: PerTitleSettingValue,
		rowId?: string,
	) =>
		can(key, rowId)
			? setPerTitleSetting(
					draft,
					rowId === undefined ? "global" : "stream",
					key,
					value,
					rowId,
				)
			: draft;
	const result: PerTitleGoal[] = [];
	// Spacing follows the existing exact-count / interval solver, with all other
	// fields locked. Its emitted values are later materialized as fixed settings.
	let solver = goal;
	const solverKeys = ["minBitrateStepSize", "maxBitrateStepSize"];
	if (
		goal.strategy === "fixed-ranges" &&
		!goal.automaticTemplates?.length &&
		goal.countPolicy.kind === "exact" &&
		goal.countPolicy.count > (goal.rows?.length ?? 0) &&
		goal.fixedResolutionAndBitrateConfiguration === undefined
	)
		solverKeys.push(COUNT, FACTOR, MODE);
	for (const key of solverKeys) {
		if (can(key))
			solver = setPerTitleAdjustment(solver, proposal, "global", key, {
				mode: "auto",
				method: "constraints",
			});
	}
	if (solver !== goal) result.push(solver);
	if (
		goal.strategy === "fixed-ranges" &&
		goal.countPolicy.kind !== "unrestricted" &&
		!goal.automaticTemplates?.length &&
		proposal.api.global.autoRepresentations === undefined &&
		goal.rows?.length &&
		goal.rows.every((row) => row.bitrateSelectionMode === "COMPLEXITY_RANGE")
	) {
		const basis = goal.rows.every((row) => row.width === undefined)
			? "height"
			: goal.rows.every((row) => row.width !== undefined)
				? "width"
				: null;
		if (
			basis &&
			new Set(goal.rows.map((row) => row[basis])).size === goal.rows.length
		) {
			const seeds = [goal];
			// Recalibration is an explicit count-focused alternative, not a claim of
			// equal quality or an automatic change to a custom / maintained boundary.
			if (
				intent === "count" &&
				goal.rows.every(
					(row) =>
						typeof row.lowComplexityBoundaryForMaxBitrate === "number" &&
						row.lowComplexityBoundaryForMaxBitrate < goal.maxBitrate,
				)
			) {
				seeds.push(
					goal.rows.reduce(
						(next, row) => set(next, HIGH, goal.maxBitrate, row.id),
						goal,
					),
				);
			}
			for (const seed of seeds) {
				const rows = [...(seed.rows ?? [])].sort(
					(a, b) => (a[basis] ?? 0) - (b[basis] ?? 0),
				);
				const curves = rows.map((row) => ({
					minimum: row.minBitrate ?? 0,
					maximum: row.maxBitrate ?? 0,
					low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
					high: row.highComplexityBoundaryForMaxBitrate ?? 0,
				}));
				let step = proposal.api.global.minBitrateStepSize;
				const visited = new Set<number>();
				for (let attempt = 0; attempt < 12 && !visited.has(step); attempt++) {
					visited.add(step);
					const certificate = certifyComplexityIntervals(
						curves,
						{ minimum: goal.minBitrate, maximum: goal.maxBitrate },
						step,
					);
					if (!certificate) break;
					const lower = Math.max(1, certificate.maximumWithinRowRatio);
					const upper = certificate.minimumAdjacentRatio ?? Infinity;
					if (step > lower && step <= upper) {
						const maximum = Math.max(
							proposal.api.global.maxBitrateStepSize,
							step,
							up(certificate.maximumAdjacentRatio ?? step),
						);
						result.push(
							set(
								set(seed, "minBitrateStepSize", step),
								"maxBitrateStepSize",
								maximum,
							),
						);
						break;
					}
					if (!can("minBitrateStepSize") || lower >= upper) break;
					const strictLower =
						lower + Math.max(Number.MIN_VALUE, Number.EPSILON * lower);
					const next = Number.isFinite(upper)
						? Math.sqrt(strictLower * upper)
						: strictLower;
					const readable = up(next);
					step = readable <= upper && readable > lower ? readable : next;
				}
			}
		}
	}
	if (intent !== "cap" || !reach.topFixed) return result;
	const top = goal.rows?.find((row) => row.id === reach.topFixed?.rowId);
	if (!top) return result;
	const cap = proposal.api.global.maxBitrate;
	const steps = proposal.api.global;
	const highBase = reach.topFixed;
	const high = top.highComplexityBoundaryForMaxBitrate;
	const low = top.lowComplexityBoundaryForMaxBitrate;
	const seeds = [goal];
	// If an explicit high boundary lies beyond the selected analysis hypothesis,
	// saturation at that hypothesis is an alternative, never an assumed default.
	if (
		top.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
		typeof high === "number" &&
		high > cap &&
		typeof low === "number" &&
		low < cap &&
		can(HIGH, top.id)
	)
		seeds.push(set(goal, HIGH, cap, top.id));
	for (const seed of seeds) {
		const normalized = tunePerTitleSettings(seed, seed).proposal;
		const settings = normalized.api.streams.find(
			(stream) => stream.rowId === top.id,
		)?.perTitleSettings;
		const upper = seed === goal ? highBase.maximum : settings?.maxBitrate;
		const lower = seed === goal ? highBase.minimum : settings?.maxBitrate;
		if (
			typeof upper !== "number" ||
			typeof lower !== "number" ||
			upper <= 0 ||
			lower <= 0
		)
			continue;
		if (seed !== goal) result.push(seed);
		// A direct top at M is legal for every allowed high-input b only if
		// minStep <= M/U and maxStep >= M/L. Round outwards, then certify.
		const minimumStep = Math.min(steps.minBitrateStepSize, down(cap / upper));
		const maximumStep = Math.max(steps.maxBitrateStepSize, up(cap / lower));
		if (minimumStep > 1 && Number.isFinite(maximumStep)) {
			result.push(
				set(
					set(seed, "minBitrateStepSize", minimumStep),
					"maxBitrateStepSize",
					maximumStep,
				),
			);
		}
		const rule = normalized.api.global.fixedResolutionAndBitrateConfiguration;
		const count = rule?.forcedRenditionAboveHighestFixedRepresentation;
		if (count && can(FACTOR)) {
			const last = set(seed, MODE, "LAST_CALCULATED_BITRATE");
			if (
				last.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
				"LAST_CALCULATED_BITRATE"
			) {
				for (const factor of capFactors(upper, count, cap))
					result.push(set(last, FACTOR, factor));
			}
		}
		// Closed fixed ladders can use their existing top row rather than add a
		// rendition. Never shrink a configured bitrate range to make a gap fit.
		if (
			!goal.automaticTemplates?.length &&
			!normalized.api.global.autoRepresentations &&
			!rule?.forcedRenditionAboveHighestFixedRepresentation &&
			can("maxBitrate", top.id) &&
			(top.maxBitrate ?? cap) < cap
		) {
			let raised = set(seed, "maxBitrate", cap, top.id);
			if (typeof high === "number" && high > cap)
				raised = set(raised, HIGH, cap, top.id);
			result.push(raised);
		}
	}
	return result.slice(0, 24);
}
