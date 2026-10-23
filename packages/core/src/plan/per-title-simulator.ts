import { constrainPerTitleApiCandidate } from "./per-title-candidate-api";
import {
	applyPerTitleSettingLocks,
	optimizePerTitleConstraints,
	type PerTitleConstraintAnalysis,
	perTitleGlobalLocked,
	perTitleStreamLocked,
	validPerTitleSettingLocks,
} from "./per-title-optimizer";
import type { EncodingPlan } from "./schema.js";

export type PerTitleStrategy =
	| "automatic"
	| "count"
	| "required-resolutions"
	| "fixed-resolutions"
	| "fixed-ranges";

export type PerTitleCodec = "H264" | "H265" | "H265V2" | "VP9" | "AV1";

export type PerTitleCountPolicy =
	| { kind: "unrestricted" }
	| { kind: "exact" | "maximum"; count: number };

export type PerTitleSettingLocks = {
	global?: readonly string[];
	streams?: Record<string, readonly string[]>;
};
export type PerTitleAdjustmentMethod =
	| "constraints"
	| "proportional"
	| "logarithmic"
	| "default";
export type PerTitleAdjustment =
	| { mode: "fixed" }
	| { mode: "auto"; method: PerTitleAdjustmentMethod };
export type PerTitleAdjustments = {
	global?: Record<string, PerTitleAdjustment>;
	streams?: Record<string, Record<string, PerTitleAdjustment>>;
	inactiveAutoRepresentationThreshold?: number;
};

type PerTitleOptionalSettings = {
	targetQualityCrf?: number;
	targetQualityQp?: number;
	complexityFactor?: number;
	resolutionScaleFactor?: number;
	codecMinBitrateFactor?: number;
	codecMaxBitrateFactor?: number;
	codecBufsizeFactor?: number;
};
const optionalSettingKeys = [
	"targetQualityCrf",
	"targetQualityQp",
	"complexityFactor",
	"resolutionScaleFactor",
	"codecMinBitrateFactor",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
] as const;
const optionalSettings = (goal: PerTitleGoal) =>
	Object.fromEntries(
		optionalSettingKeys
			.filter((key) => goal[key] !== undefined)
			.map((key) => [key, goal[key]]),
	);
const outerStreamSettings = (row: PerTitleAutomaticTemplate) => ({
	...(row.codecMaxBitrateFactor !== undefined
		? { codecMaxBitrateFactor: row.codecMaxBitrateFactor }
		: {}),
	...(row.codecBufsizeFactor !== undefined
		? { codecBufsizeFactor: row.codecBufsizeFactor }
		: {}),
});

export type PerTitleGoalRow = {
	id: string;
	height: number;
	width?: number;
	minBitrate?: number;
	maxBitrate?: number;
	bitrateSelectionMode?: "OPTIMIZED" | "COMPLEXITY_RANGE";
	lowComplexityBoundaryForMaxBitrate?: number;
	highComplexityBoundaryForMaxBitrate?: number;
	codecMaxBitrateFactor?: number;
	codecBufsizeFactor?: number;
};

export type PerTitleAutomaticTemplate = Omit<PerTitleGoalRow, "height"> & {
	height?: number;
};

export type PerTitleFixedResolutionAndBitrateConfiguration = NonNullable<
	NonNullable<
		NonNullable<EncodingPlan["perTitle"]>["h264Configuration"]
	>["fixedResolutionAndBitrateConfiguration"]
>;

export type PerTitleGoal = PerTitleOptionalSettings & {
	strategy: PerTitleStrategy;
	codec: PerTitleCodec;
	minBitrate: number;
	maxBitrate: number;
	minBitrateStepSize?: number;
	maxBitrateStepSize?: number;
	countPolicy: PerTitleCountPolicy;
	rows?: readonly PerTitleGoalRow[];
	automaticTemplates?: readonly PerTitleAutomaticTemplate[];
	autoRepresentations?:
		| false
		| NonNullable<PerTitleApiSettings["global"]["autoRepresentations"]>;
	fixedResolutionAndBitrateConfiguration?: PerTitleFixedResolutionAndBitrateConfiguration;
	inputHeight?: number;
	inputWidth?: number;
	scenarioFractions?: readonly number[];
	settingLocks?: PerTitleSettingLocks;
	adjustments?: PerTitleAdjustments;
};

export type PerTitleDiagnostic = {
	code:
		| "model-only"
		| "invalid-global-range"
		| "invalid-setting"
		| "invalid-step"
		| "invalid-count"
		| "count-required"
		| "rows-required"
		| "invalid-row"
		| "invalid-row-range"
		| "row-outside-global-range"
		| "invalid-complexity-range"
		| "required-count-exceeded"
		| "row-step-conflict"
		| "row-gap-conflict"
		| "row-order-unknown"
		| "count-unreachable"
		| "extra-rungs-possible"
		| "count-not-guaranteed"
		| "complexity-analysis-required"
		| "inactive-template-settings"
		| "upscale-required"
		| "step-adjusted"
		| "linear-illustration"
		| "scenario-range-bound"
		| "scenario-conflict"
		| "forced-count-unknown"
		| "model-limit";
	severity: "info" | "warning" | "conflict";
	message: string;
	rowIds?: string[];
	values?: Record<string, number | string>;
};

export type PerTitleApiSettings = {
	global: PerTitleOptionalSettings & {
		minBitrate: number;
		maxBitrate: number;
		minBitrateStepSize: number;
		maxBitrateStepSize: number;
		autoRepresentations?: { adoptConfigurationThreshold?: number };
		fixedResolutionAndBitrateConfiguration?: PerTitleFixedResolutionAndBitrateConfiguration;
	};
	streams: Array<{
		rowId: string;
		height?: number;
		width?: number;
		mode:
			| "PER_TITLE_TEMPLATE"
			| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
			| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
		perTitleSettings?: {
			minBitrate?: number;
			maxBitrate?: number;
			bitrateSelectionMode?: "OPTIMIZED" | "COMPLEXITY_RANGE";
			lowComplexityBoundaryForMaxBitrate?: number;
			highComplexityBoundaryForMaxBitrate?: number;
			codecMaxBitrateFactor?: number;
			codecBufsizeFactor?: number;
		};
	}>;
};

export type PerTitleScenario = {
	id: string;
	fraction: number;
	assumedMaxBitrate: number;
	status: "modelled" | "conflict" | "unknown";
	modelCountRange: { minimum: number; maximum: number } | null;
	rowModels: Array<{
		rowId: string;
		minimumBitrate: number;
		maximumBitrate: number;
		linearTargetBitrate: number | null;
		boundaryFraction: number | null;
	}>;
	modelRungs: Array<{
		rowId?: string;
		height?: number;
		bitrate: number;
		kind: "required" | "illustrative";
	}>;
	diagnostics: PerTitleDiagnostic[];
};

export type PerTitleProposal = {
	managedGlobalSettings?: readonly string[];
	id: "baseline" | "step-adjusted";
	codec: PerTitleCodec;
	status: "candidate" | "conflict" | "unknown";
	applicable: boolean;
	evidence: "model-only";
	countGuarantee: false;
	api: PerTitleApiSettings;
	scenarios: PerTitleScenario[];
	diagnostics: PerTitleDiagnostic[];
	derivation?: PerTitleDerivation;
};

export type PerTitleDerivation = {
	method:
		| "joint-constraints"
		| "preserved-existing"
		| "geometric-count"
		| "required-intervals"
		| "documented-defaults";
	desiredCount?: number;
	requiredRowCount: number;
	ratioLowerExclusive?: number;
	ratioUpperInclusive?: number;
	maximumFeasibleStep?: number;
	idealStep?: number;
	selectedMinStep: number;
	selectedMaxStep: number;
	targetSatisfied: boolean;
	fixedOrderRowIds?: string[];
	integerWitness?: number[];
	/** Keeps the same integer example at this maximum step, within the model count cap. */
	minimumStepRange?: {
		lowerInclusive: number;
		upperInclusive: number;
		maximumStep: number;
		exampleCount: number;
	};
	rationale: string;
	constraints?: PerTitleConstraintAnalysis;
};

/** Returns arithmetic examples and API candidates, without making provider requests. */
export function proposePerTitleSettings(
	goal: PerTitleGoal,
): PerTitleProposal[] {
	return proposePerTitleModel(goal).map(constrainPerTitleApiCandidate);
}

/** @internal Arithmetic model; public candidates also require API validation. */
export function proposePerTitleModel(goal: PerTitleGoal): PerTitleProposal[] {
	const baseline = buildProposal(goal, "baseline");
	if (baseline.diagnostics.some((item) => inputErrorCodes.has(item.code))) {
		return [baseline];
	}
	if (hasUnresolvedForcedRule(goal)) return [baseline];
	const desiredCount =
		goal.countPolicy.kind === "unrestricted"
			? isClosedStrategy(goal.strategy)
				? goal.rows?.length
				: undefined
			: goal.countPolicy.count;
	if (!desiredCount || desiredCount < 1 || desiredCount > MAX_MODEL_RUNGS) {
		return [baseline];
	}
	const rowPositions = new Map(
		baseline.api.streams.map((stream, index) => [stream.rowId, index]),
	);
	const rows = orderedRows(goal).sort(
		(a, b) => (rowPositions.get(a.id) ?? 0) - (rowPositions.get(b.id) ?? 0),
	);
	const ranges = rowRanges(goal, rows);
	let minimumStep = goal.minBitrateStepSize ?? DEFAULT_MIN_STEP;
	let maximumStep = goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP;
	const capacity = modelCapacity(goal, ranges, minimumStep);
	if (capacity > desiredCount) {
		let lower = minimumStep;
		let upper = goal.maxBitrate / goal.minBitrate + 1;
		for (let index = 0; index < 64; index++) {
			const midpoint = (lower + upper) / 2;
			if (modelCapacity(goal, ranges, midpoint) > desiredCount) {
				lower = midpoint;
			} else {
				upper = midpoint;
			}
		}
		minimumStep = upper;
		maximumStep = Math.max(maximumStep, minimumStep);
	} else if (
		goal.countPolicy.kind === "exact" &&
		capacity < desiredCount &&
		desiredCount > 1 &&
		goal.maxBitrate > goal.minBitrate
	) {
		minimumStep = Math.exp(
			Math.log(goal.maxBitrate / goal.minBitrate) / (desiredCount - 1),
		);
		const idealStep = minimumStep;
		let previous = goal.minBitrate;
		for (let index = 1; index < desiredCount; index++) {
			const bitrate = Math.min(
				goal.maxBitrate,
				Math.round(goal.minBitrate * idealStep ** index),
			);
			minimumStep = Math.min(minimumStep, bitrate / previous);
			maximumStep = Math.max(maximumStep, bitrate / previous);
			previous = bitrate;
		}
		if (minimumStep <= 1) return [baseline];
		maximumStep = Math.max(maximumStep, minimumStep);
	}
	const earliest = choosePoints(ranges, minimumStep, Number.MAX_VALUE, 0);
	if (earliest) {
		for (let index = 1; index < earliest.length; index++) {
			maximumStep = Math.max(
				maximumStep,
				(earliest[index] as number) / (earliest[index - 1] as number),
			);
		}
	}
	if (!isClosedStrategy(goal.strategy) && rows.length === 0) {
		// Rounding a positive integer bitrate upward adds less than one bit per
		// second. This ratio interval lets the example use those integer points.
		maximumStep = Math.max(maximumStep, minimumStep + 1 / goal.minBitrate);
	}
	if (
		Math.abs(minimumStep - (goal.minBitrateStepSize ?? DEFAULT_MIN_STEP)) <
			1e-10 &&
		Math.abs(maximumStep - (goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP)) <
			1e-10
	) {
		return [baseline];
	}
	const adjusted = buildProposal(
		applyPerTitleSettingLocks(
			{
				...goal,
				minBitrateStepSize: minimumStep,
				maxBitrateStepSize: maximumStep,
			},
			goal,
		),
		"step-adjusted",
	);
	adjusted.diagnostics.unshift({
		code: "step-adjusted",
		severity: "info",
		message:
			"Only the bitrate steps change. Requested resolutions and bitrate intervals are preserved.",
		values: {
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
		},
	});
	return [baseline, adjusted];
}

/** Preserves compatible settings, otherwise derives one explicitly bounded model candidate. */
export function recommendPerTitleSettings(
	goal: PerTitleGoal,
): PerTitleProposal {
	return constrainPerTitleApiCandidate(recommendPerTitleModel(goal));
}

/** @internal Arithmetic model; public candidates also require API validation. */
export function recommendPerTitleModel(goal: PerTitleGoal): PerTitleProposal {
	return optimizePerTitleConstraints(goal, recommendIntervalSettings);
}

function recommendIntervalSettings(goal: PerTitleGoal): PerTitleProposal {
	const build = (input: PerTitleGoal, id: PerTitleProposal["id"]) =>
		buildProposal(applyPerTitleSettingLocks(input, goal), id, true);
	const normalized: PerTitleGoal = applyPerTitleSettingLocks(
		{
			...goal,
			minBitrateStepSize: DEFAULT_MIN_STEP,
			maxBitrateStepSize: DEFAULT_MAX_STEP,
		},
		goal,
	);
	const initialRows = orderedRows(normalized);
	const forced = hasUnresolvedForcedRule(goal);
	const desiredCount =
		goal.countPolicy.kind !== "unrestricted"
			? goal.countPolicy.count
			: !hasAutomaticOutput(goal)
				? initialRows.length
				: undefined;
	const internalUpperProofs = new WeakMap<PerTitleProposal, PerTitleProposal>();
	const upperScenario = (
		proposal: PerTitleProposal,
		details: Pick<
			PerTitleDerivation,
			"fixedOrderRowIds" | "integerWitness"
		> = {},
	): PerTitleScenario | undefined => {
		const displayed = proposal.scenarios.find(
			(scenario) => scenario.fraction === 1,
		);
		if (displayed || forced) return displayed;
		let proof = internalUpperProofs.get(proposal);
		if (!proof) {
			proof = build(
				{
					...goal,
					minBitrateStepSize: proposal.api.global.minBitrateStepSize,
					maxBitrateStepSize: proposal.api.global.maxBitrateStepSize,
					scenarioFractions: [1],
				},
				proposal.id,
			);
			internalUpperProofs.set(proposal, proof);
		}
		useCheckedIntervalWitness(proof, goal, details);
		return proof.scenarios[0];
	};
	const finish = (
		proposal: PerTitleProposal,
		details: Omit<
			PerTitleDerivation,
			| "selectedMinStep"
			| "selectedMaxStep"
			| "requiredRowCount"
			| "targetSatisfied"
		>,
	) => {
		useCheckedIntervalWitness(proposal, goal, details);
		const validLockedPoints = (points: readonly number[]) =>
			points.length > 0 &&
			points.every((bitrate, index) => {
				if (
					!Number.isSafeInteger(bitrate) ||
					bitrate < proposal.api.global.minBitrate ||
					bitrate > proposal.api.global.maxBitrate
				)
					return false;
				const previous = points[index - 1];
				return (
					previous === undefined ||
					(bitrate > previous &&
						bitrate / previous >= proposal.api.global.minBitrateStepSize &&
						bitrate / previous <= proposal.api.global.maxBitrateStepSize)
				);
			});
		const validExample = (scenario: PerTitleScenario | undefined) =>
			hasValidIntegerExample(proposal, scenario) &&
			(!goal.settingLocks ||
				validLockedPoints(
					scenario?.modelRungs.map((rung) => rung.bitrate) ?? [],
				));
		if (goal.settingLocks) {
			proposal.scenarios = proposal.scenarios.map((scenario) =>
				scenario.status === "modelled" && !validExample(scenario)
					? {
							...scenario,
							status: "unknown",
							modelCountRange: null,
							modelRungs: [],
							rowModels: [],
						}
					: scenario,
			);
		}
		const high = upperScenario(proposal, details);
		if (
			goal.settingLocks &&
			details.integerWitness &&
			!validLockedPoints(details.integerWitness)
		) {
			details = { ...details };
			if (
				validExample(high) &&
				(!details.fixedOrderRowIds ||
					(details.fixedOrderRowIds.length === high?.modelRungs.length &&
						details.fixedOrderRowIds.every(
							(id, index) => high?.modelRungs[index]?.rowId === id,
						)))
			)
				details.integerWitness = high?.modelRungs.map((rung) => rung.bitrate);
			else delete details.integerWitness;
		}
		if (
			proposal.applicable &&
			!validExample(high) &&
			!proposal.scenarios.some((scenario) => validExample(scenario))
		) {
			proposal.applicable = false;
			proposal.status = "unknown";
		}
		proposal.derivation = {
			...details,
			...(desiredCount ? { desiredCount } : {}),
			requiredRowCount: initialRows.length,
			selectedMinStep: proposal.api.global.minBitrateStepSize,
			selectedMaxStep: proposal.api.global.maxBitrateStepSize,
			targetSatisfied:
				proposal.applicable &&
				validExample(high) &&
				(goal.countPolicy.kind !== "exact" ||
					high?.modelRungs.length === desiredCount) &&
				(!desiredCount ||
					modelCapacity(
						goal,
						rowRanges(goal, initialRows),
						proposal.api.global.minBitrateStepSize,
					) <= desiredCount),
		};
		if (
			proposal.derivation.targetSatisfied &&
			!forced &&
			high &&
			high.modelRungs.length > 1
		) {
			const ratios = high.modelRungs
				.slice(1)
				.map(
					(rung, index) =>
						rung.bitrate / (high.modelRungs[index]?.bitrate as number),
				);
			const minimumStep = proposal.api.global.minBitrateStepSize;
			const maximumStep = proposal.api.global.maxBitrateStepSize;
			const upper = Math.min(maximumStep, ...ratios);
			const cap = desiredCount ?? MAX_MODEL_RUNGS;
			const ranges = rowRanges(goal, initialRows);
			if (
				minimumStep <= upper &&
				ratios.every((ratio) => ratio >= minimumStep && ratio <= maximumStep) &&
				modelCapacity(goal, ranges, minimumStep) <= cap
			) {
				let good = minimumStep;
				let bad = 1;
				for (let index = 0; index < 64; index++) {
					const midpoint = (bad + good) / 2;
					if (midpoint > 1 && modelCapacity(goal, ranges, midpoint) <= cap)
						good = midpoint;
					else bad = midpoint;
				}
				proposal.derivation.minimumStepRange = {
					lowerInclusive: good,
					upperInclusive: upper,
					maximumStep,
					exampleCount: high.modelRungs.length,
				};
			}
		}
		return proposal;
	};
	if (validateGoal(normalized).length) {
		return finish(build(normalized, "baseline"), {
			method: "required-intervals",
			rationale:
				"The input is invalid. Requested intervals and counts were not changed.",
		});
	}
	if (
		goal.minBitrateStepSize !== undefined ||
		goal.maxBitrateStepSize !== undefined
	) {
		const existing = build(goal, "baseline");
		if (
			!existing.diagnostics.some(
				(item) =>
					item.severity === "conflict" || item.code === "row-order-unknown",
			) &&
			(forced || hasValidIntegerExample(existing, upperScenario(existing)))
		) {
			return finish(existing, {
				method: "preserved-existing",
				rationale:
					"Existing spacing satisfies the model's row and explicit count checks, so it is retained to minimize setting changes. Unmodelled additional-rendition rules remain unknown.",
			});
		}
	}
	if (!initialRows.length && (!desiredCount || forced)) {
		return finish(build(normalized, "baseline"), {
			method: "documented-defaults",
			rationale:
				"No count or required interval supplies a spacing objective. This model uses the documented defaults 1.5 and 1.9: https://developer.bitmovin.com/encoding/docs/per-title-configuration-options. This is not a quality optimization.",
		});
	}
	const span = goal.maxBitrate / goal.minBitrate;
	if (!initialRows.length) {
		const requested = desiredCount as number;
		const count =
			goal.countPolicy.kind === "maximum"
				? Math.min(requested, goal.maxBitrate - goal.minBitrate + 1)
				: requested;
		const lower =
			goal.maxBitrate - goal.minBitrate + 1 <= count ? 1 : span ** (1 / count);
		const ideal = count > 1 ? span ** (1 / (count - 1)) : undefined;
		const ranges = Array.from({ length: count }, () => ({
			minimum: goal.minBitrate,
			maximum: goal.maxBitrate,
		}));
		let feasibleLower = 1;
		let feasibleUpper = ideal ?? span + 1;
		let witness = integerPoints(ranges, 1);
		if (count > 1 && witness) {
			for (let index = 0; index < 64; index++) {
				const midpoint = (feasibleLower + feasibleUpper) / 2;
				const points = integerPoints(ranges, midpoint);
				if (points) {
					feasibleLower = midpoint;
					witness = points;
				} else feasibleUpper = midpoint;
			}
		}
		let capLower = 1;
		let capUpper = span + 1;
		for (let index = 0; index < 64; index++) {
			const midpoint = (capLower + capUpper) / 2;
			if (modelCapacity(goal, [], midpoint) > count) capLower = midpoint;
			else capUpper = midpoint;
		}
		const feasiblePoints = witness ?? [];
		const feasibleRatios = feasiblePoints
			.slice(1)
			.map((point, index) => point / (feasiblePoints[index] as number));
		const upper =
			ideal === undefined || !feasibleRatios.length
				? undefined
				: Math.min(ideal, ...feasibleRatios);
		const minimumStep =
			count === 1
				? (goal.maxBitrate + Math.max(1, Math.ceil(goal.maxBitrate / 100))) /
					goal.minBitrate
				: upper !== undefined && upper > capUpper
					? Math.exp((Math.log(capUpper) + Math.log(upper)) / 2)
					: Math.max(1 + Number.EPSILON, capUpper);
		witness = integerPoints(ranges, minimumStep);
		const points = witness ?? [];
		const ratios = points
			.slice(1)
			.map((point, index) => point / (points[index] as number));
		const maximumStep = Math.max(minimumStep, ...ratios);
		return finish(
			build(
				{
					...normalized,
					minBitrateStepSize: minimumStep,
					maxBitrateStepSize: maximumStep,
				},
				"step-adjusted",
			),
			{
				method: "geometric-count",
				ratioLowerExclusive: lower,
				...(upper !== undefined ? { ratioUpperInclusive: upper } : {}),
				...(ideal !== undefined ? { idealStep: ideal } : {}),
				integerWitness: points,
				rationale:
					count === 1
						? "A single-output request places the next arithmetic bitrate at least 1% above the overall cap, with a minimum one-bit/s margin. Short-input checks found two outputs with an infinitesimal cap margin and one with this wider margin. This is a tool policy, not an API count guarantee or a quality optimum."
						: "The continuous count-cap interval guides a greedy integer placement. Bisection bounds its feasible minimum step, and an interior value leaves rounding margin. The maximum step covers the actual integer gaps; this is a spacing model, not a provider or quality optimum.",
			},
		);
	}
	const widestStep = span + 1;
	const ordering = resolveRowOrder(
		normalized,
		initialRows,
		1 + Number.EPSILON,
		widestStep,
		(candidate) => integerPoints(rowRanges(goal, candidate), 1) !== null,
	);
	const ranges = rowRanges(goal, ordering.rows);
	const firstWitness = integerPoints(ranges, 1);
	if (ordering.unknown || !firstWitness) {
		const result = build(normalized, "baseline");
		if (ordering.unknown) {
			result.status = "unknown";
			result.applicable = false;
			result.diagnostics = result.diagnostics.filter(
				(item) => item.severity !== "conflict",
			);
			result.diagnostics.push({
				code: "row-order-unknown",
				severity: "warning",
				message:
					"The bounded search did not establish an integer ordering; this does not prove the requested ladder impossible.",
				values: { states: ordering.states, limit: MAX_ORDER_STATES },
			});
			result.scenarios = result.scenarios.map((scenario) => ({
				...scenario,
				status: "unknown",
				modelCountRange: null,
				modelRungs: [],
				rowModels: [],
				diagnostics: result.diagnostics.filter(
					(item) => item.code === "row-order-unknown",
				),
			}));
		}
		return finish(result, {
			method: "required-intervals",
			fixedOrderRowIds: ordering.rows.map((row) => row.id),
			rationale:
				"A valid integer ordering was not established. No ranges or required rows were relaxed.",
		});
	}
	let feasibleLower = 1;
	let feasibleUpper = widestStep;
	let witness = firstWitness;
	if (ranges.length > 1) {
		for (let index = 0; index < 64; index++) {
			const midpoint = (feasibleLower + feasibleUpper) / 2;
			const points = integerPoints(ranges, midpoint);
			if (points) {
				feasibleLower = midpoint;
				witness = points;
			} else feasibleUpper = midpoint;
		}
	}
	const maximumFeasibleStep =
		ranges.length > 1
			? Math.min(
					...witness
						.slice(1)
						.map((point, index) => point / (witness[index] as number)),
				)
			: undefined;
	let countLower = 1;
	let countUpper = widestStep;
	if (desiredCount && !forced) {
		for (let index = 0; index < 64; index++) {
			const midpoint = (countLower + countUpper) / 2;
			if (modelCapacity(goal, ranges, midpoint) > desiredCount)
				countLower = midpoint;
			else countUpper = midpoint;
		}
	}
	const upper = maximumFeasibleStep ?? countLower + 2;
	const minimumStep =
		upper > countUpper || !desiredCount || forced
			? Math.exp(
					(Math.log(desiredCount && !forced ? countUpper : 1) +
						Math.log(upper)) /
						2,
				)
			: Math.max(1 + Number.EPSILON, upper);
	witness = integerPoints(ranges, minimumStep) ?? witness;
	const maximumStep = Math.max(
		minimumStep + 1 / goal.minBitrate,
		...witness
			.slice(1)
			.map((point, index) => point / (witness[index] as number)),
	);
	return finish(
		build(
			{
				...normalized,
				minBitrateStepSize: minimumStep,
				maxBitrateStepSize: maximumStep,
			},
			"step-adjusted",
		),
		{
			method: "required-intervals",
			...(desiredCount && !forced ? { ratioLowerExclusive: countLower } : {}),
			...(maximumFeasibleStep !== undefined
				? { ratioUpperInclusive: maximumFeasibleStep, maximumFeasibleStep }
				: {}),
			fixedOrderRowIds: ordering.rows.map((row) => row.id),
			integerWitness: witness,
			rationale:
				"The model intersects the count-cap lower bound with the largest feasible minimum step in this fixed row order, then chooses an interior value for rounding margin. The integer witness preserves every interval. Bounded ordering does not prove a global or provider quality optimum.",
		},
	);
}

function hasValidIntegerExample(
	proposal: PerTitleProposal,
	scenario: PerTitleScenario | undefined,
): boolean {
	if (scenario?.status !== "modelled" || !scenario.modelRungs.length)
		return false;
	return scenario.modelRungs.every((rung, index, rungs) => {
		if (
			!Number.isSafeInteger(rung.bitrate) ||
			rung.bitrate < proposal.api.global.minBitrate ||
			rung.bitrate > proposal.api.global.maxBitrate ||
			rung.bitrate > scenario.assumedMaxBitrate
		)
			return false;
		const previous = rungs[index - 1]?.bitrate;
		if (previous === undefined) return true;
		const ratio = rung.bitrate / previous;
		return (
			rung.bitrate > previous &&
			ratio >= proposal.api.global.minBitrateStepSize - EPSILON &&
			ratio <= proposal.api.global.maxBitrateStepSize + EPSILON
		);
	});
}

/** Uses a proved fixed-order example only where that scenario can contain it. */
function useCheckedIntervalWitness(
	proposal: PerTitleProposal,
	goal: PerTitleGoal,
	details: Pick<PerTitleDerivation, "fixedOrderRowIds" | "integerWitness">,
): void {
	const ids = details.fixedOrderRowIds;
	const points = details.integerWitness;
	const rows = orderedRows(goal);
	if (
		!ids ||
		!points ||
		ids.length !== rows.length ||
		points.length !== ids.length ||
		new Set(ids).size !== ids.length
	)
		return;
	const byId = new Map(rows.map((row) => [row.id, row]));
	const ordered = ids.map((id) => byId.get(id));
	if (ordered.some((row) => !row)) return;
	const actualRows = ordered as PerTitleGoalRow[];
	const ranges = rowRanges(goal, actualRows);
	for (let index = 0; index < points.length; index++) {
		const point = points[index] as number;
		const range = ranges[index] as Interval;
		if (
			!Number.isSafeInteger(point) ||
			point < range.minimum ||
			point > range.maximum
		)
			return;
		if (index > 0) {
			const ratio = point / (points[index - 1] as number);
			if (
				(actualRows[index]?.height ?? 0) <
					(actualRows[index - 1]?.height ?? 0) ||
				ratio < proposal.api.global.minBitrateStepSize - EPSILON ||
				ratio > proposal.api.global.maxBitrateStepSize + EPSILON
			)
				return;
		}
	}
	proposal.scenarios = proposal.scenarios.map((scenario) => {
		if (
			!scenario.modelCountRange ||
			!scenario.diagnostics.some((item) => item.code === "row-step-conflict") ||
			points.some((point) => point > scenario.assumedMaxBitrate)
		)
			return scenario;
		const diagnostics = scenario.diagnostics.filter(
			(item) => item.code !== "row-step-conflict",
		);
		const incomplete =
			goal.countPolicy.kind === "exact" &&
			points.length !== goal.countPolicy.count;
		return {
			...scenario,
			modelRungs: points.map((bitrate, index) => ({
				rowId: ids[index],
				height: actualRows[index]?.height,
				bitrate,
				kind: "required" as const,
			})),
			diagnostics,
			status: diagnostics.some((item) => item.severity === "conflict")
				? "conflict"
				: incomplete
					? "unknown"
					: "modelled",
		};
	});
	if (!proposal.scenarios.some((scenario) => scenario.status === "conflict")) {
		proposal.diagnostics = proposal.diagnostics.filter(
			(item) => item.code !== "scenario-conflict",
		);
	}
}

/** Earliest strictly increasing integer assignment, with no maximum-gap constraint. */
function integerPoints(
	ranges: Interval[],
	minimumStep: number,
): number[] | null {
	const points: number[] = [];
	for (const range of ranges) {
		const previous = points.at(-1);
		const point =
			previous === undefined
				? range.minimum
				: Math.max(
						range.minimum,
						previous + 1,
						Math.ceil(previous * minimumStep),
					);
		if (!Number.isSafeInteger(point) || point > range.maximum) return null;
		points.push(point);
	}
	return points;
}

const DEFAULT_MIN_STEP = 1.5;
const DEFAULT_MAX_STEP = 1.9;
const MAX_MODEL_RUNGS = 256;
const MAX_ROWS = 64;
const MAX_SCENARIOS = 9;
const MAX_ORDER_STATES = 2048;
const EPSILON = 1e-10;

const inputErrorCodes = new Set<PerTitleDiagnostic["code"]>([
	"invalid-setting",
	"invalid-global-range",
	"invalid-step",
	"invalid-count",
	"count-required",
	"rows-required",
	"invalid-row",
	"invalid-row-range",
	"row-outside-global-range",
	"invalid-complexity-range",
	"required-count-exceeded",
	"model-limit",
]);

type Interval = { minimum: number; maximum: number };

function isClosedStrategy(strategy: PerTitleStrategy): boolean {
	return strategy === "fixed-resolutions" || strategy === "fixed-ranges";
}

function hasAutomaticOutput(goal: PerTitleGoal): boolean {
	return (
		!isClosedStrategy(goal.strategy) ||
		(goal.automaticTemplates?.length ?? 0) > 0
	);
}

function hasUnresolvedForcedRule(goal: PerTitleGoal): boolean {
	const rule = goal.fixedResolutionAndBitrateConfiguration;
	return (
		rule !== undefined &&
		rule?.forcedRenditionAboveHighestFixedRepresentation !== 0
	);
}

function positiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function orderedRows(goal: PerTitleGoal): PerTitleGoalRow[] {
	return goal.strategy === "automatic" || goal.strategy === "count"
		? []
		: [...(goal.rows ?? [])].sort(
				(a, b) =>
					a.height - b.height ||
					(goal.strategy === "fixed-ranges"
						? (a.minBitrate ?? 0) - (b.minBitrate ?? 0) ||
							(a.maxBitrate ?? 0) - (b.maxBitrate ?? 0)
						: 0),
			);
}

/** Searches only interchangeable heights; the budget is shared by both step checks. */
function resolveRowOrder(
	goal: PerTitleGoal,
	rows: PerTitleGoalRow[],
	minimumStep: number,
	maximumStep: number,
	acceptOrder?: (rows: PerTitleGoalRow[]) => boolean,
): { rows: PerTitleGoalRow[]; unknown: boolean; states: number } {
	if (
		goal.strategy !== "fixed-ranges" ||
		!rows.some(
			(row, index) => index > 0 && row.height === rows[index - 1]?.height,
		)
	) {
		return { rows, unknown: false, states: 0 };
	}
	const ranges = rowRanges(goal, rows);
	if (
		choosePoints(ranges, minimumStep, maximumStep, 0.5) &&
		(!acceptOrder || acceptOrder(rows))
	) {
		return { rows, unknown: false, states: 0 };
	}
	const intervals = ranges.map((range) => ({
		minimum: Math.log(range.minimum),
		maximum: Math.log(range.maximum),
	}));
	const minimumDelta = Math.log(minimumStep);
	let states = 0;
	let exhausted = false;
	const search = (maximum: number): number[] | null => {
		const maximumDelta = Math.log(maximum);
		const order: number[] = [];
		const visit = (
			remaining: number[],
			previous?: Interval,
		): number[] | null => {
			if (states >= MAX_ORDER_STATES) {
				exhausted = true;
				return null;
			}
			states++;
			if (remaining.length === 0)
				return !acceptOrder ||
					acceptOrder(order.map((index) => rows[index] as PerTitleGoalRow))
					? [...order]
					: null;
			const height = rows[remaining[0] as number]?.height;
			const candidates = remaining
				.filter((index) => rows[index]?.height === height)
				.sort(
					(a, b) =>
						(intervals[a]?.maximum ?? 0) - (intervals[b]?.maximum ?? 0) ||
						(intervals[a]?.minimum ?? 0) - (intervals[b]?.minimum ?? 0),
				);
			const seen = new Set<string>();
			for (const index of candidates) {
				const range = intervals[index] as Interval;
				const signature = `${range.minimum}:${range.maximum}`;
				if (seen.has(signature)) continue;
				seen.add(signature);
				const next = {
					minimum: Math.max(
						range.minimum,
						previous ? previous.minimum + minimumDelta : range.minimum,
					),
					maximum: Math.min(
						range.maximum,
						previous ? previous.maximum + maximumDelta : range.maximum,
					),
				};
				if (next.minimum > next.maximum + EPSILON) continue;
				order.push(index);
				const found = visit(
					remaining.filter((value) => value !== index),
					next,
				);
				order.pop();
				if (found) return found;
				if (exhausted) return null;
			}
			return null;
		};
		return visit(rows.map((_row, index) => index));
	};
	const found = search(maximumStep);
	if (found) {
		return {
			rows: found.map((index) => rows[index] as PerTitleGoalRow),
			unknown: false,
			states,
		};
	}
	if (!exhausted) {
		const minimumOnly = search(Number.MAX_VALUE);
		if (minimumOnly) {
			return {
				rows: minimumOnly.map((index) => rows[index] as PerTitleGoalRow),
				unknown: false,
				states,
			};
		}
	}
	return { rows, unknown: exhausted, states };
}

function rowRanges(goal: PerTitleGoal, rows: PerTitleGoalRow[]): Interval[] {
	return rows.map((row) => ({
		minimum:
			goal.strategy === "fixed-ranges"
				? (row.minBitrate as number)
				: goal.minBitrate,
		maximum:
			goal.strategy === "fixed-ranges"
				? (row.maxBitrate as number)
				: goal.maxBitrate,
	}));
}

/** A spacing bound for this model, not a prediction of provider output. */
function capacityOf(range: Interval, minimumStep: number): number {
	return Math.min(
		range.maximum - range.minimum + 1,
		1 +
			Math.floor(
				Math.log(range.maximum / range.minimum) / Math.log(minimumStep) +
					EPSILON,
			),
	);
}

function modelCapacity(
	goal: PerTitleGoal,
	ranges: Interval[],
	minimumStep: number,
): number {
	const globalCapacity = capacityOf(
		{ minimum: goal.minBitrate, maximum: goal.maxBitrate },
		minimumStep,
	);
	if (goal.strategy !== "fixed-ranges" || hasAutomaticOutput(goal))
		return globalCapacity;
	return Math.min(
		globalCapacity,
		ranges.reduce((total, range) => total + capacityOf(range, minimumStep), 0),
	);
}

/** Intersects adjacent log-bitrate intervals with the requested ratio bounds. */
function choosePoints(
	ranges: Interval[],
	minimumStep: number,
	maximumStep: number,
	fraction: number,
): number[] | null {
	const minimumDelta = Math.log(minimumStep);
	const maximumDelta = Math.log(maximumStep);
	const bounds = ranges.map((range) => ({
		minimum: Math.log(range.minimum),
		maximum: Math.log(range.maximum),
	}));
	for (let index = 1; index < bounds.length; index++) {
		const current = bounds[index] as Interval;
		const previous = bounds[index - 1] as Interval;
		current.minimum = Math.max(
			current.minimum,
			previous.minimum + minimumDelta,
		);
		current.maximum = Math.min(
			current.maximum,
			previous.maximum + maximumDelta,
		);
		if (current.minimum > current.maximum + EPSILON) return null;
	}
	for (let index = bounds.length - 2; index >= 0; index--) {
		const current = bounds[index] as Interval;
		const next = bounds[index + 1] as Interval;
		current.minimum = Math.max(current.minimum, next.minimum - maximumDelta);
		current.maximum = Math.min(current.maximum, next.maximum - minimumDelta);
		if (current.minimum > current.maximum + EPSILON) return null;
	}
	const points: number[] = [];
	for (const bound of bounds) {
		const previous = points.at(-1);
		const lower =
			previous === undefined
				? bound.minimum
				: Math.max(bound.minimum, previous + minimumDelta);
		const upper =
			previous === undefined
				? bound.maximum
				: Math.min(bound.maximum, previous + maximumDelta);
		if (lower > upper + EPSILON) return null;
		points.push(lower + Math.max(0, upper - lower) * fraction);
	}
	return points.map((point) => Math.exp(point));
}

function validateGoal(goal: PerTitleGoal): PerTitleDiagnostic[] {
	const diagnostics: PerTitleDiagnostic[] = [];
	const conflict = (
		code: PerTitleDiagnostic["code"],
		message: string,
		rowIds?: string[],
	) => diagnostics.push({ code, severity: "conflict", message, rowIds });
	if (!validPerTitleSettingLocks(goal.settingLocks)) {
		conflict("invalid-setting", "A setting lock uses an unsupported field.");
	}
	for (const key of [
		"minBitrate",
		"maxBitrate",
		"minBitrateStepSize",
		"maxBitrateStepSize",
	] as const) {
		if (perTitleGlobalLocked(goal, key) && goal[key] === undefined) {
			conflict(
				"invalid-setting",
				"A locked required setting needs a numeric value before it can be held.",
			);
		}
	}
	for (const key of optionalSettingKeys) {
		const value = goal[key];
		if (value === undefined) continue;
		if (
			!Number.isFinite(value) ||
			(key === "targetQualityCrf" && goal.codec === "H265V2") ||
			(key === "targetQualityQp" && goal.codec !== "H265V2") ||
			(key.startsWith("codec") &&
				(goal.codec === "VP9" ||
					goal.codec === "AV1" ||
					(key === "codecBufsizeFactor" && goal.codec === "H265V2"))) ||
			(key === "resolutionScaleFactor" && (value < -15 || value > 15)) ||
			((key === "complexityFactor" || key.startsWith("codec")) && value <= 0)
		) {
			conflict(
				"invalid-setting",
				"An optional Per-Title setting is invalid or unsupported for this codec.",
			);
		}
	}
	for (const row of [
		...orderedRows(goal),
		...(goal.automaticTemplates ?? []),
	].slice(0, MAX_ROWS * 2)) {
		for (const key of [
			"codecMaxBitrateFactor",
			"codecBufsizeFactor",
		] as const) {
			if (
				row[key] !== undefined &&
				(!Number.isFinite(row[key]) ||
					row[key] <= 0 ||
					(goal.codec !== "H264" && goal.codec !== "H265"))
			) {
				conflict(
					"invalid-setting",
					"Stream bitrate factors require positive finite values and an H264 or H265 codec.",
					[row.id],
				);
			}
		}
		if (goal.strategy === "fixed-ranges") {
			for (const key of [
				"lowComplexityBoundaryForMaxBitrate",
				"highComplexityBoundaryForMaxBitrate",
			] as const) {
				if (
					perTitleStreamLocked(goal, row.id, key) &&
					row[key] !== undefined &&
					!positiveInteger(row[key])
				)
					conflict(
						"invalid-setting",
						"An emitted complexity boundary must be a positive integer.",
						[row.id],
					);
			}
		}
	}
	if (
		!positiveInteger(goal.minBitrate) ||
		!positiveInteger(goal.maxBitrate) ||
		goal.maxBitrate < goal.minBitrate
	) {
		conflict(
			"invalid-global-range",
			"Enter a positive, ordered bitrate interval.",
		);
	}
	const minimumStep = goal.minBitrateStepSize ?? DEFAULT_MIN_STEP;
	const automatic = goal.autoRepresentations;
	if (automatic && !hasAutomaticOutput(goal)) {
		conflict(
			"invalid-row",
			"Automatic resolution generation requires an ordinary Per-Title template.",
		);
	}
	if (
		automatic !== undefined &&
		automatic !== false &&
		(!automatic ||
			typeof automatic !== "object" ||
			(automatic.adoptConfigurationThreshold !== undefined &&
				(!Number.isFinite(automatic.adoptConfigurationThreshold) ||
					automatic.adoptConfigurationThreshold < 0 ||
					automatic.adoptConfigurationThreshold > 1)))
	) {
		conflict(
			"invalid-row",
			"The automatic-resolution threshold must be between zero and one.",
		);
	}
	const maximumStep = goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP;
	if (
		!Number.isFinite(minimumStep) ||
		!Number.isFinite(maximumStep) ||
		minimumStep <= 1 ||
		maximumStep < minimumStep
	) {
		conflict(
			"invalid-step",
			"Bitrate steps must be finite, greater than one, and ordered.",
		);
	}
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		(!positiveInteger(goal.countPolicy.count) ||
			goal.countPolicy.count > MAX_MODEL_RUNGS)
	) {
		conflict(
			"invalid-count",
			`Enter a rendition count from 1 to ${MAX_MODEL_RUNGS}.`,
		);
	}
	if (goal.strategy === "count" && goal.countPolicy.kind === "unrestricted") {
		conflict("count-required", "The count strategy requires a count goal.");
	}
	const rows = orderedRows(goal);
	if (
		(goal.inputHeight !== undefined && !positiveInteger(goal.inputHeight)) ||
		(goal.inputWidth !== undefined && !positiveInteger(goal.inputWidth))
	) {
		conflict(
			"invalid-row",
			"Source dimensions must be positive integers when provided.",
		);
	}
	if (
		goal.strategy !== "automatic" &&
		goal.strategy !== "count" &&
		rows.length === 0
	) {
		conflict("rows-required", "Add at least one required resolution.");
	}
	const automaticTemplates = goal.automaticTemplates ?? [];
	const streamCount =
		rows.length +
		(automaticTemplates.length || (isClosedStrategy(goal.strategy) ? 0 : 1));
	if (
		streamCount > MAX_ROWS ||
		(goal.scenarioFractions?.length ?? 0) > MAX_SCENARIOS
	) {
		conflict(
			"model-limit",
			"This model supports up to 64 stream templates in total, including the automatic template, and 9 scenarios.",
		);
	}
	if (
		goal.scenarioFractions?.some(
			(fraction) => !Number.isFinite(fraction) || fraction < 0 || fraction > 1,
		)
	) {
		conflict(
			"model-limit",
			"Scenario fractions must be finite values from zero to one.",
		);
	}
	const ids = new Set<string>();
	for (const row of rows.slice(0, MAX_ROWS)) {
		if (
			!row.id ||
			ids.has(row.id) ||
			!positiveInteger(row.height) ||
			(row.width !== undefined && !positiveInteger(row.width))
		) {
			conflict(
				"invalid-row",
				"Each row needs a unique ID and positive integer dimensions.",
				[row.id],
			);
		}
		ids.add(row.id);
		if (goal.strategy !== "fixed-ranges") continue;
		if (
			!positiveInteger(row.minBitrate) ||
			!positiveInteger(row.maxBitrate) ||
			row.maxBitrate < row.minBitrate
		) {
			conflict(
				"invalid-row-range",
				"Each row needs a positive, ordered bitrate interval.",
				[row.id],
			);
		} else if (
			row.minBitrate < goal.minBitrate ||
			row.maxBitrate > goal.maxBitrate
		) {
			conflict(
				"row-outside-global-range",
				"A requested row interval extends beyond the global interval.",
				[row.id],
			);
		}
		if (
			row.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
			(!positiveInteger(row.lowComplexityBoundaryForMaxBitrate) ||
				!positiveInteger(row.highComplexityBoundaryForMaxBitrate) ||
				row.highComplexityBoundaryForMaxBitrate <=
					row.lowComplexityBoundaryForMaxBitrate)
		) {
			conflict(
				"invalid-complexity-range",
				"COMPLEXITY_RANGE requires ordered low and high boundaries.",
				[row.id],
			);
		}
	}
	for (const row of automaticTemplates.slice(0, MAX_ROWS)) {
		if (
			!row.id ||
			ids.has(row.id) ||
			(row.height !== undefined && !positiveInteger(row.height)) ||
			(row.width !== undefined && !positiveInteger(row.width))
		) {
			conflict(
				"invalid-row",
				"Automatic templates need unique IDs and positive integer dimensions when provided.",
				[row.id],
			);
		}
		ids.add(row.id);
	}
	const forced = goal.fixedResolutionAndBitrateConfiguration;
	if (
		forced &&
		((forced.forcedRenditionAboveHighestFixedRepresentation !== undefined &&
			(!Number.isSafeInteger(
				forced.forcedRenditionAboveHighestFixedRepresentation,
			) ||
				forced.forcedRenditionAboveHighestFixedRepresentation < 0)) ||
			(forced.forcedRenditionAboveHighestFixedRepresentationFactor !==
				undefined &&
				(!Number.isFinite(
					forced.forcedRenditionAboveHighestFixedRepresentationFactor,
				) ||
					forced.forcedRenditionAboveHighestFixedRepresentationFactor <= 0)) ||
			(forced.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
				undefined &&
				!["LAST_CALCULATED_BITRATE", "MINIMUM", "MAXIMUM", "AVERAGE"].includes(
					forced.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
				)))
	) {
		conflict(
			"invalid-row",
			"Additional-rendition settings must use a nonnegative integer count, positive factor, and supported calculation mode.",
		);
	}
	if (
		goal.countPolicy.kind !== "unrestricted" &&
		rows.length > goal.countPolicy.count
	) {
		conflict(
			"required-count-exceeded",
			"Required rows exceed the total count goal.",
		);
	}
	return diagnostics;
}

function buildProposal(
	goal: PerTitleGoal,
	id: PerTitleProposal["id"],
	neutralScenarios = false,
): PerTitleProposal {
	const minimumStep = goal.minBitrateStepSize ?? DEFAULT_MIN_STEP;
	const maximumStep = goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP;
	const diagnostics = validateGoal(goal);
	const sortedRows = orderedRows(goal);
	const ordering = diagnostics.some((item) => inputErrorCodes.has(item.code))
		? { rows: sortedRows, unknown: false, states: 0 }
		: resolveRowOrder(goal, sortedRows, minimumStep, maximumStep);
	const rows = ordering.rows;
	if (ordering.unknown) {
		diagnostics.push({
			code: "row-order-unknown",
			severity: "warning",
			message:
				"The bounded search did not establish an ordering for these overlapping same-resolution intervals. This result is unknown, not a proof that the requested ladder is impossible.",
			values: { states: ordering.states, limit: MAX_ORDER_STATES },
		});
	}
	const autoRepresentations =
		goal.autoRepresentations === false ||
		(perTitleGlobalLocked(goal, "autoRepresentations") &&
			goal.autoRepresentations === undefined)
			? undefined
			: (goal.autoRepresentations ??
				(hasAutomaticOutput(goal) ? {} : undefined));
	const api: PerTitleApiSettings = {
		global: {
			...optionalSettings(goal),
			minBitrate: goal.minBitrate,
			maxBitrate: goal.maxBitrate,
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
			...(autoRepresentations !== undefined
				? { autoRepresentations: structuredClone(autoRepresentations) }
				: {}),
			...(goal.fixedResolutionAndBitrateConfiguration
				? {
						fixedResolutionAndBitrateConfiguration: structuredClone(
							goal.fixedResolutionAndBitrateConfiguration,
						),
					}
				: {}),
		},
		streams: rows.map((row) => ({
			rowId: row.id,
			height: row.height,
			...(row.width !== undefined ? { width: row.width } : {}),
			mode:
				goal.strategy === "fixed-ranges"
					? "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
					: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			...(goal.strategy === "fixed-ranges"
				? {
						perTitleSettings: {
							...outerStreamSettings(row),
							minBitrate: row.minBitrate as number,
							maxBitrate: row.maxBitrate as number,
							...(row.bitrateSelectionMode !== undefined
								? { bitrateSelectionMode: row.bitrateSelectionMode }
								: perTitleStreamLocked(goal, row.id, "bitrateSelectionMode")
									? {}
									: { bitrateSelectionMode: "OPTIMIZED" as const }),
							...(row.bitrateSelectionMode === "COMPLEXITY_RANGE"
								? {
										...(row.lowComplexityBoundaryForMaxBitrate !== undefined
											? {
													lowComplexityBoundaryForMaxBitrate:
														row.lowComplexityBoundaryForMaxBitrate,
												}
											: {}),
										...(row.highComplexityBoundaryForMaxBitrate !== undefined
											? {
													highComplexityBoundaryForMaxBitrate:
														row.highComplexityBoundaryForMaxBitrate,
												}
											: {}),
									}
								: {}),
							...Object.fromEntries(
								(
									[
										"lowComplexityBoundaryForMaxBitrate",
										"highComplexityBoundaryForMaxBitrate",
									] as const
								)
									.filter(
										(key) =>
											perTitleStreamLocked(goal, row.id, key) &&
											row[key] !== undefined,
									)
									.map((key) => [key, row[key]]),
							),
						},
					}
				: Object.keys(outerStreamSettings(row)).length
					? { perTitleSettings: outerStreamSettings(row) }
					: {}),
		})),
	};
	if ((goal.automaticTemplates?.length ?? 0) > 0) {
		for (const row of goal.automaticTemplates ?? []) {
			api.streams.push({
				rowId: row.id,
				mode: "PER_TITLE_TEMPLATE",
				...(row.height !== undefined ? { height: row.height } : {}),
				...(row.width !== undefined ? { width: row.width } : {}),
				...(Object.keys(outerStreamSettings(row)).length
					? { perTitleSettings: outerStreamSettings(row) }
					: {}),
			});
		}
	} else if (!isClosedStrategy(goal.strategy)) {
		const rowIds = new Set(rows.map((row) => row.id));
		let rowId = "automatic-template";
		for (let suffix = 1; rowIds.has(rowId); suffix++) {
			rowId = `automatic-template-${suffix}`;
		}
		api.streams.push({
			rowId,
			...(goal.inputHeight !== undefined ? { height: goal.inputHeight } : {}),
			...(goal.inputWidth !== undefined ? { width: goal.inputWidth } : {}),
			mode: "PER_TITLE_TEMPLATE",
		});
	}
	const inactiveTemplateIds = (goal.automaticTemplates ?? [])
		.slice(0, MAX_ROWS)
		.filter(
			(row) =>
				row.minBitrate !== undefined ||
				row.maxBitrate !== undefined ||
				row.bitrateSelectionMode !== undefined ||
				row.lowComplexityBoundaryForMaxBitrate !== undefined ||
				row.highComplexityBoundaryForMaxBitrate !== undefined,
		)
		.map((row) => row.id);
	if (inactiveTemplateIds.length) {
		diagnostics.push({
			code: "inactive-template-settings",
			severity: "warning",
			message:
				"The stored bitrate ranges and complexity settings apply only in PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE mode. They are retained as source data, omitted from these PER_TITLE_TEMPLATE API streams, and do not constrain this model.",
			rowIds: inactiveTemplateIds,
		});
	}
	diagnostics.push({
		code: "model-only",
		severity: "info",
		message: neutralScenarios
			? "Examples use the allowed bitrate intervals and spacing only. They do not simulate content complexity, quality, or provider output."
			: "Examples use interval spacing and an explicitly linear illustration of complexity boundaries. They do not reproduce content analysis or predict provider output.",
	});
	const forcedUnknown = hasUnresolvedForcedRule(goal);
	if (forcedUnknown) {
		diagnostics.push({
			code: "forced-count-unknown",
			severity: "warning",
			message:
				"The additional-rendition configuration is preserved. Conditional output examples do not establish whether its branch runs or how many outputs the encoder generates.",
		});
	}
	if (goal.countPolicy.kind !== "unrestricted") {
		diagnostics.push({
			code: "count-not-guaranteed",
			severity: "warning",
			message:
				"The requested count is a goal, not an Encoding API field or an output guarantee.",
		});
	}
	if (
		rows.some((row) => row.bitrateSelectionMode === "COMPLEXITY_RANGE") &&
		goal.strategy === "fixed-ranges"
	) {
		diagnostics.push({
			code: "complexity-analysis-required",
			severity: "warning",
			message: neutralScenarios
				? "Source complexity is unknown. COMPLEXITY_RANGE settings and boundaries are preserved in the API, but they do not determine these interval examples."
				: "Source analysis is unknown. Complexity examples use only the stated hypothetical target and an illustrative linear interpolation.",
		});
	}
	for (const row of rows) {
		if (goal.inputHeight !== undefined && row.height > goal.inputHeight) {
			diagnostics.push({
				code: "upscale-required",
				severity: "warning",
				message:
					"This required resolution is larger than the stated input height.",
				rowIds: [row.id],
			});
		}
	}
	const invalid = diagnostics.some((item) => inputErrorCodes.has(item.code));
	const ranges = rowRanges(goal, rows);
	if (
		!invalid &&
		!ordering.unknown &&
		!choosePoints(ranges, minimumStep, Number.MAX_VALUE, 0)
	) {
		diagnostics.push({
			code: "row-step-conflict",
			severity: "conflict",
			message:
				"The required rows cannot fit their intervals while preserving the minimum bitrate step.",
		});
	} else if (
		!invalid &&
		!ordering.unknown &&
		!choosePoints(ranges, minimumStep, maximumStep, 0)
	) {
		diagnostics.push({
			code: "row-gap-conflict",
			severity: "conflict",
			message:
				"Connecting the required rows needs a larger maximum step or additional bitrate points.",
		});
	}
	if (
		!invalid &&
		!forcedUnknown &&
		modelCapacity(goal, ranges, minimumStep) > MAX_MODEL_RUNGS
	) {
		diagnostics.push({
			code: "model-limit",
			severity: "conflict",
			message:
				"The spacing bound exceeds the model's 256-point limit. Increase the minimum step to inspect a smaller model.",
		});
	}
	if (!invalid && !forcedUnknown && goal.countPolicy.kind !== "unrestricted") {
		const capacity = modelCapacity(goal, ranges, minimumStep);
		if (
			goal.countPolicy.kind === "exact" &&
			capacity < goal.countPolicy.count
		) {
			diagnostics.push({
				code: "count-unreachable",
				severity: "conflict",
				message:
					"The allowed intervals cannot hold the exact count at this minimum step.",
				values: { maximum: capacity, count: goal.countPolicy.count },
			});
		} else if (capacity > goal.countPolicy.count) {
			diagnostics.push({
				code: "extra-rungs-possible",
				severity: "conflict",
				message:
					"The interval spacing bound permits more points than the count goal.",
				values: { maximum: capacity, count: goal.countPolicy.count },
			});
		}
	}
	const hasConflicts = diagnostics.some((item) => item.severity === "conflict");
	const applicable = !ordering.unknown && !forcedUnknown && !hasConflicts;
	const canModel =
		!ordering.unknown &&
		!forcedUnknown &&
		!diagnostics.some(
			(item) =>
				inputErrorCodes.has(item.code) ||
				item.code === "row-step-conflict" ||
				item.code === "row-gap-conflict",
		);
	const fractions = goal.scenarioFractions?.length
		? goal.scenarioFractions.slice(0, MAX_SCENARIOS)
		: [0.25, 0.5, 1];
	const scenarios = fractions.map((fraction, index) => {
		const scenarioId =
			["low", "medium", "high"][index] ?? `custom-${index + 1}`;
		if (!canModel) {
			return {
				id: scenarioId,
				fraction,
				assumedMaxBitrate: goal.maxBitrate,
				status: "unknown" as const,
				modelCountRange: null,
				rowModels: [],
				modelRungs: [],
				diagnostics: diagnostics.filter(
					(item) =>
						item.severity === "conflict" ||
						item.code === "row-order-unknown" ||
						item.code === "forced-count-unknown",
				),
			};
		}
		return buildScenario(
			goal,
			rows,
			ranges,
			fraction,
			scenarioId,
			!neutralScenarios,
		);
	});
	const conflictingScenarios = scenarios.filter(
		(scenario) => scenario.status === "conflict",
	);
	if (applicable && conflictingScenarios.length > 0) {
		diagnostics.push({
			code: "scenario-conflict",
			severity: "warning",
			message:
				"The full-interval API candidate passes this model's constraints, but some hypothetical scenarios do not. Inspect each scenario before applying; the candidate does not promise that every scenario meets the goal.",
			values: { scenarios: conflictingScenarios.length },
		});
	}
	return {
		id,
		codec: goal.codec,
		status: applicable ? "candidate" : hasConflicts ? "conflict" : "unknown",
		applicable,
		evidence: "model-only",
		countGuarantee: false,
		api,
		scenarios,
		diagnostics,
	};
}

function buildScenario(
	goal: PerTitleGoal,
	rows: PerTitleGoalRow[],
	ranges: Interval[],
	fraction: number,
	id: string,
	allowLinearIllustration = true,
): PerTitleScenario {
	const minimumStep = goal.minBitrateStepSize ?? DEFAULT_MIN_STEP;
	const maximumStep = goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP;
	const diagnostics: PerTitleDiagnostic[] = [];
	const assumedMaxBitrate = Math.round(
		goal.minBitrate + (goal.maxBitrate - goal.minBitrate) * fraction,
	);
	const maximum = rows.length
		? modelCapacity(goal, ranges, minimumStep)
		: capacityOf(
				{ minimum: goal.minBitrate, maximum: assumedMaxBitrate },
				minimumStep,
			);
	const minimum = Math.max(1, rows.length);
	const points = choosePoints(ranges, minimumStep, maximumStep, fraction) ?? [];
	const rowModels: PerTitleScenario["rowModels"] = rows.map((row, index) => {
		const range = ranges[index] as Interval;
		const boundaryFraction =
			allowLinearIllustration &&
			goal.strategy === "fixed-ranges" &&
			row.bitrateSelectionMode === "COMPLEXITY_RANGE"
				? Math.min(
						1,
						Math.max(
							0,
							(assumedMaxBitrate -
								(row.lowComplexityBoundaryForMaxBitrate as number)) /
								((row.highComplexityBoundaryForMaxBitrate as number) -
									(row.lowComplexityBoundaryForMaxBitrate as number)),
						),
					)
				: null;
		return {
			rowId: row.id,
			minimumBitrate: range.minimum,
			maximumBitrate: range.maximum,
			boundaryFraction,
			linearTargetBitrate:
				boundaryFraction === null
					? null
					: Math.round(
							range.minimum +
								(range.maximum - range.minimum) * boundaryFraction,
						),
		};
	});
	const modelRungs: PerTitleScenario["modelRungs"] = points.map(
		(bitrate, index) => ({
			rowId: rows[index]?.id,
			height: rows[index]?.height,
			bitrate: rowModels[index]?.linearTargetBitrate ?? Math.round(bitrate),
			kind: "required",
		}),
	);
	// At one resolution, the illustrated bitrate order is independent of edit order.
	modelRungs.sort(
		(a, b) => (a.height ?? 0) - (b.height ?? 0) || a.bitrate - b.bitrate,
	);
	if (rowModels.some((row) => row.linearTargetBitrate !== null)) {
		diagnostics.push({
			code: "linear-illustration",
			severity: "info",
			message:
				"Each COMPLEXITY_RANGE point is a clamped linear illustration between the requested row bounds, using the hypothetical target as its input.",
		});
	}
	if (rows.length) {
		diagnostics.push({
			code: "scenario-range-bound",
			severity: "info",
			message:
				"The count bound covers the full requested intervals. It is separate from the illustrated points in this scenario.",
		});
	}
	if (rows.length === 0) {
		const selectedCount =
			goal.countPolicy.kind === "exact"
				? Math.min(goal.countPolicy.count, maximum)
				: maximum;
		for (let index = 0; index < selectedCount; index++) {
			const previous = modelRungs.at(-1)?.bitrate;
			const bitrate =
				previous === undefined
					? goal.minBitrate
					: Math.max(
							previous + 1,
							Math.ceil(previous * (minimumStep - EPSILON)),
						);
			const upper =
				previous === undefined
					? assumedMaxBitrate
					: Math.min(
							assumedMaxBitrate,
							Math.floor(previous * (maximumStep + EPSILON)),
						);
			if (!Number.isSafeInteger(bitrate) || bitrate > upper) {
				diagnostics.push({
					code: "row-step-conflict",
					severity: "conflict",
					message:
						"The spacing bound has not produced an integer example within this scenario's bitrate and adjacent step bounds.",
					values: { constructed: modelRungs.length, selected: selectedCount },
				});
				break;
			}
			modelRungs.push({
				bitrate,
				kind: "illustrative",
			});
		}
	}
	for (let index = 1; index < modelRungs.length; index++) {
		const ratio =
			(modelRungs[index]?.bitrate ?? 0) / (modelRungs[index - 1]?.bitrate ?? 1);
		if (ratio < minimumStep - EPSILON || ratio > maximumStep + EPSILON) {
			diagnostics.push({
				code: "row-step-conflict",
				severity: "conflict",
				message:
					"The illustrative integer bitrate points do not satisfy the requested adjacent step bounds.",
				rowIds: [modelRungs[index - 1]?.rowId, modelRungs[index]?.rowId].filter(
					(value): value is string => value !== undefined,
				),
				values: { ratio },
			});
		}
	}
	if (maximum > minimum) {
		diagnostics.push({
			code: "extra-rungs-possible",
			severity: "warning",
			message:
				"The allowed intervals have room for additional bitrate points under the spacing model.",
			values: { minimum, maximum },
		});
	}
	if (goal.countPolicy.kind !== "unrestricted") {
		const count = goal.countPolicy.count;
		if (
			minimum > count ||
			(goal.countPolicy.kind === "exact" && maximum < count)
		) {
			diagnostics.push({
				code: "count-unreachable",
				severity: "conflict",
				message:
					"This scenario's spacing bound cannot include the requested count.",
				values: { minimum, maximum, count },
			});
		} else if (maximum > count) {
			diagnostics.push({
				code: "extra-rungs-possible",
				severity: "conflict",
				message:
					"The spacing bound permits more bitrate points than the count goal.",
				values: { minimum, maximum, count },
			});
		}
	}
	const incompleteExample =
		goal.countPolicy.kind === "exact" &&
		modelRungs.length !== goal.countPolicy.count;
	if (incompleteExample) {
		diagnostics.push({
			code: "count-not-guaranteed",
			severity: "warning",
			message:
				"A count bound does not construct an exact-count ladder. This example has not established the requested count.",
		});
	}
	return {
		id,
		fraction,
		assumedMaxBitrate,
		status: diagnostics.some((item) => item.severity === "conflict")
			? "conflict"
			: incompleteExample
				? "unknown"
				: "modelled",
		modelCountRange: { minimum, maximum },
		rowModels,
		modelRungs,
		diagnostics,
	};
}
