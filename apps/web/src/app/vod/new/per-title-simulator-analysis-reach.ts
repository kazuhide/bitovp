import {
	certifyComplexityIntervals,
	evaluateComplexityRange,
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleProposal,
	resolvePerTitleAnalysis,
} from "@bitovp/core";

type Interval = { minimum: number; maximum: number };
type Stream = PerTitleProposal["api"]["streams"][number];
type Global = PerTitleProposal["api"]["global"];
type ForcedRule = NonNullable<Global["fixedResolutionAndBitrateConfiguration"]>;

export type PerTitleReachAssessment = {
	status: "conditional-reachable" | "blocked" | "unknown";
	branch: "fixed" | "direct" | "forced" | "unknown";
	/** Certainty concerns permitted settings under the stated input hypotheses only. */
	certainty: "all-permitted-rates" | "some-permitted-rates" | "unknown";
	cap: number;
	highInput: number;
	lowInput: number;
	high: Interval | null;
	low: Interval | null;
	topFixed: ({ rowId: string } & Interval) | null;
	/** Cap divided by the high-input upper fixed target, not a media prediction. */
	requiredRatio: number | null;
	blockers: readonly string[];
	adaptation: "conditional" | "flat" | "unknown";
	count: {
		status: "model-checked" | "unknown" | "conflict";
		minimum: number | null;
		maximum: number | null;
	};
	scope: "configuration-only";
};

const RATE_MAXIMUM = 2_147_483_647;
const rate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= RATE_MAXIMUM;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const finitePositive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const interval = (value: Interval | null | undefined): value is Interval =>
	!!value &&
	rate(value.minimum) &&
	rate(value.maximum) &&
	value.minimum <= value.maximum;
const modes = new Set([
	"PER_TITLE_TEMPLATE",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
]);
const calculationModes = new Set([
	"LAST_CALCULATED_BITRATE",
	"MINIMUM",
	"MAXIMUM",
	"AVERAGE",
]);
const globalKeys = new Set([
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
	"fixedResolutionAndBitrateConfiguration",
]);
const streamKeys = new Set([
	"rowId",
	"height",
	"width",
	"mode",
	"perTitleSettings",
]);
const settingsKeys = new Set([
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
	"codecMaxBitrateFactor",
	"codecBufsizeFactor",
]);
const forcedKeys = new Set([
	"forcedRenditionAboveHighestFixedRepresentation",
	"forcedRenditionAboveHighestFixedRepresentationFactor",
	"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
]);

function supported(global: Global, streams: Stream[], codec: string) {
	if (
		!new Set(["H264", "H265", "H265V2", "VP9", "AV1"]).has(codec) ||
		Object.keys(global).some((key) => !globalKeys.has(key))
	)
		return false;
	for (const key of [
		"targetQualityCrf",
		"targetQualityQp",
		"complexityFactor",
		"resolutionScaleFactor",
		"codecMinBitrateFactor",
		"codecMaxBitrateFactor",
		"codecBufsizeFactor",
	] as const) {
		const value = global[key];
		if (value === undefined) continue;
		if (
			!Number.isFinite(value) ||
			(key === "targetQualityCrf" && codec === "H265V2") ||
			(key === "targetQualityQp" && codec !== "H265V2") ||
			(key.startsWith("codec") &&
				(codec === "VP9" ||
					codec === "AV1" ||
					(key === "codecBufsizeFactor" && codec === "H265V2"))) ||
			(key === "resolutionScaleFactor" && (value < -15 || value > 15)) ||
			((key === "complexityFactor" || key.startsWith("codec")) && value <= 0)
		)
			return false;
	}
	if (
		global.fixedResolutionAndBitrateConfiguration !== undefined &&
		(!record(global.fixedResolutionAndBitrateConfiguration) ||
			Object.keys(global.fixedResolutionAndBitrateConfiguration).some(
				(key) => !forcedKeys.has(key),
			))
	)
		return false;
	return streams.every((stream) => {
		if (Object.keys(stream).some((key) => !streamKeys.has(key))) return false;
		const settings = stream.perTitleSettings;
		if (settings === undefined) return true;
		if (
			!record(settings) ||
			Object.keys(settings).some((key) => !settingsKeys.has(key))
		)
			return false;
		if (
			settings.bitrateSelectionMode !== undefined &&
			settings.bitrateSelectionMode !== "OPTIMIZED" &&
			settings.bitrateSelectionMode !== "COMPLEXITY_RANGE"
		)
			return false;
		return ["codecMaxBitrateFactor", "codecBufsizeFactor"].every((key) => {
			const value = settings[key as keyof typeof settings];
			return (
				value === undefined ||
				((codec === "H264" || codec === "H265") && finitePositive(value))
			);
		});
	});
}

function rangeAt(
	stream: Stream,
	global: Global,
	input: number,
): Interval | null {
	const settings = stream.perTitleSettings;
	if (
		!settings ||
		!rate(settings.minBitrate) ||
		!rate(settings.maxBitrate) ||
		settings.minBitrate > settings.maxBitrate ||
		settings.minBitrate < global.minBitrate ||
		settings.maxBitrate > global.maxBitrate
	)
		return null;
	if (settings.bitrateSelectionMode !== "COMPLEXITY_RANGE")
		return { minimum: settings.minBitrate, maximum: settings.maxBitrate };
	return evaluateComplexityRange({
		minimum: settings.minBitrate,
		maximum: settings.maxBitrate,
		low: settings.lowComplexityBoundaryForMaxBitrate ?? 0,
		high: settings.highComplexityBoundaryForMaxBitrate ?? 0,
		input,
		minStep: global.minBitrateStepSize,
	});
}

function forcedBase(
	mode: string,
	configured: Interval,
	calculated: Interval,
): Interval {
	if (mode === "MINIMUM")
		return { minimum: configured.minimum, maximum: configured.minimum };
	if (mode === "MAXIMUM")
		return { minimum: configured.maximum, maximum: configured.maximum };
	if (mode === "AVERAGE") {
		const average = Math.trunc((configured.minimum + configured.maximum) / 2);
		return { minimum: average, maximum: average };
	}
	return calculated;
}

function forcedPoints(
	base: Interval,
	count: number,
	factor: number,
): Interval[] | null {
	return evaluateForcedRenditions({ base, count, factor });
}

function directConnection(input: number, base: Interval, global: Global) {
	const robust =
		input / base.maximum >= global.minBitrateStepSize &&
		input / base.minimum <= global.maxBitrateStepSize;
	// Search integer rates using the actual ratio comparison; dividing a floating
	// step back into the input can otherwise lose an admissible boundary by one bit.
	let first = base.minimum;
	let last = base.maximum;
	while (first < last) {
		const middle = first + Math.floor((last - first) / 2);
		if (input / middle <= global.maxBitrateStepSize) last = middle;
		else first = middle + 1;
	}
	return {
		possible:
			robust ||
			(input / first >= global.minBitrateStepSize &&
				input / first <= global.maxBitrateStepSize),
		robust,
	};
}

function countAssessment(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	fixed: Stream[],
	forcedCount: number,
	rule: ForcedRule | undefined,
): PerTitleReachAssessment["count"] {
	const unknown: PerTitleReachAssessment["count"] = {
		status: "unknown",
		minimum: null,
		maximum: null,
	};
	const policy = goal.countPolicy;
	if (
		!policy ||
		(policy.kind !== "unrestricted" &&
			((policy.kind !== "exact" && policy.kind !== "maximum") ||
				!Number.isSafeInteger(policy.count) ||
				policy.count < 1 ||
				policy.count > 256))
	)
		return { ...unknown, status: "conflict" };
	if (policy.kind === "unrestricted") return unknown;
	const report = proposal.derivation?.constraints;
	if (
		proposal.api.streams.some(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		) ||
		proposal.diagnostics.some(
			(diagnostic) => diagnostic.code === "row-order-unknown",
		) ||
		proposal.status !== "candidate" ||
		!proposal.applicable ||
		proposal.derivation?.targetSatisfied !== true ||
		report?.status !== "checked" ||
		report.scope !== "closed-ladder" ||
		!interval(report.inputRange) ||
		!interval(report.floorRange) ||
		!record(report.forced) ||
		report.inputRange.maximum < proposal.api.global.maxBitrate ||
		report.forced.count !== forcedCount ||
		(forcedCount > 0 &&
			(report.forced.factor !==
				rule?.forcedRenditionAboveHighestFixedRepresentationFactor ||
				report.forced.calculationMode !== "LAST_CALCULATED_BITRATE" ||
				rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
					"LAST_CALCULATED_BITRATE"))
	)
		return unknown;
	const curves = fixed.map((stream) => ({
		minimum: stream.perTitleSettings?.minBitrate ?? 0,
		maximum: stream.perTitleSettings?.maxBitrate ?? 0,
		low: stream.perTitleSettings?.lowComplexityBoundaryForMaxBitrate ?? 0,
		high: stream.perTitleSettings?.highComplexityBoundaryForMaxBitrate ?? 0,
	}));
	if (
		fixed.some(
			(stream) =>
				stream.perTitleSettings?.bitrateSelectionMode !== "COMPLEXITY_RANGE",
		)
	)
		return unknown;
	if (
		new Set(fixed.map((stream) => stream.width ?? stream.height)).size !==
		fixed.length
	)
		return unknown;
	const global = proposal.api.global;
	const certificate = certifyComplexityIntervals(
		curves,
		{
			minimum: Math.min(global.minBitrate, report.inputRange.minimum),
			maximum: Math.max(global.maxBitrate, report.inputRange.maximum),
		},
		global.minBitrateStepSize,
	);
	if (
		!certificate ||
		curves.some(
			(row) =>
				Math.round(row.minimum * global.minBitrateStepSize) <= row.minimum,
		) ||
		global.minBitrateStepSize <= certificate.maximumWithinRowRatio ||
		(certificate.minimumAdjacentRatio !== undefined &&
			global.minBitrateStepSize > certificate.minimumAdjacentRatio) ||
		(certificate.maximumAdjacentRatio !== undefined &&
			global.maxBitrateStepSize < certificate.maximumAdjacentRatio)
	)
		return unknown;
	const count = fixed.length + forcedCount;
	const upper = proposal.scenarios.filter(
		(scenario) => scenario.fraction === 1,
	);
	if (
		upper.length !== 1 ||
		upper[0]?.status !== "modelled" ||
		upper[0].modelCountRange?.minimum !== count ||
		upper[0].modelCountRange.maximum !== count ||
		upper[0].modelRungs.length !== count
	)
		return unknown;
	return {
		status:
			count > policy.count ||
			(policy.kind === "exact" && count !== policy.count)
				? "conflict"
				: "model-checked",
		minimum: count,
		maximum: count,
	};
}

/**
 * Checks settings under explicit high=cap and low=minimum input hypotheses.
 * It does not predict analysis inputs, selected resolutions, quality, or measured bandwidth.
 */
export function assessPerTitleReach(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleReachAssessment {
	const cap = rate(goal?.maxBitrate) ? goal.maxBitrate : 0;
	const lowInput = rate(goal?.minBitrate) ? goal.minBitrate : 0;
	const result: PerTitleReachAssessment = {
		status: "unknown",
		branch: "unknown",
		certainty: "unknown",
		cap,
		highInput: cap,
		lowInput,
		high: null,
		low: null,
		topFixed: null,
		requiredRatio: null,
		blockers: [],
		adaptation: "unknown",
		count: { status: "unknown", minimum: null, maximum: null },
		scope: "configuration-only",
	};
	const unknown = (code: string) => ({ ...result, blockers: [code] });
	try {
		if (!record(proposal?.api) || !record(proposal.api.global))
			return unknown("invalid-global-range");
		const { global, streams } = proposal.api;
		if (
			!rate(global.minBitrate) ||
			!rate(global.maxBitrate) ||
			global.minBitrate > global.maxBitrate ||
			!cap ||
			!lowInput
		)
			return unknown("invalid-global-range");
		if (
			global.minBitrate !== lowInput ||
			global.maxBitrate !== cap ||
			proposal.codec !== goal.codec
		)
			return unknown("settings-mismatch");
		if (
			!finitePositive(global.minBitrateStepSize) ||
			global.minBitrateStepSize <= 1 ||
			!finitePositive(global.maxBitrateStepSize) ||
			global.maxBitrateStepSize < global.minBitrateStepSize
		)
			return unknown("invalid-step");
		if (
			!Array.isArray(streams) ||
			!streams.length ||
			streams.length > 64 ||
			streams.some(
				(stream) =>
					!record(stream) ||
					typeof stream.rowId !== "string" ||
					!stream.rowId ||
					!modes.has(stream.mode) ||
					(stream.height !== undefined && !rate(stream.height)) ||
					(stream.width !== undefined && !rate(stream.width)),
			) ||
			new Set(streams.map((stream) => stream.rowId)).size !== streams.length
		)
			return unknown("invalid-streams");
		if (!supported(global, streams, goal.codec))
			return unknown("unsupported-settings");
		if (global.autoRepresentations !== undefined)
			return unknown("automatic-generation-unresolved");
		const basis = streams.every(
			(stream) => stream.width === undefined && rate(stream.height),
		)
			? "height"
			: streams.every((stream) => rate(stream.width))
				? "width"
				: null;
		if (!basis) return unknown("unresolved-order");
		const fixed = streams
			.filter((stream) => stream.mode !== "PER_TITLE_TEMPLATE")
			.sort(
				(a, b) =>
					(a[basis] as number) - (b[basis] as number) ||
					(a.perTitleSettings?.minBitrate ?? 0) -
						(b.perTitleSettings?.minBitrate ?? 0),
			);
		if (!fixed.length) return unknown("automatic-templates-unresolved");
		if (
			fixed.some(
				(stream) =>
					stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			)
		)
			return unknown("fixed-bitrate-unresolved");
		const top = fixed.at(-1);
		if (
			!top ||
			fixed.filter((stream) => stream[basis] === top[basis]).length !== 1
		)
			return unknown("unresolved-order");
		const rule = global.fixedResolutionAndBitrateConfiguration;
		const count =
			rule?.forcedRenditionAboveHighestFixedRepresentation ?? (rule ? NaN : 0);
		const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
		const mode =
			rule?.forcedRenditionAboveHighestFixedRepresentationCalculationMode;
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > 256 ||
			(factor !== undefined && !finitePositive(factor)) ||
			(mode !== undefined && !calculationModes.has(mode)) ||
			(count > 0 &&
				(!finitePositive(factor) || !mode || !calculationModes.has(mode)))
		)
			return unknown("forced-settings-incomplete");
		const highAnalysis = resolvePerTitleAnalysis(proposal.api, cap);
		const lowAnalysis = resolvePerTitleAnalysis(proposal.api, lowInput);
		const evaluated = fixed.map((stream) => ({
			stream,
			high: rangeAt(stream, global, highAnalysis.complexityInput ?? 0),
			low: rangeAt(stream, global, lowAnalysis.complexityInput ?? 0),
		}));
		if (evaluated.some((row) => !row.high || !row.low)) {
			const malformedCurve = fixed.some((stream) => {
				const settings = stream.perTitleSettings;
				return (
					settings?.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
					(!rate(settings.lowComplexityBoundaryForMaxBitrate) ||
						!rate(settings.highComplexityBoundaryForMaxBitrate) ||
						settings.lowComplexityBoundaryForMaxBitrate >=
							settings.highComplexityBoundaryForMaxBitrate)
				);
			});
			return unknown(
				malformedCurve ? "invalid-complexity-range" : "invalid-row-range",
			);
		}
		const highBase = evaluated.at(-1)?.high;
		const lowBase = evaluated.at(-1)?.low;
		if (!highBase || !lowBase) return unknown("invalid-row-range");
		if (
			evaluated
				.slice(0, -1)
				.some(
					(row) =>
						(row.high?.maximum ?? Infinity) >= highBase.minimum ||
						(row.low?.maximum ?? Infinity) >= lowBase.minimum,
				)
		)
			return unknown("unresolved-order");
		result.topFixed = { rowId: top.rowId, ...highBase };
		result.requiredRatio = cap / highBase.maximum;
		const automatic = streams.filter(
			(stream) => stream.mode === "PER_TITLE_TEMPLATE",
		);
		const upper = automatic.filter(
			(stream) => (stream[basis] as number) > (top[basis] as number),
		);
		if (new Set(upper.map((stream) => stream[basis])).size !== upper.length)
			return unknown("unresolved-order");
		if (automatic.length && !upper.length)
			return unknown("automatic-templates-unresolved");
		const settings = top.perTitleSettings;
		const configured = {
			minimum: settings?.minBitrate ?? 0,
			maximum: settings?.maxBitrate ?? 0,
		};
		const blockers: string[] = [];
		if (count > 0 && factor !== undefined && mode) {
			const base = forcedBase(mode, configured, configured);
			const points = forcedPoints(base, count, factor);
			if (!points || points.some((point) => point.maximum > cap))
				blockers.push("forced-cap-exceeded");
			if (
				points?.some((point, index) => {
					if (index === 0 && mode !== "LAST_CALCULATED_BITRATE")
						return point.minimum <= configured.maximum;
					const previous = points[index - 1] ?? base;
					return (
						point.minimum <= previous.minimum ||
						point.maximum <= previous.maximum
					);
				})
			)
				blockers.push("forced-not-increasing");
		}
		const fallback = (base: Interval) => {
			if (!count || factor === undefined || !mode) return base;
			const points = forcedPoints(
				forcedBase(mode, configured, base),
				count,
				factor,
			);
			// Forced points extend the ladder; they never remove its existing fixed top.
			return (
				points?.reduce(
					(highest, point) => ({
						minimum: Math.max(highest.minimum, point.minimum),
						maximum: Math.max(highest.maximum, point.maximum),
					}),
					base,
				) ?? null
			);
		};
		const at = (input: number, base: Interval) => {
			const connection = upper.length
				? directConnection(input, base, global)
				: null;
			const remaining = fallback(base);
			if (connection?.robust)
				return { range: { minimum: input, maximum: input }, connection };
			if (connection?.possible && remaining)
				return {
					range: {
						minimum: Math.min(input, remaining.minimum),
						maximum: Math.max(input, remaining.maximum),
					},
					connection,
				};
			return { range: remaining, connection };
		};
		const high = at(cap, highBase);
		const low = at(lowInput, lowBase);
		result.high = high.range;
		result.low = low.range;
		result.branch = high.connection?.possible
			? "direct"
			: count
				? "forced"
				: "fixed";
		if (high.connection && !high.connection.possible) {
			if (cap / highBase.maximum > global.maxBitrateStepSize)
				blockers.push("gap-too-wide");
			else if (cap / highBase.minimum < global.minBitrateStepSize)
				blockers.push("gap-too-narrow");
			else blockers.push("gap-integer-placement");
		}
		result.count = countAssessment(goal, proposal, fixed, count, rule);
		if (result.count.status === "conflict") blockers.push("count-conflict");
		if (high.range && low.range) {
			if (high.range.minimum > low.range.maximum)
				result.adaptation = "conditional";
			else if (
				high.range.minimum === high.range.maximum &&
				low.range.minimum === low.range.maximum &&
				high.range.minimum === low.range.minimum
			)
				result.adaptation = "flat";
		}
		if (
			high.range?.maximum === cap &&
			!blockers.some((code) => code.startsWith("forced-"))
		) {
			result.status = "conditional-reachable";
			result.certainty =
				high.range.minimum === cap
					? "all-permitted-rates"
					: "some-permitted-rates";
			if (result.certainty === "some-permitted-rates")
				blockers.push("high-input-selection-dependent");
		} else {
			result.status = "blocked";
			if (!high.connection?.possible && high.range && high.range.maximum < cap)
				blockers.push(count ? "forced-top-below-cap" : "fixed-top-below-cap");
		}
		result.blockers = [...new Set(blockers)];
		return result;
	} catch {
		return unknown("invalid-streams");
	}
}
