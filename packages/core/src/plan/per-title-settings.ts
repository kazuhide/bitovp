import type { z } from "zod";
import type { perTitleStreamSettingsSchema } from "./schema";

/** Converts the flat plan form to StreamPerTitleSettings without nesting codec factors. */
export function streamPerTitleSettings(
	settings: z.infer<typeof perTitleStreamSettingsSchema>,
) {
	const { codecMaxBitrateFactor, codecBufsizeFactor, ...fixed } = settings;
	const hasFactors =
		codecMaxBitrateFactor !== undefined || codecBufsizeFactor !== undefined;
	return {
		...(Object.keys(fixed).length || !hasFactors
			? { fixedResolutionAndBitrateSettings: fixed }
			: {}),
		...(codecMaxBitrateFactor !== undefined ? { codecMaxBitrateFactor } : {}),
		...(codecBufsizeFactor !== undefined ? { codecBufsizeFactor } : {}),
	};
}
