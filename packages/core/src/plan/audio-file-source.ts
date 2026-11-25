import { z } from "zod";
import type { EncodingPlan } from "./schema";

export const audioCopyIdentitySchema = z
	.object({
		size: z
			.number()
			.int()
			.positive()
			.max(4 * 1024 ** 3),
		etag: z.string().min(1).optional(),
		generation: z.string().regex(/^\d+$/).optional(),
		versionId: z.string().min(1).optional(),
	})
	.refine(
		(identity) =>
			!!identity.generation ||
			(!!identity.versionId && identity.versionId !== "null"),
	);
export type AudioCopyIdentity = z.infer<typeof audioCopyIdentitySchema>;
export const audioCopyTrackSchema = z.strictObject({
	position: z.number().int().nonnegative(),
	sourceCodec: z.enum(["AAC", "PCM"]),
});
export type AudioCopyTrack = z.infer<typeof audioCopyTrackSchema>;

const probeSchema = z.object({
	format: z
		.object({ nb_streams: z.number().int().positive().optional() })
		.optional(),
	streams: z
		.array(
			z.object({
				index: z.number().int().nonnegative(),
				codec_type: z.enum([
					"audio",
					"video",
					"subtitle",
					"data",
					"attachment",
				]),
				codec_name: z.string().min(1).optional(),
			}),
		)
		.nonempty(),
});
export function audioCopyRendition(plan: EncodingPlan) {
	return plan.renditions.find((r) => r.codec === "AUDIO_PASSTHROUGH");
}

/** AUDIO_RELATIVE counts every audio track, including unsupported codecs. */
export function verifiedAudioTracks(probe: unknown): AudioCopyTrack[] {
	const parsed = probeSchema.safeParse(probe);
	if (!parsed.success) return [];
	const { streams, format } = parsed.data;
	if (format?.nb_streams !== undefined && format.nb_streams !== streams.length)
		return [];
	const tracks: AudioCopyTrack[] = [];
	let position = 0;
	for (const [index, stream] of streams.entries()) {
		if (stream.index !== index) return [];
		if (stream.codec_type !== "audio") continue;
		if (stream.codec_name === "aac")
			tracks.push({ position, sourceCodec: "AAC" });
		else if (
			["pcm_s16le", "pcm_s24le", "pcm_s32le"].includes(stream.codec_name ?? "")
		)
			tracks.push({ position, sourceCodec: "PCM" });
		position++;
	}
	return tracks;
}
