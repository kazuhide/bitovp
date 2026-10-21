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

export type PerTitleGoalRow = {
	id: string;
	height: number;
	width?: number;
	minBitrate?: number;
	maxBitrate?: number;
	bitrateSelectionMode?: "OPTIMIZED" | "COMPLEXITY_RANGE";
	lowComplexityBoundaryForMaxBitrate?: number;
	highComplexityBoundaryForMaxBitrate?: number;
};

export type PerTitleGoal = {
	strategy: PerTitleStrategy;
	codec: PerTitleCodec;
	minBitrate: number;
	maxBitrate: number;
	minBitrateStepSize?: number;
	maxBitrateStepSize?: number;
	countPolicy: PerTitleCountPolicy;
	rows?: readonly PerTitleGoalRow[];
	inputHeight?: number;
	inputWidth?: number;
	scenarioFractions?: readonly number[];
};

export type PerTitleDiagnostic = {
	code:
		| "model-only"
		| "invalid-global-range"
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
		| "count-unreachable"
		| "extra-rungs-possible"
		| "count-not-guaranteed"
		| "complexity-analysis-required"
		| "upscale-required"
		| "step-adjusted"
		| "linear-illustration"
		| "scenario-range-bound"
		| "model-limit";
	severity: "info" | "warning" | "conflict";
	message: string;
	rowIds?: string[];
	values?: Record<string, number | string>;
};

export type PerTitleApiSettings = {
	global: {
		minBitrate: number;
		maxBitrate: number;
		minBitrateStepSize: number;
		maxBitrateStepSize: number;
		autoRepresentations?: Record<string, never>;
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
			minBitrate: number;
			maxBitrate: number;
			bitrateSelectionMode: "OPTIMIZED" | "COMPLEXITY_RANGE";
			lowComplexityBoundaryForMaxBitrate?: number;
			highComplexityBoundaryForMaxBitrate?: number;
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
	id: "baseline" | "step-adjusted";
	codec: PerTitleCodec;
	status: "candidate" | "conflict";
	applicable: boolean;
	evidence: "model-only";
	countGuarantee: false;
	api: PerTitleApiSettings;
	scenarios: PerTitleScenario[];
	diagnostics: PerTitleDiagnostic[];
};

/** Returns arithmetic examples and API candidates, without making provider requests. */
export function proposePerTitleSettings(
	goal: PerTitleGoal,
): PerTitleProposal[] {
	const baseline = buildProposal(goal, "baseline");
	if (baseline.diagnostics.some((item) => inputErrorCodes.has(item.code))) {
		return [baseline];
	}
	const desiredCount =
		goal.countPolicy.kind === "unrestricted"
			? isClosedStrategy(goal.strategy)
				? goal.rows?.length
				: undefined
			: goal.countPolicy.count;
	if (!desiredCount || desiredCount < 1 || desiredCount > MAX_MODEL_RUNGS) {
		return [baseline];
	}
	const rows = orderedRows(goal);
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
	if (
		Math.abs(minimumStep - (goal.minBitrateStepSize ?? DEFAULT_MIN_STEP)) <
			1e-10 &&
		Math.abs(maximumStep - (goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP)) <
			1e-10
	) {
		return [baseline];
	}
	const adjusted = buildProposal(
		{
			...goal,
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
		},
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

const DEFAULT_MIN_STEP = 1.5;
const DEFAULT_MAX_STEP = 1.9;
const MAX_MODEL_RUNGS = 256;
const MAX_ROWS = 64;
const MAX_SCENARIOS = 9;
const EPSILON = 1e-10;

const inputErrorCodes = new Set<PerTitleDiagnostic["code"]>([
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
	if (goal.strategy !== "fixed-ranges") return globalCapacity;
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
	if (
		rows.length > MAX_ROWS ||
		(goal.scenarioFractions?.length ?? 0) > MAX_SCENARIOS
	) {
		conflict(
			"model-limit",
			"This model supports up to 64 rows and 9 scenarios.",
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
): PerTitleProposal {
	const minimumStep = goal.minBitrateStepSize ?? DEFAULT_MIN_STEP;
	const maximumStep = goal.maxBitrateStepSize ?? DEFAULT_MAX_STEP;
	const rows = orderedRows(goal);
	const diagnostics = validateGoal(goal);
	const api: PerTitleApiSettings = {
		global: {
			minBitrate: goal.minBitrate,
			maxBitrate: goal.maxBitrate,
			minBitrateStepSize: minimumStep,
			maxBitrateStepSize: maximumStep,
			...(!isClosedStrategy(goal.strategy) ? { autoRepresentations: {} } : {}),
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
							minBitrate: row.minBitrate as number,
							maxBitrate: row.maxBitrate as number,
							bitrateSelectionMode: row.bitrateSelectionMode ?? "OPTIMIZED",
							...(row.bitrateSelectionMode === "COMPLEXITY_RANGE"
								? {
										lowComplexityBoundaryForMaxBitrate:
											row.lowComplexityBoundaryForMaxBitrate,
										highComplexityBoundaryForMaxBitrate:
											row.highComplexityBoundaryForMaxBitrate,
									}
								: {}),
						},
					}
				: {}),
		})),
	};
	if (!isClosedStrategy(goal.strategy)) {
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
	diagnostics.push({
		code: "model-only",
		severity: "info",
		message:
			"Examples use interval spacing and an explicitly linear illustration of complexity boundaries. They do not reproduce content analysis or predict provider output.",
	});
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
			message:
				"Source analysis is unknown. Complexity examples use only the stated hypothetical target and an illustrative linear interpolation.",
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
	if (!invalid && !choosePoints(ranges, minimumStep, Number.MAX_VALUE, 0)) {
		diagnostics.push({
			code: "row-step-conflict",
			severity: "conflict",
			message:
				"The required rows cannot fit their intervals while preserving the minimum bitrate step.",
		});
	} else if (!invalid && !choosePoints(ranges, minimumStep, maximumStep, 0)) {
		diagnostics.push({
			code: "row-gap-conflict",
			severity: "conflict",
			message:
				"Connecting the required rows needs a larger maximum step or additional bitrate points.",
		});
	}
	if (!invalid && modelCapacity(goal, ranges, minimumStep) > MAX_MODEL_RUNGS) {
		diagnostics.push({
			code: "model-limit",
			severity: "conflict",
			message:
				"The spacing bound exceeds the model's 256-point limit. Increase the minimum step to inspect a smaller model.",
		});
	}
	if (!invalid && goal.countPolicy.kind !== "unrestricted") {
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
	const applicable = !diagnostics.some((item) => item.severity === "conflict");
	const canModel = !diagnostics.some(
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
				diagnostics: diagnostics.filter((item) => item.severity === "conflict"),
			};
		}
		return buildScenario(goal, rows, ranges, fraction, scenarioId);
	});
	return {
		id,
		codec: goal.codec,
		status: applicable ? "candidate" : "conflict",
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
		const lastBitrate = Math.min(
			assumedMaxBitrate,
			goal.minBitrate * maximumStep ** (selectedCount - 1),
		);
		const exampleStep =
			selectedCount > 1
				? (lastBitrate / goal.minBitrate) ** (1 / (selectedCount - 1))
				: 1;
		for (let index = 0; index < selectedCount; index++) {
			modelRungs.push({
				bitrate: Math.min(
					assumedMaxBitrate,
					Math.round(goal.minBitrate * exampleStep ** index),
				),
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
				rowIds: [rows[index - 1]?.id, rows[index]?.id].filter(
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
