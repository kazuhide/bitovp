import {
	type PerTitleGoal,
	type PerTitleProposal,
	perTitleDimensionAxis,
} from "@bitovp/core";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";

export type PerTitleCountStructureAssessment = {
	scope: "declared-structure";
	status: "declared-compatible" | "conflict" | "unknown" | "not-applicable";
	required: number | null;
	declaredCount: number | null;
	fixedRowIds: readonly string[];
	lower: { rowIds: readonly string[]; required: number } | null;
	upper: {
		rowIds: readonly string[];
		required: number;
		selection: "one-of" | "none";
	} | null;
	intermediateRowIds: readonly string[];
	/** Continuous G*s^2 spacing threshold, not an integer or native count proof. */
	lowerReuseThreshold: number | null;
	blockers: readonly string[];
	risks: readonly string[];
	nativeCount: "requires-media";
};

type Stream = PerTitleProposal["api"]["streams"][number];
const FIXED = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";
const ORDINARY = "PER_TITLE_TEMPLATE";
const rate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= 2_147_483_647;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Match an explicit count requirement to declared template roles. This does not
 * promote the requirement, template count, or arithmetic capacity to output proof.
 * The supported mixed declaration has required fixed rows, one lower ordinary
 * role, and one upper role with ordinary alternatives plus an explicit fallback.
 */
export function assessPerTitleCountStructure(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleCountStructureAssessment {
	const result: PerTitleCountStructureAssessment = {
		scope: "declared-structure",
		status: "unknown",
		required:
			goal?.countPolicy?.kind !== "unrestricted" &&
			rate(goal?.countPolicy?.count)
				? goal.countPolicy.count
				: null,
		declaredCount: null,
		fixedRowIds: [],
		lower: null,
		upper: null,
		intermediateRowIds: [],
		lowerReuseThreshold: null,
		blockers: [],
		risks: ["native-count-requires-media"],
		nativeCount: "requires-media",
	};
	const unknown = (code: string) => ({ ...result, blockers: [code] });
	try {
		if (
			goal?.strategy !== "fixed-ranges" ||
			goal.countPolicy.kind === "unrestricted"
		)
			return { ...result, status: "not-applicable" };
		if (
			!record(proposal?.api) ||
			!record(proposal.api.global) ||
			!Array.isArray(proposal.api.streams) ||
			proposal.api.streams.length > 64
		)
			return unknown("invalid-count-structure-input");
		const { global, streams } = proposal.api;
		if (
			streams.some(
				(stream) =>
					!record(stream) ||
					typeof stream.rowId !== "string" ||
					!stream.rowId ||
					(stream.height !== undefined && !rate(stream.height)) ||
					(stream.width !== undefined && !rate(stream.width)),
			) ||
			new Set(streams.map((stream) => stream.rowId)).size !== streams.length
		)
			return unknown("invalid-template-identities");
		const fixed = streams.filter((stream) => stream.mode === FIXED);
		const ordinary = streams.filter((stream) => stream.mode === ORDINARY);
		result.fixedRowIds = fixed.map((stream) => stream.rowId);
		if (!ordinary.length) return { ...result, status: "not-applicable" };
		if (result.required === null) return unknown("invalid-count-requirement");
		if (result.required < fixed.length)
			return {
				...result,
				status: "conflict",
				blockers: ["required-fixed-count-exceeded"],
			};
		if (goal.countPolicy.kind !== "exact")
			return unknown("mixed-exact-count-required");
		if (
			!rate(global.minBitrate) ||
			!rate(global.maxBitrate) ||
			global.minBitrate > global.maxBitrate ||
			global.minBitrate !== goal.minBitrate ||
			global.maxBitrate !== goal.maxBitrate ||
			proposal.codec !== goal.codec
		)
			return unknown("settings-mismatch");
		if (global.autoRepresentations !== undefined)
			return unknown("automatic-generation-unresolved");
		if (
			!Number.isFinite(global.minBitrateStepSize) ||
			global.minBitrateStepSize <= 1 ||
			!Number.isFinite(global.maxBitrateStepSize) ||
			global.maxBitrateStepSize < global.minBitrateStepSize
		)
			return unknown("invalid-bitrate-step");
		if (
			!fixed.length ||
			fixed.length !== (goal.rows?.length ?? 0) ||
			fixed.length + ordinary.length !== streams.length ||
			fixed.some((stream) => {
				const value = stream.perTitleSettings;
				return (
					!rate(value?.minBitrate) ||
					!rate(value?.maxBitrate) ||
					value.minBitrate > value.maxBitrate ||
					value.minBitrate < global.minBitrate ||
					value.maxBitrate > global.maxBitrate
				);
			})
		)
			return unknown("fixed-ranges-unresolved");
		const matchesSource = (
			stream: Stream,
			source: { id: string; height?: number; width?: number } | undefined,
		) =>
			source !== undefined &&
			stream.height === source.height &&
			stream.width === source.width;
		if (
			ordinary.length !== (goal.automaticTemplates?.length ?? 0) ||
			fixed.some(
				(stream) =>
					!matchesSource(
						stream,
						goal.rows?.find((row) => row.id === stream.rowId),
					),
			) ||
			ordinary.some(
				(stream) =>
					!matchesSource(
						stream,
						goal.automaticTemplates?.find((row) => row.id === stream.rowId),
					),
			)
		)
			return unknown("template-roles-mismatch");
		const basis = perTitleDimensionAxis(streams);
		if (!basis) return unknown("mixed-resolution-order-unresolved");
		const ordered = [...fixed].sort(
			(a, b) =>
				(a[basis] as number) - (b[basis] as number) ||
				(a.perTitleSettings?.minBitrate ?? 0) -
					(b.perTitleSettings?.minBitrate ?? 0) ||
				a.rowId.localeCompare(b.rowId),
		);
		result.fixedRowIds = ordered.map((stream) => stream.rowId);
		const first = ordered[0] as Stream;
		const last = ordered.at(-1) as Stream;
		const lower = ordinary.filter(
			(stream) => (stream[basis] as number) < (first[basis] as number),
		);
		const upper = ordinary.filter(
			(stream) => (stream[basis] as number) > (last[basis] as number),
		);
		const intermediate = ordinary.filter(
			(stream) => !lower.includes(stream) && !upper.includes(stream),
		);
		result.lower = lower.length
			? { rowIds: lower.map((stream) => stream.rowId), required: 1 }
			: null;
		result.intermediateRowIds = intermediate.map((stream) => stream.rowId);
		const rule = global.fixedResolutionAndBitrateConfiguration;
		const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
		const singleUpperRule =
			rule?.forcedRenditionAboveHighestFixedRepresentation === 1 &&
			rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
				"LAST_CALCULATED_BITRATE" &&
			typeof factor === "number" &&
			Number.isFinite(factor) &&
			factor > 1;
		if (upper.length && singleUpperRule)
			result.upper = {
				rowIds: upper.map((stream) => stream.rowId),
				required: 1,
				selection: "one-of",
			};
		const blockers = [
			...(lower.length !== 1 ? ["lower-role-unresolved"] : []),
			...(!upper.length ? ["upper-role-unresolved"] : []),
			...(!singleUpperRule ? ["upper-rule-unresolved"] : []),
			...(intermediate.length
				? ["intermediate-ordinary-roles-unresolved"]
				: []),
		];
		if (blockers.length) return { ...result, blockers };
		result.declaredCount = fixed.length + 1 + 1;
		if (result.declaredCount !== result.required)
			return unknown("declared-role-count-mismatch");
		// This necessary continuous threshold describes two lower ratio steps.
		// Integer placement is assessed separately, and neither determines native
		// probe-dependent selection, repeated ordinary use, or fallback execution.
		const threshold = global.minBitrate * global.minBitrateStepSize ** 2;
		result.lowerReuseThreshold = Number.isFinite(threshold) ? threshold : null;
		const ladder = assessPerTitleLadder(goal, proposal);
		const risks = [
			"native-count-requires-media",
			"lower-ordinary-reuse",
			"forced-addition-is-fallback",
			...(upper.length > 1 ? ["upper-choice-requires-analysis"] : []),
			...(ladder.lowerSlots === null
				? ["lower-placement-unresolved"]
				: ladder.lowerSlots.maximum > 1
					? ["lower-extra-slot-capacity"]
					: []),
			...(ladder.upperSlots === null
				? ["upper-placement-unresolved"]
				: ladder.upperSlots.maximum > 1
					? ["upper-extra-slot-capacity"]
					: []),
		];
		const intervals = ladder.intervals;
		if (!intervals) risks.push("fixed-row-count-unproved");
		else {
			if (intervals.maximumWithinRowRatio >= global.minBitrateStepSize)
				risks.push("within-fixed-row-count-unproved");
			if (
				(intervals.minimumAdjacentRatio ?? Infinity) <
					global.minBitrateStepSize ||
				(intervals.maximumAdjacentRatio ?? 0) > global.maxBitrateStepSize
			)
				risks.push("fixed-adjacent-count-unproved");
		}
		return { ...result, status: "declared-compatible", risks };
	} catch {
		return unknown("count-structure-unresolved");
	}
}
