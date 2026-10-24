import type { PerTitleApiSettings } from "./per-title-simulator.js";

type Analysis = {
	floor: number | null;
	complexityInput: number | null;
	usesAspectRatioAssumption: boolean;
};

const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Resolves an analysis floor from the declared bitrate and spacing constraints. */
export function resolvePerTitleAnalysis(
	api: PerTitleApiSettings,
	cappedAnalysis: number | null,
): Analysis {
	const result = (
		floor: number | null,
		usesAspectRatioAssumption = false,
	): Analysis => ({
		floor,
		complexityInput:
			floor !== null && positiveInteger(cappedAnalysis)
				? Math.max(floor, cappedAnalysis)
				: null,
		usesAspectRatioAssumption,
	});
	const global = api.global;
	const step = global.minBitrateStepSize;
	if (
		!positiveInteger(global.minBitrate) ||
		!positiveInteger(global.maxBitrate) ||
		global.minBitrate > global.maxBitrate ||
		!Number.isFinite(step) ||
		step <= 1 ||
		!Number.isFinite(global.maxBitrateStepSize) ||
		global.maxBitrateStepSize < step
	)
		return result(null);

	const rule = global.fixedResolutionAndBitrateConfiguration;
	if (
		rule !== undefined &&
		(rule === null || typeof rule !== "object" || Array.isArray(rule))
	)
		return result(null);
	const count =
		rule === undefined
			? 0
			: rule.forcedRenditionAboveHighestFixedRepresentation;
	const factor = rule?.forcedRenditionAboveHighestFixedRepresentationFactor;
	if (
		typeof count !== "number" ||
		!Number.isSafeInteger(count) ||
		count < 0 ||
		(factor !== undefined && (!Number.isFinite(factor) || factor <= 0)) ||
		(count > 0 && factor === undefined)
	)
		return result(null);

	const fixed = api.streams.filter(
		(stream) => stream.mode !== "PER_TITLE_TEMPLATE",
	);
	for (const stream of fixed) {
		if (
			(stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" &&
				stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE") ||
			(stream.height !== undefined && !positiveInteger(stream.height)) ||
			(stream.width !== undefined && !positiveInteger(stream.width)) ||
			(stream.height === undefined && stream.width === undefined)
		)
			return result(null);
		if (stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
			continue;
		const range = stream.perTitleSettings;
		if (
			!positiveInteger(range?.minBitrate) ||
			!positiveInteger(range?.maxBitrate) ||
			range.minBitrate > range.maxBitrate ||
			range.minBitrate < global.minBitrate ||
			range.maxBitrate > global.maxBitrate
		)
			return result(null);
	}
	if (
		!fixed.some(
			(stream) =>
				stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		)
	)
		return result(global.minBitrate);

	const useWidths = fixed.every((stream) => stream.width !== undefined);
	const useHeights = fixed.every(
		(stream) => stream.width === undefined && stream.height !== undefined,
	);
	if (!useWidths && !useHeights) return result(null);
	const dimensions: Array<{
		stream: PerTitleApiSettings["streams"][number];
		size: number;
	}> = [];
	for (const stream of fixed) {
		const size = useWidths ? stream.width : stream.height;
		if (size === undefined) return result(null, useHeights);
		dimensions.push({ stream, size });
	}
	const highestRangeSize = Math.max(
		...dimensions
			.filter(
				({ stream }) =>
					stream.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			)
			.map(({ size }) => size),
	);
	const group = dimensions.filter(({ size }) => size === highestRangeSize);
	const minimum = group[0]?.stream.perTitleSettings?.minBitrate;
	if (
		minimum === undefined ||
		group.some(
			({ stream }) =>
				stream.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" ||
				stream.perTitleSettings?.minBitrate !== minimum,
		)
	)
		return result(null, useHeights);

	const spacingCount =
		group.length -
		1 +
		dimensions.filter(({ size }) => size > highestRangeSize).length;
	const spacedMinimum = Math.trunc(minimum * step ** spacingCount);
	if (!positiveInteger(spacedMinimum)) return result(null, useHeights);
	const floor = Math.trunc(spacedMinimum * (factor ?? 1) ** count);
	return result(
		Number.isSafeInteger(floor) && floor >= 0 ? floor : null,
		useHeights,
	);
}
