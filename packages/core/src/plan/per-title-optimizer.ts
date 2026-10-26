import {
	type BitrateInterval,
	certifyComplexityIntervals,
	evaluateComplexityRange,
	evaluateForcedRenditions,
} from "./per-title-constraints";
import { perTitleDimensionAxis } from "./per-title-dimensions";
import {
	certifyPerTitleMixedSequence,
	type PerTitleMixedSequenceCertificate,
} from "./per-title-mixed-sequence";
import type {
	PerTitleGoal,
	PerTitleGoalRow,
	PerTitleProposal,
	PerTitleScenario,
} from "./per-title-simulator.js";

export type PerTitleConstraintAnalysis = {
	status: "checked" | "unknown";
	scope: "closed-ladder" | "conditional";
	conditionalModel?: PerTitleMixedSequenceCertificate;
	inputRange: BitrateInterval | null;
	floorRange: BitrateInterval | null;
	calibration?: {
		low: number;
		high: number;
		rowIds: string[];
		origin?: {
			kind: "fixed-minimum-step";
			minimumBitrate: number;
			minimumStep: number;
		};
	};
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

export const perTitleGlobalLockKeys = new Set([
	"minBitrate",
	"maxBitrate",
	"minBitrateStepSize",
	"maxBitrateStepSize",
	"targetQualityCrf",
	"targetQualityQp",
	"complexityFactor",
	"resolutionScaleFactor",
	"codecMinBitrateFactor",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
	"autoRepresentations",
	"autoRepresentations.adoptConfigurationThreshold",
	...[
		"forcedRenditionAboveHighestFixedRepresentation",
		"forcedRenditionAboveHighestFixedRepresentationFactor",
		"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
	].map((key) => `fixedResolutionAndBitrateConfiguration.${key}`),
]);
export const perTitleStreamLockKeys = new Set([
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
]);
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const globalLocks = (goal: PerTitleGoal): readonly string[] =>
	Array.isArray(goal.settingLocks?.global)
		? goal.settingLocks.global.filter((key) => typeof key === "string")
		: [];
const streamLocks = (goal: PerTitleGoal, id: string): readonly string[] => {
	const streams = goal.settingLocks?.streams;
	const keys =
		record(streams) && Object.hasOwn(streams, id) ? streams[id] : undefined;
	return Array.isArray(keys)
		? keys.filter((key): key is string => typeof key === "string")
		: [];
};
export function validPerTitleSettingLocks(value: unknown): boolean {
	if (value === undefined) return true;
	if (
		!record(value) ||
		Object.keys(value).some((key) => key !== "global" && key !== "streams")
	)
		return false;
	if (
		value.global !== undefined &&
		(!Array.isArray(value.global) ||
			value.global.some(
				(key) => typeof key !== "string" || !perTitleGlobalLockKeys.has(key),
			))
	)
		return false;
	return (
		value.streams === undefined ||
		(record(value.streams) &&
			Object.values(value.streams).every(
				(keys) =>
					Array.isArray(keys) &&
					keys.every(
						(key) => typeof key === "string" && perTitleStreamLockKeys.has(key),
					),
			))
	);
}
export const perTitleGlobalLocked = (goal: PerTitleGoal, key: string) =>
	perTitleGlobalLockKeys.has(key) && globalLocks(goal).includes(key);
export const perTitleStreamLocked = (
	goal: PerTitleGoal,
	id: string,
	key: string,
) => perTitleStreamLockKeys.has(key) && streamLocks(goal, id).includes(key);

/** Restore constraints on candidate inputs before any API or scenario is built. */
export function applyPerTitleSettingLocks(
	candidate: PerTitleGoal,
	original: PerTitleGoal,
): PerTitleGoal {
	if (!original.settingLocks) return candidate;
	const next = { ...candidate };
	for (const key of globalLocks(original)) {
		if (!perTitleGlobalLockKeys.has(key)) continue;
		const [parent, child] = key.split(".");
		if (!parent) continue;
		const source = original as unknown as Record<string, unknown>;
		const target = next as unknown as Record<string, unknown>;
		if (child) {
			const value = (source[parent] as Record<string, unknown> | undefined)?.[
				child
			];
			const nested =
				typeof target[parent] === "object" && target[parent] !== null
					? { ...(target[parent] as Record<string, unknown>) }
					: {};
			if (value === undefined) delete nested[child];
			else nested[child] = value;
			if (Object.keys(nested).length || typeof source[parent] === "object")
				target[parent] = nested;
			else delete target[parent];
		} else if (source[parent] === undefined) delete target[parent];
		else target[parent] = structuredClone(source[parent]);
	}
	const restoreRows = <T extends { id: string }>(
		rows: readonly T[] | undefined,
		source: readonly T[] | undefined,
	) =>
		rows?.map((row) => {
			const before = source?.find((item) => item.id === row.id);
			if (!before) return row;
			const nextRow = { ...row };
			for (const key of streamLocks(original, row.id)) {
				if (!perTitleStreamLockKeys.has(key)) continue;
				const value = (before as Record<string, unknown>)[key];
				if (value === undefined)
					delete (nextRow as Record<string, unknown>)[key];
				else (nextRow as Record<string, unknown>)[key] = value;
			}
			return nextRow;
		});
	next.rows = restoreRows(candidate.rows, original.rows);
	next.automaticTemplates = restoreRows(
		candidate.automaticTemplates,
		original.automaticTemplates,
	);
	// A single fixed endpoint still permits the other spacing endpoint to move.
	if (
		perTitleGlobalLocked(original, "maxBitrateStepSize") &&
		!perTitleGlobalLocked(original, "minBitrateStepSize") &&
		next.maxBitrateStepSize !== undefined &&
		next.maxBitrateStepSize > 1 &&
		(next.minBitrateStepSize ?? Infinity) > next.maxBitrateStepSize
	)
		next.minBitrateStepSize = next.maxBitrateStepSize;
	if (
		perTitleGlobalLocked(original, "minBitrateStepSize") &&
		!perTitleGlobalLocked(original, "maxBitrateStepSize") &&
		next.minBitrateStepSize !== undefined &&
		next.minBitrateStepSize > 1 &&
		(next.maxBitrateStepSize ?? 0) < next.minBitrateStepSize
	)
		next.maxBitrateStepSize = next.minBitrateStepSize;
	return next;
}
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
			(row.mode === undefined ||
				row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE") &&
			(row.height === undefined || positive(row.height)) &&
			(row.width === undefined || positive(row.width)) &&
			(row.height !== undefined || row.width !== undefined) &&
			positive(row.minBitrate) &&
			positive(row.maxBitrate) &&
			row.minBitrate <= row.maxBitrate &&
			row.minBitrate >= goal.minBitrate &&
			row.maxBitrate <= goal.maxBitrate,
	);

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

function mixedCalibration(
	goal: PerTitleGoal,
	rows: RangeRow[],
	minimumStep: number,
	basis: "height" | "width",
) {
	const highest = rows.at(-1);
	const candidates = goal.automaticTemplates ?? [];
	const explicitOnly =
		goal.autoRepresentations === false ||
		(goal.autoRepresentations === undefined &&
			perTitleGlobalLocked(goal, "autoRepresentations"));
	if (
		!highest ||
		!explicitOnly ||
		rows.filter((row) => row[basis] === highest[basis]).length !== 1 ||
		!candidates.every((row) => positive(row[basis])) ||
		!candidates.some(
			(row) => (row[basis] as number) > (highest[basis] as number),
		)
	)
		return undefined;
	// This is a calibration recommendation, separate from the encoder's lower limit.
	return {
		low: Math.trunc(highest.minBitrate * minimumStep),
		origin: {
			kind: "fixed-minimum-step" as const,
			minimumBitrate: highest.minBitrate,
			minimumStep,
		},
	};
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
	const mixed = mixedCalibration(goal, rows, s, basis);
	const calibrationLow = mixed?.low ?? floor.maximum;
	const generated: string[] = [];
	const calibrated = rows.map((row) => {
		if (row.bitrateSelectionMode === "OPTIMIZED") return { ...row };
		const hasBound =
			row.lowComplexityBoundaryForMaxBitrate !== undefined ||
			row.highComplexityBoundaryForMaxBitrate !== undefined;
		const calibrationLocked = [
			"bitrateSelectionMode",
			"lowComplexityBoundaryForMaxBitrate",
			"highComplexityBoundaryForMaxBitrate",
		].some((key) => perTitleStreamLocked(goal, row.id, key));
		if (
			hasBound &&
			(!calibrationLocked ||
				(row.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
					row.lowComplexityBoundaryForMaxBitrate !== undefined &&
					row.highComplexityBoundaryForMaxBitrate !== undefined))
		)
			return { ...row };
		const candidate = {
			...row,
			bitrateSelectionMode:
				row.bitrateSelectionMode ?? ("COMPLEXITY_RANGE" as const),
			lowComplexityBoundaryForMaxBitrate:
				row.lowComplexityBoundaryForMaxBitrate ?? calibrationLow,
			highComplexityBoundaryForMaxBitrate:
				row.highComplexityBoundaryForMaxBitrate ?? goal.maxBitrate,
		};
		const restored = applyPerTitleSettingLocks(
			{ ...goal, rows: [candidate] },
			goal,
		).rows?.[0] as RangeRow;
		if (
			(row.lowComplexityBoundaryForMaxBitrate === undefined ||
				row.highComplexityBoundaryForMaxBitrate === undefined) &&
			restored.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
			restored.lowComplexityBoundaryForMaxBitrate === calibrationLow &&
			restored.highComplexityBoundaryForMaxBitrate === goal.maxBitrate
		)
			generated.push(row.id);
		return restored;
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
			? {
					low: calibrationLow,
					high: goal.maxBitrate,
					rowIds: generated,
					...(mixed ? { origin: mixed.origin } : {}),
				}
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

function clearCountEvidence(
	proposal: PerTitleProposal,
	report: PerTitleConstraintAnalysis,
) {
	report.status = "unknown";
	if (proposal.derivation) {
		proposal.derivation.constraints = report;
		proposal.derivation.targetSatisfied = false;
		delete proposal.derivation.desiredCount;
		delete proposal.derivation.minimumStepRange;
		delete proposal.derivation.integerWitness;
	}
	proposal.scenarios = proposal.scenarios.map((scenario) => ({
		...scenario,
		status: "unknown",
		modelCountRange: null,
	}));
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
	const proposal = optimizeConstraintTrial(goal, recommendIntervals);
	const conditionalModel = certifyPerTitleMixedSequence(goal, proposal.api);
	if (
		conditionalModel &&
		proposal.codec === goal.codec &&
		proposal.derivation?.constraints &&
		!proposal.diagnostics.some((item) => item.severity === "conflict")
	) {
		const report = proposal.derivation.constraints;
		report.status = "checked";
		report.scope = "conditional";
		report.conditionalModel = conditionalModel;
		report.inputRange = conditionalModel.inputRange;
		report.spacing = {
			minimumExclusive:
				conditionalModel.spacing.maximumWithinRowRatio + STEP_TOLERANCE,
			maximumInclusive: conditionalModel.spacing.minimumAdjacentRatio,
			checkedSegments: conditionalModel.spacing.checkedSegments,
		};
		report.forced.conditional = true;
		report.conditions.push(
			"The mixed sequence count is conditional on the unmeasured lower-probe interval and resolution/probe ordering in conditionalModel.sourceConditions.",
			"The upper ordinary result and the one forced fallback occupy alternative branches of one upper role.",
		);
		proposal.applicable = true;
		proposal.status = "candidate";
		proposal.derivation.targetSatisfied = true;
		proposal.derivation.fixedOrderRowIds = conditionalModel.fixedRowIds;
		proposal.derivation.rationale =
			"The fixed intervals and both upper branches satisfy the requested sequence under the explicit, unmeasured source conditions. Actual encoded count and quality remain unverified.";
		proposal.diagnostics = proposal.diagnostics.filter(
			(item) =>
				item.code !== "row-order-unknown" &&
				item.code !== "forced-count-unknown",
		);
		proposal.diagnostics.push({
			code: "count-not-guaranteed",
			severity: "warning",
			message:
				"This mixed count is a conditional model. Measure the lower probe and verify resolution ordering and the encoded output before relying on the count.",
		});
	}
	const report = proposal.derivation?.constraints;
	if (report) {
		const originalRule = goal.fixedResolutionAndBitrateConfiguration;
		const global = proposal.api.global;
		const emittedRule = global.fixedResolutionAndBitrateConfiguration;
		// API edits remain observable even when the trial's count proof is discarded.
		report.changes = (
			[
				["minimumStep", goal.minBitrateStepSize, global.minBitrateStepSize],
				["maximumStep", goal.maxBitrateStepSize, global.maxBitrateStepSize],
				[
					"forcedCount",
					originalRule?.forcedRenditionAboveHighestFixedRepresentation,
					emittedRule?.forcedRenditionAboveHighestFixedRepresentation,
				],
				[
					"forcedFactor",
					originalRule?.forcedRenditionAboveHighestFixedRepresentationFactor,
					emittedRule?.forcedRenditionAboveHighestFixedRepresentationFactor,
				],
				[
					"forcedMode",
					originalRule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
					emittedRule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode,
				],
			] satisfies Array<
				[
					PerTitleConstraintAnalysis["changes"][number]["field"],
					number | string | undefined,
					number | string | undefined,
				]
			>
		).flatMap(([field, before, after]) =>
			Object.is(before, after) ? [] : [{ field, before, after }],
		);
	}
	return proposal;
}

function optimizeConstraintTrial(
	goal: PerTitleGoal,
	recommendIntervals: (goal: PerTitleGoal) => PerTitleProposal,
): PerTitleProposal {
	const fallback = recommendIntervals(goal);
	if (!validRows(goal)) return fallback;
	const deferredBoundary = (
		diagnostic: PerTitleProposal["diagnostics"][number],
	) =>
		diagnostic.code === "invalid-complexity-range" &&
		(diagnostic.rowIds?.length ?? 0) > 0 &&
		diagnostic.rowIds?.every((id) => {
			const row = goal.rows.find((item) => item.id === id);
			if (
				row?.bitrateSelectionMode !== "COMPLEXITY_RANGE" ||
				![
					"bitrateSelectionMode",
					"lowComplexityBoundaryForMaxBitrate",
					"highComplexityBoundaryForMaxBitrate",
				].some((key) => perTitleStreamLocked(goal, id, key))
			)
				return false;
			const low = row.lowComplexityBoundaryForMaxBitrate;
			const high = row.highComplexityBoundaryForMaxBitrate;
			return (
				(low === undefined || high === undefined) &&
				(low === undefined
					? !perTitleStreamLocked(
							goal,
							id,
							"lowComplexityBoundaryForMaxBitrate",
						)
					: positive(low)) &&
				(high === undefined
					? !perTitleStreamLocked(
							goal,
							id,
							"highComplexityBoundaryForMaxBitrate",
						)
					: positive(high))
			);
		}) === true;
	if (
		fallback.diagnostics.some(
			(d) =>
				!deferredBoundary(d) &&
				[
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
					"upscale-required",
					"model-limit",
				].includes(d.code),
		)
	)
		return fallback;
	const basis = perTitleDimensionAxis([
		...goal.rows,
		...(goal.automaticTemplates ?? []).filter(
			(row) => row.height !== undefined || row.width !== undefined,
		),
	]);
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
	const bounded =
		closed &&
		(goal.countPolicy.kind === "exact" ||
			goal.countPolicy.kind === "maximum") &&
		Number.isSafeInteger(goal.countPolicy.count) &&
		goal.countPolicy.count >= rows.length &&
		goal.countPolicy.count <= 256;
	const saved = goal.fixedResolutionAndBitrateConfiguration;
	const disabledRule =
		saved?.forcedRenditionAboveHighestFixedRepresentation === 0
			? structuredClone(saved)
			: undefined;
	const unrestrictedAuthoring =
		goal.countPolicy.kind === "unrestricted" &&
		(saved === undefined ||
			saved.forcedRenditionAboveHighestFixedRepresentation === 0);
	const forcedKey = (key: string) =>
		`fixedResolutionAndBitrateConfiguration.${key}`;
	const countLocked = perTitleGlobalLocked(
		goal,
		forcedKey("forcedRenditionAboveHighestFixedRepresentation"),
	);
	const factorLocked = perTitleGlobalLocked(
		goal,
		forcedKey("forcedRenditionAboveHighestFixedRepresentationFactor"),
	);
	const modeLocked = perTitleGlobalLocked(
		goal,
		forcedKey("forcedRenditionAboveHighestFixedRepresentationCalculationMode"),
	);
	const minimumLocked = perTitleGlobalLocked(goal, "minBitrateStepSize");
	const maximumLocked = perTitleGlobalLocked(goal, "maxBitrateStepSize");
	const n =
		exact && !countLocked
			? (goal.countPolicy as { count: number }).count - rows.length
			: (saved?.forcedRenditionAboveHighestFixedRepresentation ?? 0);
	const savedFactor =
		saved?.forcedRenditionAboveHighestFixedRepresentationFactor;
	const savedMode =
		saved?.forcedRenditionAboveHighestFixedRepresentationCalculationMode;
	const mode =
		exact && n && !modeLocked ? "LAST_CALCULATED_BITRATE" : savedMode;
	const limit = factorLimit(top.maxBitrate, n, goal.maxBitrate);
	let factor =
		factorLocked && n
			? (savedFactor ?? NaN)
			: exact && n
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
		saved.forcedRenditionAboveHighestFixedRepresentation === 0 ||
		(exact &&
			(!n ||
				((!factorLocked || savedFactor !== undefined) &&
					(!modeLocked || savedMode !== undefined)))) ||
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
		return goal.settingLocks ? unproven(fallback) : fallback;
	let s = fallback.api.global.minBitrateStepSize;
	let maximum = fallback.api.global.maxBitrateStepSize;
	let prepared = complete ? prepare(goal, rows, s, n, factor, basis) : null;
	let certificate = prepared
		? certifyComplexityIntervals(curves(prepared.rows), prepared.input, s)
		: null;
	let checked = false;
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
		maximum = maximumLocked
			? (goal.maxBitrateStepSize as number)
			: Math.max(s, certificate.maximumAdjacentRatio ?? s);
		if (
			s > lower &&
			maximum >= s &&
			(certificate.maximumAdjacentRatio === undefined ||
				maximum >= certificate.maximumAdjacentRatio) &&
			(upper === undefined || s <= upper) &&
			rows.every((row) => Math.round(row.minBitrate * s) > row.minBitrate) &&
			(!n ||
				(factor > 1 &&
					limit !== undefined &&
					factor <= limit &&
					Math.round(top.minBitrate * factor) > top.minBitrate))
		) {
			checked =
				bounded &&
				count > 0 &&
				(exact
					? count === (goal.countPolicy as { count: number }).count
					: count <= (goal.countPolicy as { count: number }).count) &&
				(!n || mode === "LAST_CALCULATED_BITRATE");
			break;
		}
		if (exact && n && !factorLocked && limit && factor !== limit) {
			factor = limit;
		}
		const nextUpper = upper;
		const next = minimumLocked
			? s
			: nextUpper === undefined
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
			conditional: !checked,
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
	if (!closed)
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
	if (!exact && !checked && prepared) {
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
			unrestrictedAuthoring &&
			adopted &&
			!orderUnknown &&
			conditional.applicable &&
			!conditional.diagnostics.some((item) => item.severity === "conflict")
		) {
			return clearCountEvidence(conditional, report);
		}
		return orderUnknown ? unresolvedOrder(conditional) : unproven(conditional);
	}
	if (!checked || !prepared) {
		if (fallback.derivation) {
			fallback.derivation.constraints = report;
		}
		if (tune) unproven(fallback);
		if (exact && prepared && goal.settingLocks) {
			const actual = recommendIntervals(
				applyPerTitleSettingLocks(
					{
						...goal,
						rows: prepared.rows,
						minBitrateStepSize: s,
						maxBitrateStepSize: maximum,
						fixedResolutionAndBitrateConfiguration: n
							? {
									forcedRenditionAboveHighestFixedRepresentation: n,
									forcedRenditionAboveHighestFixedRepresentationFactor: factor,
									forcedRenditionAboveHighestFixedRepresentationCalculationMode:
										mode,
								}
							: disabledRule,
					},
					goal,
				),
			);
			const actualRule =
				actual.api.global.fixedResolutionAndBitrateConfiguration;
			const actualRows = new Map(
				actual.api.streams.map((stream) => [stream.rowId, stream]),
			);
			if (
				actual.api.global.minBitrateStepSize !== s ||
				actual.api.global.maxBitrateStepSize !== maximum ||
				(actualRule
					? actualRule.forcedRenditionAboveHighestFixedRepresentation
					: 0) !== n ||
				(n > 0 &&
					(actualRule?.forcedRenditionAboveHighestFixedRepresentationFactor !==
						factor ||
						actualRule.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
							mode)) ||
				prepared.rows.some((row) => {
					const stream = actualRows.get(row.id);
					const settings = stream?.perTitleSettings;
					return (
						stream?.mode !==
							"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
						stream.height !== row.height ||
						stream.width !== row.width ||
						settings?.minBitrate !== row.minBitrate ||
						settings.maxBitrate !== row.maxBitrate ||
						settings.bitrateSelectionMode !== row.bitrateSelectionMode ||
						settings.lowComplexityBoundaryForMaxBitrate !==
							row.lowComplexityBoundaryForMaxBitrate ||
						settings.highComplexityBoundaryForMaxBitrate !==
							row.highComplexityBoundaryForMaxBitrate
					);
				})
			)
				discardTrial(report, actual);
			if (actual.derivation) {
				actual.derivation.constraints = { ...report, status: "unknown" };
				delete actual.derivation.minimumStepRange;
				delete actual.derivation.integerWitness;
			}
			actual.scenarios = actual.scenarios.map((scenario) => ({
				...scenario,
				status: "unknown",
				modelCountRange: null,
				modelRungs: [],
				rowModels: [],
			}));
			return unproven(actual);
		}
		if (exact && prepared) {
			fallback.api.global.minBitrateStepSize = s;
			fallback.api.global.maxBitrateStepSize = maximum;
			const byId = new Map(prepared.rows.map((row) => [row.id, row]));
			for (const stream of fallback.api.streams) {
				const row = byId.get(stream.rowId);
				if (row)
					stream.perTitleSettings = {
						...stream.perTitleSettings,
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
			else if (disabledRule)
				fallback.api.global.fixedResolutionAndBitrateConfiguration =
					structuredClone(disabledRule);
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
		if (
			unrestrictedAuthoring &&
			!orderUnknown &&
			fallback.applicable &&
			!fallback.diagnostics.some((item) => item.severity === "conflict")
		)
			return clearCountEvidence(fallback, report);
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
	else if (disabledRule)
		result.api.global.fixedResolutionAndBitrateConfiguration =
			structuredClone(disabledRule);
	else delete result.api.global.fixedResolutionAndBitrateConfiguration;
	if (goal.settingLocks) {
		result.api = recommendIntervals(
			applyPerTitleSettingLocks(
				{
					...next,
					fixedResolutionAndBitrateConfiguration: n
						? {
								forcedRenditionAboveHighestFixedRepresentation: n,
								forcedRenditionAboveHighestFixedRepresentationFactor: factor,
								forcedRenditionAboveHighestFixedRepresentationCalculationMode:
									mode,
							}
						: disabledRule,
				},
				goal,
			),
		).api;
		const actual = result.api.global.fixedResolutionAndBitrateConfiguration;
		const actualRows = new Map(
			result.api.streams.map((stream) => [stream.rowId, stream]),
		);
		if (
			result.api.global.minBitrateStepSize !== s ||
			result.api.global.maxBitrateStepSize !== maximum ||
			(actual ? actual.forcedRenditionAboveHighestFixedRepresentation : 0) !==
				n ||
			(n > 0 &&
				(actual?.forcedRenditionAboveHighestFixedRepresentationFactor !==
					factor ||
					actual.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
						mode)) ||
			prepared.rows.some((row) => {
				const settings = actualRows.get(row.id)?.perTitleSettings;
				return (
					settings?.minBitrate !== row.minBitrate ||
					settings.maxBitrate !== row.maxBitrate ||
					settings.bitrateSelectionMode !== row.bitrateSelectionMode ||
					settings.lowComplexityBoundaryForMaxBitrate !==
						row.lowComplexityBoundaryForMaxBitrate ||
					settings.highComplexityBoundaryForMaxBitrate !==
						row.highComplexityBoundaryForMaxBitrate
				);
			})
		) {
			discardTrial(report, result);
			report.status = "unknown";
			if (result.derivation) {
				result.derivation.constraints = report;
				delete result.derivation.minimumStepRange;
				delete result.derivation.integerWitness;
			}
			result.scenarios = result.scenarios.map((scenario) => ({
				...scenario,
				status: "unknown",
				modelCountRange: null,
				modelRungs: [],
				rowModels: [],
			}));
			return unproven(result);
		}
	}
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
				...(row.height !== undefined ? { height: row.height } : {}),
				...(row.width !== undefined ? { width: row.width } : {}),
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
				...(top.height !== undefined ? { height: top.height } : {}),
				...(top.width !== undefined ? { width: top.width } : {}),
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
		desiredCount:
			goal.countPolicy.kind === "unrestricted" ? count : goal.countPolicy.count,
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
