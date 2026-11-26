import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { expect, it } from "vitest";
import { type EngineDeps, type MediaProbe, verifyArtefacts } from "./engine";

const uuid = "00000000-0000-4000-8000-000000000001";
it.each([
	{ copy: false, codec: "pcm_s24le", tracks: 1, verdict: "PASS" },
	{ copy: false, codec: "pcm_s16le", tracks: 1, verdict: "FAIL" },
	{ copy: true, codec: "pcm_s16le", tracks: 1, verdict: "PASS" },
	{ copy: true, codec: "aac", tracks: 1, verdict: "FAIL" },
	{ copy: true, codec: "pcm_s24le", tracks: 2, verdict: "FAIL" },
])("checks one exact audio-only file ($copy, $codec, $tracks)", async ({
	copy,
	codec,
	tracks,
	verdict,
}) => {
	const raw = {
		planVersion: 1,
		name: "Audio",
		bitmovin: {},
		inputs: [{ key: "in", kind: "S3", credentialId: uuid, bucket: "input" }],
		outputs: [{ key: "out", kind: "S3", credentialId: uuid, bucket: "output" }],
		ingest: [
			{
				key: "track",
				inputKey: "in",
				inputPath: "concert.mov",
				selectionMode: "AUDIO_RELATIVE",
				position: 1,
			},
		],
		renditions: [
			{
				key: "sound",
				name: "Audio",
				ingestKey: "track",
				...(copy
					? {
							codec: "AUDIO_PASSTHROUGH",
							sourceCodec: "PCM",
							inspectionId: uuid,
						}
					: {
							codec: "PCM",
							rate: 48000,
							bitrate: 2304000,
							sampleFormat: "S24LE",
							channelLayout: "STEREO",
						}),
			},
		],
		muxings: [
			{
				kind: "PROGRESSIVE_WAV",
				key: "file",
				streamKey: "sound",
				filename: "audio.wav",
				destination: { outputKey: "out", path: "files/" },
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
	};
	const probe: MediaProbe = {
		audioCodec: codec,
		audioChannels: 2,
		audioSampleRate: 48000,
		audioBitrateBps: 2304000,
		audioStreamCount: tracks,
	};
	const unexpected = async () => {
		throw new Error("Unexpected segmented or manifest operation");
	};
	const deps: EngineDeps = {
		listAll: async () => [
			{ key: "files/nested/audio.wav", size: 100 },
			{ key: "files/audio.wav", size: 100 },
		],
		fetchObject: unexpected,
		fetchConcatenated: async (_out, keys) => {
			expect(keys).toEqual(["files/audio.wav"]);
			return "audio.wav";
		},
		probe: async () => probe,
		scanBoxes: unexpected,
		readText: unexpected,
		parseHls: unexpected,
		parseDash: unexpected,
	};
	const report = await verifyArtefacts(
		compileExpectedArtefacts(encodingPlanSchema.parse(raw)),
		deps,
	);
	const checks = report.checks.filter((c) =>
		c.id.startsWith("rendition:sound:"),
	);
	expect(checks.some((c) => c.verdict === "FAIL")).toBe(verdict === "FAIL");
	expect(checks.some((c) => c.id.endsWith(":audio-codec"))).toBe(true);
	expect(checks.some((c) => c.id.endsWith(":audio-bitrate"))).toBe(!copy);
	expect(report.checks.find((c) => c.id === "muxing:file:file")?.verdict).toBe(
		"PASS",
	);
});
