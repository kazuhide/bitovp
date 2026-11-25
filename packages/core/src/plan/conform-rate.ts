import { filterParameters } from "./media-filters";
import { AUDIO_CODECS, type EncodingPlan } from "./schema";

// The provider reads the codec rate as a Float and Conform as a Double.
// It accepts a difference of at most 1e-7. Preserve the authored Double
// whenever it already passes that comparison.
export const CONFORM_RATE_TOLERANCE = 1e-7;
export function conformRateWithCodec(target: number): number {
	const codecRate = Math.fround(target);
	return Number.isFinite(codecRate) &&
		codecRate > 0 &&
		Math.abs(target - codecRate) > CONFORM_RATE_TOLERANCE
		? codecRate
		: target;
}

export function filterParametersForPlan(plan: EncodingPlan) {
	const firstEncoding = plan.encodings?.[0]?.key;
	const explicitVideoRates = new Set(
		plan.renditions
			.filter(
				(r) => "rate" in r && r.rate != null && !AUDIO_CODECS.has(r.codec),
			)
			.map((r) => r.encodingKey ?? firstEncoding),
	);
	return (
		filter: EncodingPlan["filters"][number],
		encodingKey: string | undefined,
	) => {
		const parameters = filterParameters(filter);
		if (
			filter.kind === "CONFORM" &&
			explicitVideoRates.has(encodingKey ?? firstEncoding)
		)
			parameters.targetFps = conformRateWithCodec(filter.targetFps);
		return parameters;
	};
}
