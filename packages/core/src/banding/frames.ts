import { z } from "zod";
import { bandingFrameSchema } from "./types";

const vmafFrameSchema = z.object({
	frameNum: z.number().int().nonnegative(),
	vmaf: z.number().finite(),
	psnr: z.number().finite().optional(),
});

export const qcFramesEnvelopeSchema = z.strictObject({
	kind: z.literal("QC_FRAMES"),
	version: z.literal(1),
	vmaf: z.array(vmafFrameSchema).optional(),
	banding: z.array(bandingFrameSchema),
});
export type QcFramesEnvelope = z.infer<typeof qcFramesEnvelopeSchema>;

/** Historical plain/gzip arrays keep their VMAF meaning; no metric is invented. */
export function parseQcFrames(raw: unknown): QcFramesEnvelope {
	if (Array.isArray(raw)) {
		return {
			kind: "QC_FRAMES",
			version: 1,
			vmaf: z.array(vmafFrameSchema).parse(raw),
			banding: [],
		};
	}
	return qcFramesEnvelopeSchema.parse(raw);
}
