import { z } from "zod";
import {
	dashAdditionalRepresentationSchema,
	dashDetailedOptionsSchema,
	dashRepresentationOptionsSchema,
	hlsAdditionalMediaSchema,
	hlsCustomTagSchema,
	hlsDetailedOptionsSchema,
	hlsMediaAttributesSchema,
} from "../plan/manifest-options";

/** Live setup has segment/time positions; VOD-created keyframe IDs are not Live input keyframes. */
export const liveCustomTagSchema = z.discriminatedUnion("positionMode", [
	hlsCustomTagSchema.options[0],
	hlsCustomTagSchema.options[1],
]);
const customTags = z.array(liveCustomTagSchema).max(64).optional();
export const liveHlsDetailedOptionsSchema = hlsDetailedOptionsSchema.extend({
	subtitleMedia: hlsMediaAttributesSchema
		.omit({ startSegmentNumber: true, endSegmentNumber: true })
		.optional(),
	mediaCustomTags: customTags,
	streamCustomTags: customTags,
	additionalMedia: z
		.array(
			z.discriminatedUnion("type", [
				hlsAdditionalMediaSchema.options[0].extend({ customTags }),
				hlsAdditionalMediaSchema.options[1].extend({ customTags }),
				hlsAdditionalMediaSchema.options[2].extend({ customTags }),
			]),
		)
		.max(64)
		.optional(),
});
export const liveDashDetailedOptionsSchema = dashDetailedOptionsSchema.extend({
	representations: z
		.array(
			dashRepresentationOptionsSchema.extend({
				startKeyframeKey: z.never().optional(),
				endKeyframeKey: z.never().optional(),
			}),
		)
		.max(256)
		.optional(),
	/** The Live encoder writes segmented fMP4/CMAF, not sprites or progressive WebM. */
	additionalRepresentations: z
		.array(dashAdditionalRepresentationSchema.options[1])
		.max(64)
		.optional(),
});
export type LiveHlsDetailedOptions = z.infer<
	typeof liveHlsDetailedOptionsSchema
>;
export type LiveDashDetailedOptions = z.infer<
	typeof liveDashDetailedOptionsSchema
>;
