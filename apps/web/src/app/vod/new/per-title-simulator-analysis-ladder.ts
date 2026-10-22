import {
	certifyComplexityDirectConnection,
	certifyComplexityIntervals,
	evaluateComplexityRange,
	type PerTitleGoal,
	type PerTitleProposal,
} from "@bitovp/core";
import { assessPerTitleReach } from "./per-title-simulator-analysis-reach";

type Interval = { minimum: number; maximum: number };
type Curve = Interval & { low: number; high: number };
type Stream = PerTitleProposal["api"]["streams"][number];
export type PerTitleLadderAssessment = {
	input: Interval;
	rows: Array<{
		rowId: string;
		mode: Stream["mode"];
		height?: number;
		width?: number;
		configured: Interval | null;
		low: Interval | null;
		high: Interval | null;
	}>;
	intervals: ReturnType<typeof certifyComplexityIntervals>;
	earlySaturationRows: string[];
	/** Arithmetic placement capacity only, never a prediction of output count. */
	globalCapacity: number | null;
	lowerSlots: Interval | null;
	lowerConnection: { maximumRatio: number; fitsMaximum: boolean } | null;
	upperSlots: Interval | null;
	topResponse: {
		status: "tracked" | "gap" | "unknown" | "not-applicable";
		domain: Interval | null;
		floor: number | null;
		witnessInput: number | null;
		checkedSegments: number;
	};
};

const rate = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function perTitleAnalysisCurve(stream: Stream): Curve | null {
	const value = stream.perTitleSettings;
	return value?.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
		rate(value.minBitrate) &&
		rate(value.maxBitrate) &&
		value.minBitrate <= value.maxBitrate &&
		rate(value.lowComplexityBoundaryForMaxBitrate) &&
		rate(value.highComplexityBoundaryForMaxBitrate) &&
		value.lowComplexityBoundaryForMaxBitrate <
			value.highComplexityBoundaryForMaxBitrate
		? {
				minimum: value.minBitrate,
				maximum: value.maxBitrate,
				low: value.lowComplexityBoundaryForMaxBitrate,
				high: value.highComplexityBoundaryForMaxBitrate,
			}
		: null;
}

/** Count the integer points that could fit at a minimum ratio, not native outputs. */
export function perTitlePlacementCapacity(
	minimum: number,
	maximum: number,
	step: number,
): number | null {
	if (
		!rate(minimum) ||
		!rate(maximum) ||
		maximum < minimum ||
		!Number.isFinite(step) ||
		step <= 1
	)
		return null;
	let previous = minimum;
	for (let count = 1; count <= 256; count++) {
		let next = Math.ceil(previous * step);
		if (!Number.isSafeInteger(next) || next <= previous) return null;
		// Honour the actual floating ratio predicate at a multiplication boundary.
		if (next / previous < step) next++;
		if ((next - 1) / previous >= step) next--;
		if (next > maximum) return count;
		previous = next;
	}
	return null;
}

/** Whole input interval and every configured template, without resolving media analysis. */
export function assessPerTitleLadder(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleLadderAssessment {
	const global = proposal.api.global;
	const input = { minimum: global.minBitrate, maximum: global.maxBitrate };
	const at = (stream: Stream, value: number): Interval | null => {
		if (stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
			return null;
		const curve = perTitleAnalysisCurve(stream);
		if (curve)
			return evaluateComplexityRange({
				...curve,
				input: value,
				minStep: global.minBitrateStepSize,
			});
		const setting = stream.perTitleSettings;
		return rate(setting?.minBitrate) &&
			rate(setting?.maxBitrate) &&
			setting.minBitrate <= setting.maxBitrate
			? { minimum: setting.minBitrate, maximum: setting.maxBitrate }
			: null;
	};
	const fixed = proposal.api.streams.filter(
		(stream) =>
			stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	const basis = fixed.every(
		(stream) => stream.width === undefined && rate(stream.height),
	)
		? "height"
		: fixed.every((stream) => stream.width !== undefined && rate(stream.width))
			? "width"
			: null;
	const ordered = basis
		? [...fixed].sort(
				(a, b) =>
					(a[basis] ?? 0) - (b[basis] ?? 0) ||
					(a.perTitleSettings?.minBitrate ?? 0) -
						(b.perTitleSettings?.minBitrate ?? 0),
			)
		: [];
	const curves = ordered.map(perTitleAnalysisCurve);
	const reach = assessPerTitleReach(goal, proposal);
	const top = fixed.find((stream) => stream.rowId === reach.topFixed?.rowId);
	const curve = top && perTitleAnalysisCurve(top);
	const result: PerTitleLadderAssessment = {
		input,
		rows: proposal.api.streams.map((stream) => ({
			rowId: stream.rowId,
			mode: stream.mode,
			height: stream.height,
			width: stream.width,
			configured:
				stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" &&
				rate(stream.perTitleSettings?.minBitrate) &&
				rate(stream.perTitleSettings?.maxBitrate)
					? {
							minimum: stream.perTitleSettings.minBitrate,
							maximum: stream.perTitleSettings.maxBitrate,
						}
					: null,
			low: at(stream, input.minimum),
			high: at(stream, input.maximum),
		})),
		intervals:
			curves.length && curves.every((row): row is Curve => row !== null)
				? certifyComplexityIntervals(curves, input, global.minBitrateStepSize)
				: null,
		earlySaturationRows: fixed
			.filter((stream) => {
				const row = perTitleAnalysisCurve(stream);
				return row && row.minimum < row.maximum && row.high < input.maximum;
			})
			.map((stream) => stream.rowId),
		globalCapacity: perTitlePlacementCapacity(
			input.minimum,
			input.maximum,
			global.minBitrateStepSize,
		),
		lowerSlots: null,
		lowerConnection: null,
		upperSlots: null,
		topResponse: {
			status: "unknown",
			domain: null,
			floor: null,
			witnessInput: null,
			checkedSegments: 0,
		},
	};
	const bottom = ordered[0];
	const bottomLow = bottom && at(bottom, input.minimum);
	const bottomHigh = bottom && at(bottom, input.maximum);
	const hasLowerAutomatic =
		basis &&
		bottom &&
		proposal.api.streams.some(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE" &&
				typeof stream[basis] === "number" &&
				(stream[basis] as number) < (bottom[basis] ?? 0),
		);
	if (hasLowerAutomatic && bottomLow && bottomHigh) {
		const minimum = perTitlePlacementCapacity(
			input.minimum,
			bottomLow.minimum,
			global.minBitrateStepSize,
		);
		const maximum = perTitlePlacementCapacity(
			input.minimum,
			bottomHigh.maximum,
			global.minBitrateStepSize,
		);
		if (minimum !== null && maximum !== null)
			result.lowerSlots = { minimum: minimum - 1, maximum: maximum - 1 };
		const maximumRatio = bottomHigh.maximum / input.minimum;
		result.lowerConnection = {
			maximumRatio,
			fitsMaximum: maximumRatio <= global.maxBitrateStepSize,
		};
	}
	if (reach.topFixed) {
		const minimum = perTitlePlacementCapacity(
			reach.topFixed.maximum,
			input.maximum,
			global.minBitrateStepSize,
		);
		const maximum = perTitlePlacementCapacity(
			reach.topFixed.minimum,
			input.maximum,
			global.minBitrateStepSize,
		);
		if (minimum !== null && maximum !== null)
			result.upperSlots = { minimum: minimum - 1, maximum: maximum - 1 };
	}
	const hasUpperAutomatic =
		basis &&
		top &&
		proposal.api.streams.some(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE" &&
				typeof stream[basis] === "number" &&
				(stream[basis] as number) > (top[basis] ?? Infinity),
		);
	if (!hasUpperAutomatic && global.autoRepresentations === undefined) {
		result.topResponse.status = "not-applicable";
		return result;
	}
	const rule = global.fixedResolutionAndBitrateConfiguration;
	if (
		!curve ||
		!rule ||
		rule.forcedRenditionAboveHighestFixedRepresentation !== 1 ||
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode !==
			"LAST_CALCULATED_BITRATE"
	)
		return result;
	const factor = rule.forcedRenditionAboveHighestFixedRepresentationFactor;
	if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 1)
		return result;
	const floor = Math.round(curve.minimum * factor);
	if (!rate(floor) || floor >= input.maximum) return result;
	const domain = {
		minimum: Math.max(input.minimum, floor),
		maximum: input.maximum,
	};
	result.topResponse.domain = domain;
	result.topResponse.floor = floor;
	const certificate = certifyComplexityDirectConnection(curve, domain, {
		minimum: global.minBitrateStepSize,
		maximum: global.maxBitrateStepSize,
	});
	result.topResponse.checkedSegments = certificate?.checkedSegments ?? 0;
	if (certificate?.allPermittedRates && curve.low >= floor) {
		result.topResponse.status = "tracked";
		return result;
	}
	// These points can disprove tracking. They are never used to certify it.
	for (const value of [
		domain.minimum,
		curve.low,
		curve.low + 1,
		curve.high - 1,
		curve.high,
		Math.round((domain.minimum + domain.maximum) / 2),
		domain.maximum,
	]) {
		if (value < domain.minimum || value > domain.maximum) continue;
		const range = evaluateComplexityRange({
			...curve,
			input: value,
			minStep: global.minBitrateStepSize,
		});
		if (
			range &&
			(value / range.maximum < global.minBitrateStepSize ||
				value / range.minimum > global.maxBitrateStepSize)
		) {
			result.topResponse.status = "gap";
			result.topResponse.witnessInput = value;
			break;
		}
	}
	return result;
}
