import { expect, it } from "vitest";
import {
	audioCopyIdentitySchema,
	verifiedAudioTracks,
} from "./audio-file-source";

const streams = [
	{ index: 0, codec_type: "video", codec_name: "h264" },
	{ index: 1, codec_type: "audio", codec_name: "mp3" },
	{ index: 2, codec_type: "audio", codec_name: "aac" },
	{ index: 3, codec_type: "audio", codec_name: "pcm_s24le" },
];
it("counts unsupported tracks in AUDIO_RELATIVE and rejects incomplete maps", () => {
	expect(verifiedAudioTracks({ streams })).toEqual([
		{ position: 1, sourceCodec: "AAC" },
		{ position: 2, sourceCodec: "PCM" },
	]);
	for (const partial of [
		{ streams: streams.slice(1) },
		{ streams: [streams[1], streams[1]] },
		{ streams, format: { nb_streams: 5 } },
		{ streams: [{}, ...streams] },
	])
		expect(verifiedAudioTracks(partial)).toEqual([]);
});
it("requires a materialized version of a gateway-sized object", () => {
	for (const identity of [
		{ size: 1, etag: "foo" },
		{ size: 1, versionId: "null" },
		{ size: 0, versionId: "v" },
		{ size: 4 * 1024 ** 3 + 1, versionId: "v" },
	])
		expect(audioCopyIdentitySchema.safeParse(identity).success).toBe(false);
	expect(
		audioCopyIdentitySchema.parse({
			size: 2,
			generation: "123",
			lastModified: "ignored",
		}),
	).toEqual({ size: 2, generation: "123" });
});
