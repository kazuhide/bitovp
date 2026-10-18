import { bitmovinAccountDefaultsSchema } from "../bitmovin/schemas";
import type { EncodingPlan } from "./schema";

/**
 * Inject the BitmovinAccount's submission defaults — fallback cloud regions,
 * scheduling priority, prewarmed encoder pools — into a plan's `bitmovin` block
 * at job submission.
 *
 * The account record is the source of truth for these (the VOD wizard never
 * collects them), so without this step they were silently dropped: the Settings
 * → Bitmovin form stored them, but no create/start payload ever carried them.
 * A value already present on the plan wins; an empty default (no regions / no
 * pools / unset priority) injects nothing, leaving the field `undefined` so the
 * compiler emits no payload key and the goldens stay byte-identical.
 */
export function applyAccountDefaultsToPlan(
	plan: EncodingPlan,
	rawDefaults: unknown,
): EncodingPlan {
	const d = bitmovinAccountDefaultsSchema.parse(rawDefaults ?? {});
	return {
		...plan,
		bitmovin: {
			...plan.bitmovin,
			fallbackCloudRegions:
				plan.bitmovin.fallbackCloudRegions ??
				(d.fallbackRegions.length > 0 ? d.fallbackRegions : undefined),
			schedulingPriority:
				plan.bitmovin.schedulingPriority ?? d.schedulingPriority,
			prewarmedEncoderPoolIds:
				plan.bitmovin.prewarmedEncoderPoolIds ??
				(d.prewarmedPoolIds.length > 0 ? d.prewarmedPoolIds : undefined),
		},
	};
}
