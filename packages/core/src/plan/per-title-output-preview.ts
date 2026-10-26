import {
	evaluateComplexityRange,
	evaluateForcedRenditions,
} from "./per-title-constraints";
import { perTitleDimensionAxis } from "./per-title-dimensions";
import { resolvePerTitleAnalysis } from "./per-title-output-analysis";
import { projectIntegerBitrateSlots } from "./per-title-output-count";
import type {
	PerTitleApiSettings,
	PerTitleCountPolicy,
	PerTitleProposal,
} from "./per-title-simulator.js";

type PreviewRow = {
	id: string;
	rowId?: string;
	height?: number;
	width?: number;
	mode?: PerTitleApiSettings["streams"][number]["mode"];
	kind:
		| "fixed"
		| "automatic"
		| "automatic-group"
		| "count-slot"
		| "additional"
		| "unassigned";
	status: "example" | "conditional" | "unknown";
	basis?: "minimum" | "forced" | "analysis" | "count";
	rangeBasis?: "effective" | "configured" | "assumed" | "spacing";
	ordinal?: number;
	candidateRowIds?: string[];
	bitrate?: number;
	minimumBitrate?: number;
	maximumBitrate?: number;
};

export type PerTitleOutputPreview = {
	/** Hypothetical analysis cap, limited by the emitted global maximum. */
	analysisInput: number | null;
	requestedAnalysisInput: number | null;
	/** Fixed-stream constraints can raise the input used by complexity interpolation. */
	floor: number | null;
	complexityInput: number | null;
	usesAspectRatioAssumption: boolean;
	status: "example" | "partial" | "unavailable";
	rows: PreviewRow[];
	unresolvedAdditional: boolean;
	/** Conditional placements only; their count is not a native output guarantee. */
	countProjection?: {
		kind: "exact" | "maximum";
		requestedCount: number;
		status: "conditional" | "infeasible" | "unavailable";
		reason?:
			| "invalid-count"
			| "model-limit"
			| "invalid-input"
			| "unsupported-configuration"
			| "integer-chain-infeasible"
			| "maximum-only";
	};
	/** Alternative only: applies when normal calculation ends on a fixed output. */
	forcedFallback?: {
		baseMinimumBitrate: number;
		baseMaximumBitrate: number;
		minimumBitrate: number;
		maximumBitrate: number;
		count: number;
		factor: number;
	};
};

const positive = (value: number | undefined): value is number =>
	value !== undefined &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= 2_147_483_647;

/** Show parameter-derived intervals, never spacing witnesses as encoded outputs. */
export function previewPerTitleOutput(
	proposal: PerTitleProposal,
	options: { analysisInput?: number; countPolicy?: PerTitleCountPolicy } = {},
): PerTitleOutputPreview {
	const global = proposal.api.global;
	const streams = proposal.api.streams;
	const requested = options.analysisInput ?? global.maxBitrate;
	const requestedAnalysisInput = positive(requested) ? requested : null;
	const validGlobal =
		positive(global.minBitrate) &&
		positive(global.maxBitrate) &&
		global.minBitrate <= global.maxBitrate;
	const analysisInput =
		validGlobal && requestedAnalysisInput !== null
			? Math.min(requestedAnalysisInput, global.maxBitrate)
			: null;
	const validSteps =
		Number.isFinite(global.minBitrateStepSize) &&
		global.minBitrateStepSize > 1 &&
		Number.isFinite(global.maxBitrateStepSize) &&
		global.maxBitrateStepSize >= global.minBitrateStepSize;
	const eligible =
		validGlobal &&
		analysisInput !== null &&
		validSteps &&
		streams.length > 0 &&
		streams.length <= 64 &&
		new Set(streams.map((s) => s.rowId)).size === streams.length &&
		streams.every(
			(s) =>
				typeof s.rowId === "string" &&
				s.rowId.length > 0 &&
				(s.height === undefined || positive(s.height)) &&
				(s.width === undefined || positive(s.width)),
		);
	const automatic = streams.filter((s) => s.mode === "PER_TITLE_TEMPLATE");
	const fixed = streams.filter((s) => s.mode !== "PER_TITLE_TEMPLATE");
	const expanded = global.autoRepresentations !== undefined;
	const rule = global.fixedResolutionAndBitrateConfiguration;
	const count = rule?.forcedRenditionAboveHighestFixedRepresentation;
	const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
	const analysis = resolvePerTitleAnalysis(
		proposal.api,
		eligible ? analysisInput : null,
	);
	const rangeFor = (stream: PerTitleApiSettings["streams"][number]) => {
		if (
			!eligible ||
			(!positive(stream.height) && !positive(stream.width)) ||
			(stream.width !== undefined && !positive(stream.width))
		)
			return null;
		if (stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION")
			return { minimum: global.minBitrate, maximum: global.maxBitrate };
		const settings = stream.perTitleSettings;
		if (
			stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
			!positive(settings?.minBitrate) ||
			!positive(settings.maxBitrate) ||
			settings.minBitrate > settings.maxBitrate ||
			settings.minBitrate < global.minBitrate ||
			settings.maxBitrate > global.maxBitrate
		)
			return null;
		if (settings.bitrateSelectionMode !== "COMPLEXITY_RANGE")
			return { minimum: settings.minBitrate, maximum: settings.maxBitrate };
		if (
			!positive(settings.lowComplexityBoundaryForMaxBitrate) ||
			!positive(settings.highComplexityBoundaryForMaxBitrate) ||
			analysis.complexityInput === null
		)
			return null;
		return evaluateComplexityRange({
			minimum: settings.minBitrate,
			maximum: settings.maxBitrate,
			low: settings.lowComplexityBoundaryForMaxBitrate,
			high: settings.highComplexityBoundaryForMaxBitrate,
			input: analysis.complexityInput,
			minStep: global.minBitrateStepSize,
		});
	};
	const ranges = new Map(
		fixed.map((stream) => [stream.rowId, rangeFor(stream)]),
	);
	const closedSingle = streams.length === 1 && fixed.length === 1 && !expanded;
	const rows: PreviewRow[] = streams.map((stream, index) => {
		const row: PreviewRow = {
			id: `stream:${index}:${stream.rowId}`,
			rowId: stream.rowId,
			...(positive(stream.height) ? { height: stream.height } : {}),
			...(positive(stream.width) ? { width: stream.width } : {}),
			mode: stream.mode,
			kind: stream.mode === "PER_TITLE_TEMPLATE" ? "automatic" : "fixed",
			status: "unknown",
		};
		if (row.kind === "automatic") return row;
		const range = ranges.get(stream.rowId);
		if (!range) return row;
		const effective =
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
			stream.perTitleSettings?.bitrateSelectionMode === "COMPLEXITY_RANGE";
		// A closed narrow interval starts at its lower endpoint; there is no room for a second ordinary step.
		const narrow =
			closedSingle &&
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
			range.maximum / range.minimum < global.minBitrateStepSize - 0.01;
		return {
			...row,
			status: "conditional",
			rangeBasis: effective ? "effective" : "configured",
			minimumBitrate: range.minimum,
			maximumBitrate: range.maximum,
			...(range.minimum === range.maximum || narrow
				? { bitrate: range.minimum }
				: {}),
		};
	});
	const validFixed = fixed.every((stream) => ranges.get(stream.rowId) !== null);
	// This band represents an analysis assumption, not one rendition or a forecast of the intermediate ladder.
	if (
		eligible &&
		validFixed &&
		automatic.length > 0 &&
		(expanded || fixed.length === 0)
	) {
		for (let i = rows.length - 1; i >= 0; i--)
			if (rows[i]?.kind === "automatic") rows.splice(i, 1);
		rows.push({
			id: "automatic:range",
			kind: "automatic-group",
			status: "conditional",
			basis: "analysis",
			rangeBasis: "assumed",
			minimumBitrate: global.minBitrate,
			maximumBitrate: Math.max(global.minBitrate, analysisInput as number),
		});
	}
	let countProjection: PerTitleOutputPreview["countProjection"];
	const policy = options.countPolicy;
	if (
		fixed.length === 0 &&
		automatic.length === streams.length &&
		(policy?.kind === "exact" || policy?.kind === "maximum")
	) {
		countProjection = {
			kind: policy.kind,
			requestedCount: policy.count,
			status: "unavailable",
		};
		if (!Number.isSafeInteger(policy.count) || policy.count < 1)
			countProjection.reason = "invalid-count";
		else if (policy.count > 256) countProjection.reason = "model-limit";
		else if (policy.kind === "maximum") countProjection.reason = "maximum-only";
		else if (!eligible || analysis.complexityInput === null)
			countProjection.reason = "invalid-input";
		else if (rule !== undefined && count !== 0)
			countProjection.reason = "unsupported-configuration";
		else {
			const projection = projectIntegerBitrateSlots({
				minimumBitrate: global.minBitrate,
				ceiling: analysis.complexityInput,
				minimumStep: global.minBitrateStepSize,
				maximumStep: global.maxBitrateStepSize,
				count: policy.count,
			});
			countProjection.status = projection.status;
			if (projection.status === "conditional") {
				rows.splice(
					0,
					rows.length,
					...projection.slots.map(
						(slot, index): PreviewRow => ({
							id: `count:slot:${index + 1}`,
							kind: "count-slot",
							status: "conditional",
							basis: "count",
							rangeBasis: "spacing",
							ordinal: index + 1,
							minimumBitrate: slot.minimum,
							maximumBitrate: slot.maximum,
						}),
					),
				);
			} else countProjection.reason = projection.reason;
		}
	}
	const basis = perTitleDimensionAxis(streams);
	const explicitMixed =
		eligible &&
		validFixed &&
		automatic.length > 0 &&
		!expanded &&
		basis !== null &&
		fixed.length > 0;
	let topCandidates: typeof streams = [];
	if (explicitMixed && basis) {
		const ordered = [...streams].sort(
			(a, b) => (a[basis] as number) - (b[basis] as number),
		);
		const firstFixed = ordered.find((s) => s.mode !== "PER_TITLE_TEMPLATE");
		const firstRanges = fixed
			.filter((s) => s[basis] === firstFixed?.[basis])
			.map((s) => ranges.get(s.rowId));
		const lowerCandidates = ordered.filter(
			(s) =>
				s.mode === "PER_TITLE_TEMPLATE" &&
				(s[basis] as number) <= (firstFixed?.[basis] as number),
		);
		const first = rows.find((r) => r.rowId === lowerCandidates[0]?.rowId);
		if (
			lowerCandidates.length === 1 &&
			first &&
			firstRanges.length > 0 &&
			firstRanges.every(
				(range) =>
					range &&
					Math.floor(range.minimum / global.minBitrateStepSize) >=
						global.minBitrate,
			)
		)
			Object.assign(first, {
				basis: "minimum",
				status: "conditional",
				bitrate: global.minBitrate,
				minimumBitrate: global.minBitrate,
				maximumBitrate: global.minBitrate,
				rangeBasis: "effective",
			});
		const dimension = Math.max(...fixed.map((s) => s[basis] as number));
		topCandidates = ordered.filter(
			(s) =>
				s.mode === "PER_TITLE_TEMPLATE" && (s[basis] as number) > dimension,
		);
		const upperMinimum = Math.ceil(
			Math.max(
				...fixed.map((stream) => ranges.get(stream.rowId)?.minimum ?? 0),
			) *
				(global.minBitrateStepSize - 0.01),
		);
		if (topCandidates.length > 0 && (analysisInput as number) >= upperMinimum) {
			const ids = topCandidates.map((s) => s.rowId);
			for (let i = rows.length - 1; i >= 0; i--)
				if (ids.includes(rows[i]?.rowId ?? "")) rows.splice(i, 1);
			rows.push({
				id: "analysis:upper-range",
				kind: "automatic-group",
				status: "conditional",
				basis: "analysis",
				rangeBasis: "assumed",
				candidateRowIds: ids,
				minimumBitrate: upperMinimum,
				maximumBitrate: Math.max(global.minBitrate, analysisInput as number),
			});
		}
	}
	const ordinaryUpper = rows.some(
		(row) => row.kind === "automatic-group" && row.basis === "analysis",
	);
	const fixedRows = rows.filter((row) => row.kind === "fixed");
	const highest = [...fixedRows].sort(
		(a, b) => (b.maximumBitrate ?? 0) - (a.maximumBitrate ?? 0),
	)[0];
	const orderedFixed =
		highest &&
		positive(highest.minimumBitrate) &&
		positive(highest.maximumBitrate) &&
		fixedRows.every(
			(row) =>
				row === highest ||
				(positive(row.maximumBitrate) &&
					row.maximumBitrate < (highest.minimumBitrate as number)),
		);
	let forcedFallback: PerTitleOutputPreview["forcedFallback"];
	const hasBitrateConstraint = fixed.some(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	if (
		eligible &&
		validFixed &&
		orderedFixed &&
		highest &&
		hasBitrateConstraint &&
		count !== undefined &&
		Number.isSafeInteger(count) &&
		count > 0 &&
		count <= 256 &&
		factor !== undefined &&
		Number.isFinite(factor) &&
		factor > 0
	) {
		const stream = fixed.find((s) => s.rowId === highest.rowId);
		const settings = stream?.perTitleSettings;
		const mode =
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode;
		let base = {
			minimum: highest.bitrate ?? (highest.minimumBitrate as number),
			maximum: highest.bitrate ?? (highest.maximumBitrate as number),
		};
		const nominal =
			settings && positive(settings.minBitrate) && positive(settings.maxBitrate)
				? settings
				: null;
		if (nominal && mode === "MINIMUM")
			base = {
				minimum: nominal.minBitrate as number,
				maximum: nominal.minBitrate as number,
			};
		else if (nominal && mode === "MAXIMUM")
			base = {
				minimum: nominal.maxBitrate as number,
				maximum: nominal.maxBitrate as number,
			};
		else if (nominal && mode === "AVERAGE") {
			const midpoint = Math.floor(
				((nominal.minBitrate as number) + (nominal.maxBitrate as number)) / 2,
			);
			base = { minimum: midpoint, maximum: midpoint };
		}
		const validMode =
			mode === "LAST_CALCULATED_BITRATE" ||
			mode === "MINIMUM" ||
			mode === "MAXIMUM" ||
			mode === "AVERAGE";
		const extra = validMode
			? evaluateForcedRenditions({ base, count, factor })
			: null;
		const last = extra?.at(-1);
		if (last) {
			forcedFallback = {
				baseMinimumBitrate: base.minimum,
				baseMaximumBitrate: base.maximum,
				minimumBitrate: last.minimum,
				maximumBitrate: last.maximum,
				count,
				factor,
			};
			// Ordinary upper output and the forced fallback are alternative branches.
			// Candidate dimensions do not identify the selected output resolution.
			if (
				!expanded &&
				!ordinaryUpper &&
				(automatic.length === 0 || topCandidates.length > 0)
			) {
				const candidateIds = new Set(topCandidates.map((s) => s.rowId));
				// These prototypes are possible destinations for the forced roles,
				// rather than additional outputs alongside those roles.
				for (let i = rows.length - 1; i >= 0; i--)
					if (
						rows[i]?.kind === "automatic" &&
						candidateIds.has(rows[i]?.rowId ?? "")
					)
						rows.splice(i, 1);
				for (const [index, range] of (extra ?? []).entries())
					rows.push({
						id: `forced:${index}`,
						kind: "additional",
						status: "conditional",
						basis: "forced",
						rangeBasis: "effective",
						...(topCandidates.length
							? { candidateRowIds: topCandidates.map((s) => s.rowId) }
							: {}),
						minimumBitrate: range.minimum,
						maximumBitrate: range.maximum,
						...(range.minimum === range.maximum
							? { bitrate: range.minimum }
							: {}),
					});
			}
		}
	}
	const singleRange = fixed[0] ? ranges.get(fixed[0].rowId) : null;
	const singleRenditionProven =
		closedSingle &&
		fixed[0]?.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
		singleRange !== null &&
		singleRange !== undefined &&
		singleRange.maximum / singleRange.minimum <
			global.minBitrateStepSize - 0.01;
	const unresolvedAdditional =
		// Per-row points do not prove that a multi-row ladder is feasible or closed.
		fixedRows.length > 1 ||
		automatic.length > 0 ||
		expanded ||
		fixedRows.some(
			(row) =>
				row.status === "unknown" ||
				(!singleRenditionProven &&
					(row.minimumBitrate !== row.maximumBitrate ||
						global.minBitrateStepSize <= 1.01)),
		) ||
		(rule !== undefined && count !== 0 && forcedFallback === undefined);
	return {
		analysisInput,
		requestedAnalysisInput,
		...analysis,
		status: rows.some(
			(row) => row.minimumBitrate !== undefined || row.bitrate !== undefined,
		)
			? "partial"
			: "unavailable",
		rows,
		unresolvedAdditional,
		...(countProjection ? { countProjection } : {}),
		...(forcedFallback ? { forcedFallback } : {}),
	};
}
