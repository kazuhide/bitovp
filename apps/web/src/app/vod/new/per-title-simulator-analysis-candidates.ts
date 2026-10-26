import {
	certifyComplexityIntervals,
	evaluateForcedRenditions,
	findCapReachingMaximumStep,
	type PerTitleGoal,
	type PerTitleProposal,
	perTitleDimensionAxis,
	resolvePerTitleAnalysis,
} from "@bitovp/core";
import { hasPerTitleEvaluationCountEvidence } from "./per-title-simulator-advice";
import {
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
	protectedPerTitleAdviceFields,
} from "./per-title-simulator-advice-fields";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
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
const LOW = "lowComplexityBoundaryForMaxBitrate";

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
	intent: "adaptive" | "cap" | "bandwidth" | "count" | "preserve",
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
	const reference = options.referenceGoal ?? goal;
	const ordinaryCap =
		(intent === "cap" || intent === "adaptive") &&
		proposal.api.streams.length > 0 &&
		proposal.api.streams.every(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		) &&
		(proposal.api.global.fixedResolutionAndBitrateConfiguration === undefined ||
			proposal.api.global.fixedResolutionAndBitrateConfiguration
				.forcedRenditionAboveHighestFixedRepresentation === 0);
	const hasRequiredSeedEvidence = (
		seed: PerTitleGoal,
		checked: PerTitleProposal,
	) =>
		seed.countPolicy.kind === "unrestricted"
			? checked.applicable &&
				checked.status === "candidate" &&
				!checked.diagnostics.some((item) => item.severity === "conflict")
			: hasPerTitleEvaluationCountEvidence(seed, checked);
	const preserveOrdinaryMinimum =
		ordinaryCap && hasRequiredSeedEvidence(goal, proposal);
	const addClosedSpacing = (seed: PerTitleGoal) => {
		const normalized = tunePerTitleSettings(seed, reference).proposal;
		if (
			seed.strategy !== "fixed-ranges" ||
			seed.countPolicy.kind === "unrestricted" ||
			seed.automaticTemplates?.length ||
			normalized.api.global.autoRepresentations !== undefined ||
			!seed.rows?.length ||
			!seed.rows.every((row) => row.bitrateSelectionMode === "COMPLEXITY_RANGE")
		)
			return;
		const basis = perTitleDimensionAxis(seed.rows);
		if (
			!basis ||
			new Set(seed.rows.map((row) => row[basis])).size !== seed.rows.length
		)
			return;
		const curves = [...seed.rows]
			.sort((a, b) => (a[basis] ?? 0) - (b[basis] ?? 0))
			.map((row) => ({
				minimum: row.minBitrate ?? 0,
				maximum: row.maxBitrate ?? 0,
				low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
				high: row.highComplexityBoundaryForMaxBitrate ?? 0,
			}));
		let step = normalized.api.global.minBitrateStepSize;
		const visited = new Set<number>();
		for (let attempt = 0; attempt < 12 && !visited.has(step); attempt++) {
			visited.add(step);
			const api = tunePerTitleSettings(
				set(seed, "minBitrateStepSize", step),
				reference,
			).proposal.api;
			const minimum = resolvePerTitleAnalysis(
				api,
				api.global.minBitrate,
			).complexityInput;
			const maximum = resolvePerTitleAnalysis(
				api,
				api.global.maxBitrate,
			).complexityInput;
			if (minimum === null || maximum === null) break;
			// Count certification also retains the full explicit analysis interval.
			const certificate = certifyComplexityIntervals(
				curves,
				{
					minimum: Math.min(api.global.minBitrate, minimum),
					maximum: Math.max(api.global.maxBitrate, maximum),
				},
				step,
			);
			if (!certificate) break;
			const lower = Math.max(1, certificate.maximumWithinRowRatio);
			const upper = certificate.minimumAdjacentRatio ?? Infinity;
			if (step > lower && step <= upper) {
				const maximumStep = Math.max(
					normalized.api.global.maxBitrateStepSize,
					step,
					up(certificate.maximumAdjacentRatio ?? step),
				);
				result.push(
					set(
						set(seed, "minBitrateStepSize", step),
						"maxBitrateStepSize",
						maximumStep,
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
	};
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
	// Prefer the current minimum when the ordinary count is checked or unrestricted.
	if (solver !== goal && !preserveOrdinaryMinimum) result.push(solver);
	if (ordinaryCap && (can("maxBitrateStepSize") || can("minBitrateStepSize"))) {
		const seeds = [preserveOrdinaryMinimum ? goal : solver];
		// An at-most count can be valid with only its first placement. If that
		// minimum step excludes every cap-ending chain, try the editable solver.
		if (
			preserveOrdinaryMinimum &&
			goal.countPolicy.kind !== "exact" &&
			solver !== goal &&
			can("minBitrateStepSize")
		)
			seeds.push(solver);
		if (
			goal.countPolicy.kind !== "exact" &&
			can("minBitrateStepSize") &&
			!can("maxBitrateStepSize")
		) {
			// A held maximum can make the ordinary solver preserve a one-slot
			// minimum. Borrow only a minimum seed from an independent spacing trial;
			// the actual candidate keeps the held maximum and is certified again.
			const independent = tunePerTitleSettings(
				setPerTitleAdjustment(
					solver,
					proposal,
					"global",
					"maxBitrateStepSize",
					{
						mode: "auto",
						method: "constraints",
					},
				),
				reference,
			);
			if (hasRequiredSeedEvidence(independent.goal, independent.proposal))
				seeds.push(
					set(
						goal,
						"minBitrateStepSize",
						independent.proposal.api.global.minBitrateStepSize,
					),
				);
		}
		for (const seed of seeds) {
			const checked = tunePerTitleSettings(seed, reference);
			if (hasRequiredSeedEvidence(checked.goal, checked.proposal)) {
				const global = checked.proposal.api.global;
				const limit =
					goal.countPolicy.kind === "unrestricted"
						? 256
						: goal.countPolicy.count;
				let maximum: number | null = null;
				const find = (count: number) =>
					findCapReachingMaximumStep({
						minimumBitrate: global.minBitrate,
						maximumBitrate: global.maxBitrate,
						minimumStep: global.minBitrateStepSize,
						count,
					});
				if (Number.isSafeInteger(limit) && limit >= 2 && limit <= 256) {
					if (goal.countPolicy.kind === "exact") maximum = find(limit);
					else {
						// With a freely chosen maximum step, feasible minimum-step chains
						// are prefix-closed. Prefer the longest one using a bounded search;
						// every accepted result still has an exact integer cap witness.
						let lower = 2,
							upper = limit;
						while (lower <= upper) {
							const middle = Math.ceil((lower + upper) / 2);
							const step = find(middle);
							if (step === null) upper = middle - 1;
							else {
								maximum = step;
								lower = middle + 1;
							}
						}
					}
				}
				if (
					maximum !== null &&
					(can("maxBitrateStepSize") || maximum <= global.maxBitrateStepSize) &&
					(can("minBitrateStepSize") ||
						global.minBitrateStepSize ===
							proposal.api.global.minBitrateStepSize)
				) {
					let capped = goal;
					if (
						global.minBitrateStepSize !== proposal.api.global.minBitrateStepSize
					)
						capped = set(
							capped,
							"minBitrateStepSize",
							global.minBitrateStepSize,
						);
					result.push(
						set(
							capped,
							"maxBitrateStepSize",
							Math.max(maximum, global.maxBitrateStepSize),
						),
					);
					break;
				}
			}
		}
	}
	addClosedSpacing(goal);
	// Recalibration is explicit and remains subject to the same count proof.
	if (
		(intent === "count" || intent === "preserve") &&
		goal.rows?.every(
			(row) =>
				typeof row.lowComplexityBoundaryForMaxBitrate === "number" &&
				row.lowComplexityBoundaryForMaxBitrate < goal.maxBitrate,
		)
	)
		addClosedSpacing(
			goal.rows.reduce(
				(next, row) => set(next, HIGH, goal.maxBitrate, row.id),
				goal,
			),
		);
	if (intent === "bandwidth" || !reach.topFixed) return result;
	const top = goal.rows?.find((row) => row.id === reach.topFixed?.rowId);
	if (!top) return result;
	const cap = proposal.api.global.maxBitrate;
	const steps = proposal.api.global;
	const highBase = reach.topFixed;
	const high = top.highComplexityBoundaryForMaxBitrate;
	const low = top.lowComplexityBoundaryForMaxBitrate;
	const seeds = [goal];
	// A media-selected band cannot establish distinct low/high responses. Offer
	// an explicit selection-policy alternative; every changed field remains in
	// the reviewed adoption diff and its intervals are certified by the caller.
	const minimumAnalysis = resolvePerTitleAnalysis(
		proposal.api,
		proposal.api.global.minBitrate,
	).complexityInput;
	if (
		top.bitrateSelectionMode !== "COMPLEXITY_RANGE" &&
		can("bitrateSelectionMode", top.id) &&
		minimumAnalysis !== null &&
		minimumAnalysis < cap
	) {
		const boundary = Math.max(
			minimumAnalysis,
			Math.min(top.maxBitrate ?? minimumAnalysis, cap - 1),
		);
		seeds.push(
			set(
				set(
					set(goal, "bitrateSelectionMode", "COMPLEXITY_RANGE", top.id),
					LOW,
					boundary,
					top.id,
				),
				HIGH,
				cap,
				top.id,
			),
		);
	}
	if (
		goal.strategy === "fixed-ranges" &&
		goal.countPolicy.kind !== "unrestricted" &&
		!goal.automaticTemplates?.length &&
		proposal.api.global.autoRepresentations === undefined &&
		minimumAnalysis !== null &&
		minimumAnalysis < cap
	) {
		// A closed count proof needs explicit curves for every required row,
		// rather than only the highest. Retain existing curves and bitrate bands.
		let calibrated = goal;
		for (const row of goal.rows ?? []) {
			if (
				row.bitrateSelectionMode === "COMPLEXITY_RANGE" ||
				!can("bitrateSelectionMode", row.id)
			)
				continue;
			const boundary = Math.max(
				minimumAnalysis,
				Math.min(row.maxBitrate ?? minimumAnalysis, cap - 1),
			);
			calibrated = set(
				set(
					set(calibrated, "bitrateSelectionMode", "COMPLEXITY_RANGE", row.id),
					LOW,
					boundary,
					row.id,
				),
				HIGH,
				cap,
				row.id,
			);
		}
		if (calibrated !== goal) seeds.push(calibrated);
	}
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
	if (intent !== "cap" && intent !== "adaptive") {
		// A selection-policy change can repair a count without pursuing the cap.
		// Keep bounds and roles; the caller certifies the emitted API and count.
		for (const seed of seeds.slice(1)) {
			result.push(seed);
			addClosedSpacing(seed);
		}
		return result;
	}
	for (const seed of seeds) {
		const resolved = tunePerTitleSettings(seed, reference);
		const normalized = resolved.proposal;
		if (can("maxBitrateStepSize")) {
			const ladder = assessPerTitleLadder(resolved.goal, normalized);
			if (ladder.intervals) {
				const maximum = Math.max(
					normalized.api.global.maxBitrateStepSize,
					ladder.intervals.maximumAdjacentRatio ?? 0,
					ladder.lowerConnection?.maximumRatio ?? 0,
				);
				if (
					Number.isFinite(maximum) &&
					maximum > normalized.api.global.maxBitrateStepSize
				)
					result.push(set(seed, "maxBitrateStepSize", up(maximum)));
			}
		}
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
			addClosedSpacing(raised);
		}
	}
	return result.slice(0, 24);
}
