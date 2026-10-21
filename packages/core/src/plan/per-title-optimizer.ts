import {
	type BitrateInterval,
	certifyComplexityIntervals,
	evaluateComplexityRange,
	evaluateForcedRenditions,
} from "./per-title-constraints";
import type {
	PerTitleGoal,
	PerTitleGoalRow,
	PerTitleProposal,
	PerTitleScenario,
} from "./per-title-simulator.js";

export type PerTitleConstraintAnalysis = {
	status: "checked" | "unknown";
	scope: "closed-ladder" | "conditional";
	inputRange: BitrateInterval | null;
	floorRange: BitrateInterval | null;
	calibration?: { low: number; high: number; rowIds: string[] };
	spacing?: {
		minimumExclusive: number;
		maximumInclusive: number | null;
		checkedSegments: number;
	};
	forced: {
		count: number | null;
		factor: number | null;
		calculationMode?: string;
		conditional: boolean;
		maximumFactor?: number;
		ranges: BitrateInterval[];
	};
	changes: Array<{
		field:
			| "minimumStep"
			| "maximumStep"
			| "forcedCount"
			| "forcedFactor"
			| "forcedMode";
		before?: number | string;
		after?: number | string;
	}>;
	checkpoints: Array<{
		input: number;
		rows: Array<{ rowId: string } & BitrateInterval>;
	}>;
	conditions: string[];
};

const STEP_TOLERANCE = 0.01;
const MAX_BITRATE = 2_147_483_647;
const positive = (n: number | undefined): n is number =>
	n !== undefined && Number.isSafeInteger(n) && n > 0 && n <= MAX_BITRATE;
type RangeRow = PerTitleGoalRow & { minBitrate: number; maxBitrate: number };
type CurvedRow = RangeRow & {
	bitrateSelectionMode: "COMPLEXITY_RANGE";
	lowComplexityBoundaryForMaxBitrate: number;
	highComplexityBoundaryForMaxBitrate: number;
};
const validRows = (
	goal: PerTitleGoal,
): goal is PerTitleGoal & { rows: readonly RangeRow[] } =>
	goal.strategy === "fixed-ranges" &&
	positive(goal.minBitrate) &&
	positive(goal.maxBitrate) &&
	goal.minBitrate <= goal.maxBitrate &&
	goal.rows !== undefined &&
	goal.rows.length > 0 &&
	goal.rows.length <= 64 &&
	goal.rows.every(
		(row) =>
			positive(row.height) &&
			positive(row.minBitrate) &&
			positive(row.maxBitrate) &&
			row.minBitrate <= row.maxBitrate &&
			row.minBitrate >= goal.minBitrate &&
			row.maxBitrate <= goal.maxBitrate,
	);

function dimensions(
	rows: readonly PerTitleGoalRow[],
): "height" | "width" | null {
	if (rows.every((row) => row.width === undefined)) return "height";
	if (rows.every((row) => positive(row.width))) return "width";
	return null;
}

function ordered(rows: readonly RangeRow[], basis: "height" | "width") {
	return [...rows].sort(
		(a, b) =>
			(a[basis] as number) - (b[basis] as number) ||
			a.minBitrate - b.minBitrate ||
			a.id.localeCompare(b.id),
	);
}

function floorRange(
	rows: RangeRow[],
	s: number,
	n: number,
	factor: number,
	basis: "height" | "width",
): BitrateInterval | null {
	const last = rows.at(-1);
	if (!last) return null;
	const top = rows.filter((row) => row[basis] === last[basis]);
	const bounds = top.map((row) => {
		const fixedFloor = Math.trunc(row.minBitrate * s ** (top.length - 1));
		return Math.trunc(fixedFloor * factor ** n);
	});
	if (!bounds.every((v) => Number.isSafeInteger(v) && v > 0)) return null;
	return { minimum: Math.min(...bounds), maximum: Math.max(...bounds) };
}

function factorLimit(
	base: number,
	count: number,
	maximum: number,
): number | undefined {
	if (!count || maximum <= base) return undefined;
	let lower = 1;
	let upper = maximum / base + 1;
	for (let i = 0; i < 64; i++) {
		const middle = (lower + upper) / 2;
		const result = evaluateForcedRenditions({
			base: { minimum: base, maximum: base },
			count,
			factor: middle,
		});
		if (result && (result.at(-1)?.maximum ?? Infinity) <= maximum)
			lower = middle;
		else upper = middle;
	}
	return lower > 1 ? lower : undefined;
}

function prepare(
	goal: PerTitleGoal,
	rows: RangeRow[],
	s: number,
	n: number,
	factor: number,
	basis: "height" | "width",
) {
	const floor = floorRange(rows, s, n, factor, basis);
	if (!floor) return null;
	const generated: string[] = [];
	const calibrated = rows.map((row) => {
		if (row.bitrateSelectionMode === "OPTIMIZED") return { ...row };
		if (
			row.lowComplexityBoundaryForMaxBitrate !== undefined ||
			row.highComplexityBoundaryForMaxBitrate !== undefined
		)
			return { ...row };
		generated.push(row.id);
		return {
			...row,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: floor.maximum,
			highComplexityBoundaryForMaxBitrate: goal.maxBitrate,
		};
	});
	const validCurve = (row: RangeRow): row is CurvedRow =>
		row.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
		positive(row.lowComplexityBoundaryForMaxBitrate) &&
		positive(row.highComplexityBoundaryForMaxBitrate) &&
		row.lowComplexityBoundaryForMaxBitrate <
			row.highComplexityBoundaryForMaxBitrate;
	if (!calibrated.every(validCurve)) return null;
	return {
		rows: calibrated,
		floor,
		input: {
			minimum: floor.minimum,
			maximum: Math.max(floor.maximum, goal.maxBitrate),
		},
		calibration: generated.length
			? { low: floor.maximum, high: goal.maxBitrate, rowIds: generated }
			: undefined,
	};
}

function curve(row: CurvedRow) {
	return {
		minimum: row.minBitrate,
		maximum: row.maxBitrate,
		low: row.lowComplexityBoundaryForMaxBitrate,
		high: row.highComplexityBoundaryForMaxBitrate,
	};
}

const curves = (rows: CurvedRow[]) => rows.map(curve);

function unproven(proposal: PerTitleProposal) {
	proposal.applicable = false;
	if (proposal.status === "candidate") proposal.status = "unknown";
	if (proposal.derivation) proposal.derivation.targetSatisfied = false;
	return proposal;
}

function unresolvedOrder(proposal: PerTitleProposal) {
	unproven(proposal);
	proposal.diagnostics.push({
		code: "row-order-unknown",
		severity: "warning",
		message:
			"The resolved dimension and probe ordering is not established by these row inputs.",
	});
	return proposal;
}

function discardTrial(
	report: PerTitleConstraintAnalysis,
	proposal: PerTitleProposal,
) {
	const actual = proposal.api.global.fixedResolutionAndBitrateConfiguration;
	report.inputRange = null;
	report.floorRange = null;
	delete report.calibration;
	delete report.spacing;
	report.forced = {
		count: actual
			? (actual.forcedRenditionAboveHighestFixedRepresentation ?? null)
			: 0,
		factor:
			actual?.forcedRenditionAboveHighestFixedRepresentationFactor ?? null,
		calculationMode:
			actual?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
		conditional: true,
		ranges: [],
	};
	report.changes = [];
	report.checkpoints = [];
}

function checkpoints(rows: CurvedRow[], input: BitrateInterval, s: number) {
	const inputs = new Set([input.minimum, input.maximum]);
	for (const row of rows) {
		for (const v of [
			row.lowComplexityBoundaryForMaxBitrate,
			row.highComplexityBoundaryForMaxBitrate,
		])
			if (v !== undefined && v >= input.minimum && v <= input.maximum)
				inputs.add(v);
	}
	return [...inputs]
		.sort((a, b) => a - b)
		.map((value) => ({
			input: value,
			rows: rows.flatMap((row) => {
				const result = evaluateComplexityRange({
					...curve(row),
					input: value,
					minStep: s,
				});
				return result ? [{ rowId: row.id, ...result }] : [];
			}),
		}));
}

/** Jointly checks a closed fixed-range model; unknown source analysis is an input interval. */
export function optimizePerTitleConstraints(
	goal: PerTitleGoal,
	recommendIntervals: (goal: PerTitleGoal) => PerTitleProposal,
): PerTitleProposal {
	const fallback = recommendIntervals(goal);
	if (!validRows(goal)) return fallback;
	if (
		fallback.diagnostics.some((d) =>
			[
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
				"upscale-required",
				"model-limit",
			].includes(d.code),
		)
	)
		return fallback;
	const basis = dimensions(goal.rows);
	if (!basis) return unresolvedOrder(fallback);
	const rows = ordered(goal.rows, basis);
	const top = rows.at(-1);
	if (!top) return fallback;
	const orderUnknown =
		new Set(rows.map((row) => row[basis])).size !== rows.length;
	const closed = !goal.automaticTemplates?.length;
	const exact =
		closed &&
		goal.countPolicy.kind === "exact" &&
		goal.countPolicy.count >= rows.length &&
		goal.countPolicy.count <= 256;
	const saved = goal.fixedResolutionAndBitrateConfiguration;
	const n = exact
		? (goal.countPolicy as { count: number }).count - rows.length
		: (saved?.forcedRenditionAboveHighestFixedRepresentation ?? 0);
	const savedFactor =
		saved?.forcedRenditionAboveHighestFixedRepresentationFactor;
	const savedMode =
		saved?.forcedRenditionAboveHighestFixedRepresentationCalculationMode;
	const mode = exact && n ? "LAST_CALCULATED_BITRATE" : savedMode;
	const limit = factorLimit(top.maxBitrate, n, goal.maxBitrate);
	let factor =
		exact && n
			? savedFactor &&
				savedFactor > 1 &&
				limit &&
				savedFactor <= limit &&
				savedMode === "LAST_CALCULATED_BITRATE"
				? savedFactor
				: (limit ?? NaN)
			: (savedFactor ?? 1);
	const complete =
		!saved ||
		exact ||
		(savedFactor !== undefined &&
			savedMode !== undefined &&
			saved.forcedRenditionAboveHighestFixedRepresentation !== undefined);
	if (
		!Number.isSafeInteger(n) ||
		n < 0 ||
		n > 256 ||
		!Number.isFinite(factor) ||
		factor <= 0
	)
		return fallback;
	let s = fallback.api.global.minBitrateStepSize;
	let maximum = fallback.api.global.maxBitrateStepSize;
	let prepared = complete ? prepare(goal, rows, s, n, factor, basis) : null;
	let certificate = prepared
		? certifyComplexityIntervals(curves(prepared.rows), prepared.input, s)
		: null;
	let checked = false;
	let rowsChecked = false;
	let lower = 1;
	let upper: number | undefined;
	const count = rows.length + n;
	const tune = goal.countPolicy.kind !== "unrestricted" && complete;
	for (
		let attempt = 0;
		tune && prepared && certificate && attempt < 32;
		attempt++
	) {
		const minimumBitrate = Math.min(...rows.map((row) => row.minBitrate));
		lower = Math.max(
			1 + STEP_TOLERANCE,
			certificate.maximumWithinRowRatio + STEP_TOLERANCE,
			1 + 0.5 / minimumBitrate,
		);
		upper = certificate.minimumAdjacentRatio;
		maximum = Math.max(s, certificate.maximumAdjacentRatio ?? s);
		if (
			s > lower &&
			(upper === undefined || s <= upper) &&
			rows.every((row) => Math.round(row.minBitrate * s) > row.minBitrate) &&
			(!n ||
				(factor > 1 &&
					limit !== undefined &&
					factor <= limit &&
					Math.round(top.minBitrate * factor) > top.minBitrate))
		) {
			rowsChecked = true;
			checked = exact;
			break;
		}
		if (exact && n && limit && factor !== limit) {
			factor = limit;
		}
		const nextUpper = upper;
		const next =
			nextUpper === undefined
				? lower + 1 / minimumBitrate
				: nextUpper > lower
					? Math.sqrt(lower * nextUpper)
					: Math.max(1 + STEP_TOLERANCE, nextUpper);
		if (!Number.isFinite(next) || next <= 1 || next === s) break;
		s = next;
		prepared = prepare(goal, rows, s, n, factor, basis);
		certificate = prepared
			? certifyComplexityIntervals(curves(prepared.rows), prepared.input, s)
			: null;
	}
	if (certificate) {
		const minimumBitrate = Math.min(...rows.map((row) => row.minBitrate));
		lower = Math.max(
			1 + STEP_TOLERANCE,
			certificate.maximumWithinRowRatio + STEP_TOLERANCE,
			1 + 0.5 / minimumBitrate,
		);
		upper = certificate.minimumAdjacentRatio;
	}
	const report: PerTitleConstraintAnalysis = {
		status: checked && !orderUnknown ? "checked" : "unknown",
		scope: closed ? "closed-ladder" : "conditional",
		inputRange: prepared?.input ?? null,
		floorRange: prepared?.floor ?? null,
		calibration: prepared?.calibration,
		...(certificate
			? {
					spacing: {
						minimumExclusive: lower,
						maximumInclusive: upper ?? null,
						checkedSegments: certificate.checkedSegments,
					},
				}
			: {}),
		forced: {
			count: complete ? n : null,
			factor: complete && n ? factor : null,
			calculationMode: n ? mode : undefined,
			conditional: !exact,
			maximumFactor: limit,
			ranges: [],
		},
		changes: [],
		checkpoints: prepared ? checkpoints(prepared.rows, prepared.input, s) : [],
		conditions: [
			basis === "height"
				? "Common source aspect ratio; rows ordered by height and bitrate."
				: "Rows ordered by width and bitrate.",
			"Equal-resolution probe ordering and encoded results require verification.",
			"The certificate checks all effective row intervals, including integer rounding; it does not predict quality.",
			"Additional renditions use their own factor and rounding; ordinary bitrate steps do not constrain them.",
		],
	};
	if (!complete)
		report.conditions.push(
			"Missing additional-rendition fields have no assumed defaults.",
		);
	if (!exact)
		report.conditions.push(
			"Automatic templates and the actual highest-stream branch remain content dependent.",
		);
	if (complete && n > 0 && Number.isFinite(factor)) {
		let base = { minimum: top.minBitrate, maximum: top.maxBitrate };
		if (mode === "MINIMUM")
			base = { minimum: top.minBitrate, maximum: top.minBitrate };
		if (mode === "MAXIMUM")
			base = { minimum: top.maxBitrate, maximum: top.maxBitrate };
		if (mode === "AVERAGE") {
			const average = Math.trunc((top.minBitrate + top.maxBitrate) / 2);
			base = { minimum: average, maximum: average };
		}
		report.forced.ranges =
			evaluateForcedRenditions({ base, count: n, factor }) ?? [];
	}
	if ((exact && prepared) || rowsChecked) {
		for (const [field, before, after] of [
			["minimumStep", goal.minBitrateStepSize, s],
			["maximumStep", goal.maxBitrateStepSize, maximum],
			["forcedCount", saved?.forcedRenditionAboveHighestFixedRepresentation, n],
			["forcedFactor", savedFactor, n ? factor : undefined],
			["forcedMode", savedMode, n ? mode : undefined],
		] as Array<
			[
				PerTitleConstraintAnalysis["changes"][number]["field"],
				number | string | undefined,
				number | string | undefined,
			]
		>)
			if (before !== after) report.changes.push({ field, before, after });
	}
	if (!exact && prepared) {
		const conditional = recommendIntervals({
			...goal,
			rows: prepared.rows,
			minBitrateStepSize: s,
			maxBitrateStepSize: maximum,
		});
		const returnedRows = new Map(
			conditional.api.streams.map((stream) => [stream.rowId, stream]),
		);
		const actualRule =
			conditional.api.global.fixedResolutionAndBitrateConfiguration;
		const adopted =
			conditional.api.global.minBitrate === goal.minBitrate &&
			conditional.api.global.maxBitrate === goal.maxBitrate &&
			conditional.api.global.minBitrateStepSize === s &&
			conditional.api.global.maxBitrateStepSize === maximum &&
			actualRule?.forcedRenditionAboveHighestFixedRepresentation ===
				saved?.forcedRenditionAboveHighestFixedRepresentation &&
			actualRule?.forcedRenditionAboveHighestFixedRepresentationFactor ===
				saved?.forcedRenditionAboveHighestFixedRepresentationFactor &&
			actualRule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
				saved?.forcedRenditionAboveHighestFixedRepresentationCalculationMode &&
			prepared.rows.every((row) => {
				const stream = returnedRows.get(row.id);
				const settings = stream?.perTitleSettings;
				return (
					stream?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
					stream.height === row.height &&
					stream.width === row.width &&
					settings?.minBitrate === row.minBitrate &&
					settings.maxBitrate === row.maxBitrate &&
					settings.bitrateSelectionMode === row.bitrateSelectionMode &&
					settings.lowComplexityBoundaryForMaxBitrate ===
						row.lowComplexityBoundaryForMaxBitrate &&
					settings.highComplexityBoundaryForMaxBitrate ===
						row.highComplexityBoundaryForMaxBitrate
				);
			});
		if (!adopted) discardTrial(report, conditional);
		else {
			report.forced.count = actualRule
				? (actualRule.forcedRenditionAboveHighestFixedRepresentation ?? null)
				: 0;
			report.forced.factor =
				actualRule?.forcedRenditionAboveHighestFixedRepresentationFactor ??
				null;
			report.forced.calculationMode =
				actualRule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode;
		}
		if (conditional.derivation) {
			conditional.derivation.constraints = report;
			conditional.derivation.selectedMinStep =
				conditional.api.global.minBitrateStepSize;
			conditional.derivation.selectedMaxStep =
				conditional.api.global.maxBitrateStepSize;
		}
		if (
			closed &&
			goal.countPolicy.kind === "unrestricted" &&
			saved === undefined &&
			!orderUnknown
		) {
			if (conditional.derivation) {
				conditional.derivation.targetSatisfied = false;
				delete conditional.derivation.desiredCount;
				delete conditional.derivation.minimumStepRange;
				delete conditional.derivation.integerWitness;
			}
			conditional.scenarios = conditional.scenarios.map((scenario) => ({
				...scenario,
				status: "unknown",
				modelCountRange: null,
			}));
			return conditional;
		}
		return orderUnknown ? unresolvedOrder(conditional) : unproven(conditional);
	}
	if (!checked || !prepared) {
		if (fallback.derivation) {
			fallback.derivation.constraints = report;
		}
		if (tune) unproven(fallback);
		if (exact && prepared) {
			fallback.api.global.minBitrateStepSize = s;
			fallback.api.global.maxBitrateStepSize = maximum;
			const byId = new Map(prepared.rows.map((row) => [row.id, row]));
			for (const stream of fallback.api.streams) {
				const row = byId.get(stream.rowId);
				if (row)
					stream.perTitleSettings = {
						minBitrate: row.minBitrate,
						maxBitrate: row.maxBitrate,
						bitrateSelectionMode: row.bitrateSelectionMode,
						lowComplexityBoundaryForMaxBitrate:
							row.lowComplexityBoundaryForMaxBitrate,
						highComplexityBoundaryForMaxBitrate:
							row.highComplexityBoundaryForMaxBitrate,
					};
			}
			if (n)
				fallback.api.global.fixedResolutionAndBitrateConfiguration = {
					forcedRenditionAboveHighestFixedRepresentation: n,
					forcedRenditionAboveHighestFixedRepresentationFactor: factor,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode:
						"LAST_CALCULATED_BITRATE",
				};
			else delete fallback.api.global.fixedResolutionAndBitrateConfiguration;
			fallback.scenarios = fallback.scenarios.map((scenario) => ({
				...scenario,
				status: "unknown",
				modelCountRange: null,
				modelRungs: [],
				rowModels: [],
			}));
			if (fallback.derivation) {
				fallback.derivation.selectedMinStep = s;
				fallback.derivation.selectedMaxStep = maximum;
			}
		} else discardTrial(report, fallback);
		return orderUnknown ? unresolvedOrder(fallback) : fallback;
	}
	const next: PerTitleGoal = {
		...goal,
		rows: prepared.rows,
		minBitrateStepSize: s,
		maxBitrateStepSize: maximum,
		countPolicy: { kind: "exact", count: rows.length },
	};
	delete next.fixedResolutionAndBitrateConfiguration;
	const result = recommendIntervals(next);
	result.api.global.minBitrateStepSize = s;
	result.api.global.maxBitrateStepSize = maximum;
	if (n)
		result.api.global.fixedResolutionAndBitrateConfiguration = {
			forcedRenditionAboveHighestFixedRepresentation: n,
			forcedRenditionAboveHighestFixedRepresentationFactor: factor,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		};
	else delete result.api.global.fixedResolutionAndBitrateConfiguration;
	const selected = prepared;
	const scenarios: PerTitleScenario[] = [];
	const fractions = goal.scenarioFractions?.length
		? goal.scenarioFractions
		: [0.25, 0.5, 1];
	for (const [index, fraction] of fractions.entries()) {
		const input = Math.max(
			selected.floor.maximum,
			Math.round(goal.maxBitrate * fraction),
		);
		const evaluated: Array<{ row: CurvedRow; range: BitrateInterval }> = [];
		for (const row of selected.rows) {
			const range = evaluateComplexityRange({
				...curve(row),
				input,
				minStep: s,
			});
			if (!range) {
				fallback.applicable = false;
				fallback.status = "unknown";
				if (fallback.derivation) fallback.derivation.targetSatisfied = false;
				return fallback;
			}
			evaluated.push({ row, range });
		}
		const points: PerTitleScenario["modelRungs"] = evaluated.map(
			({ row, range }) => ({
				rowId: row.id,
				height: row.height,
				bitrate: range.maximum,
				kind: "required",
			}),
		);
		const lastBitrate = evaluated.at(-1)?.range.maximum;
		if (lastBitrate === undefined) return fallback;
		const extra =
			evaluateForcedRenditions({
				base: {
					minimum: lastBitrate,
					maximum: lastBitrate,
				},
				count: n,
				factor,
			}) ?? [];
		points.push(
			...extra.map((range) => ({
				height: top.height,
				bitrate: range.maximum,
				kind: "illustrative" as const,
			})),
		);
		scenarios.push({
			id: `conditional-${index + 1}`,
			fraction,
			assumedMaxBitrate: goal.maxBitrate,
			status: orderUnknown ? "unknown" : "modelled",
			modelCountRange: orderUnknown ? null : { minimum: count, maximum: count },
			rowModels: evaluated.map(({ row, range }) => ({
				rowId: row.id,
				minimumBitrate: range.minimum,
				maximumBitrate: range.maximum,
				linearTargetBitrate: range.maximum,
				boundaryFraction: null,
			})),
			modelRungs: points,
			diagnostics: [],
		});
	}
	result.scenarios = scenarios;
	result.status = orderUnknown ? "unknown" : "candidate";
	result.applicable = !orderUnknown;
	if (orderUnknown) unresolvedOrder(result);
	result.diagnostics = result.diagnostics.filter(
		(d) =>
			![
				"forced-count-unknown",
				"extra-rungs-possible",
				"count-unreachable",
				"scenario-conflict",
				"row-step-conflict",
				"row-gap-conflict",
				"complexity-analysis-required",
			].includes(d.code),
	);
	result.derivation = {
		method: "joint-constraints",
		desiredCount: count,
		requiredRowCount: rows.length,
		selectedMinStep: s,
		selectedMaxStep: maximum,
		targetSatisfied: !orderUnknown,
		constraints: report,
		rationale:
			"Keep every requested interval. Couple the complexity calibration and spacing, reserve additional-rendition slots, and recheck the selected values over the entire conditional complexity interval. The count certificate assumes the stated template order and is not a provider output guarantee.",
	};
	return result;
}
