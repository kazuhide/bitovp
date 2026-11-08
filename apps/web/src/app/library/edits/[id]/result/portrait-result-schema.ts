import { z } from "zod";

export const portraitRenderShape = z.object({
	id: z.uuid(),
	revisionId: z.uuid(),
	kind: z.enum(["EXPORT", "PREVIEW"]),
	state: z.string(),
	generation: z.number().int().nonnegative(),
	error: z.string().nullable(),
	durationFrames: z.number().int().positive().optional(),
	requestKey: z.uuid().optional(),
	artifact: z
		.object({
			id: z.uuid(),
			url: z.string().min(1),
			downloadUrl: z.string().min(1),
			derivedContentId: z.uuid().nullable(),
		})
		.nullable(),
});
