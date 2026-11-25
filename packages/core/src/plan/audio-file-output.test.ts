import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { validatePlan } from "./validate";

const source = {
	key: "in",
	kind: "S3",
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "library",
};
const location = { outputKey: "out", path: "masters" };
const pcm = {
	codec: "PCM",
	name: "PCM master",
	bitrate: 2304000,
	rate: 48000,
	channelLayout: "STEREO",
	sampleFormat: "S24LE",
};
const copy = (sourceCodec: string) => ({
	codec: "AUDIO_PASSTHROUGH",
	name: "Original audio",
	inspectionId: "00000000-0000-4000-8000-000000000031",
	sourceCodec,
});
function plan(
	config: Record<string, unknown>,
	kind: string,
	filename: string,
	encoderVersion = "2.203.0",
) {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "Audio master",
		bitmovin: { encoderVersion },
		inputs: [source],
		outputs: [{ ...source, key: "out" }],
		ingest: [
			{
				key: "track",
				inputKey: "in",
				inputPath: "movie.mov",
				selectionMode: "AUDIO_RELATIVE",
				position: 1,
			},
		],
		renditions: [{ ...config, key: "audio", ingestKey: "track" }],
		muxings: [
			{
				key: "file",
				kind,
				streamKey: "audio",
				filename,
				destination: location,
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
	});
}
describe("VOD audio files", () => {
	it("compiles one PCM encoder, its audio stream and the named whole WAV file", () => {
		const value = plan(pcm, "PROGRESSIVE_WAV", "master.wav");
		expect(validatePlan(value).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(value);
		expect(ops.find((o) => o.step === "codec:audio")).toMatchObject({
			kind: "CREATE_CODEC_PCM",
			payload: {
				name: "PCM master",
				bitrate: 2304000,
				rate: 48000,
				channelLayout: "STEREO",
				sampleFormat: "S24LE",
			},
		});
		expect(ops.find((o) => o.step === "muxing:file")).toMatchObject({
			kind: "CREATE_MUXING_PROGRESSIVE_WAV",
			payload: { filename: "master.wav" },
			refs: { streamId: "stream:audio" },
		});
		expect(ops.filter((o) => o.kind === "CREATE_STREAM")).toHaveLength(1);
	});
	it.each([
		["AAC", "MP4", "audio.mp4", "2.200.0"],
		["PCM", "PROGRESSIVE_MOV", "audio.mov", "2.200.0"],
		["AAC", "PROGRESSIVE_MOV", "audio.mov", "2.201.0"],
		["PCM", "PROGRESSIVE_WAV", "audio.wav", "2.202.0"],
	])("copies %s to %s without an encoder bitrate", (codec, kind, filename, version) => {
		const value = plan(copy(codec), kind, filename, version);
		expect(validatePlan(value).filter((i) => i.level === "error")).toEqual([]);
		expect(
			compilePlan(value).find((o) => o.step === "codec:audio"),
		).toMatchObject({
			kind: "CREATE_CODEC_AUDIO_PASSTHROUGH",
			payload: { name: "Original audio" },
		});
		expect(
			compilePlan(value).find((o) => o.step === "codec:audio")?.payload,
		).not.toHaveProperty("bitrate");
		expect(compilePlan(value)).not.toContainEqual(
			expect.objectContaining({ kind: "CREATE_INPUT_S3" }),
		);
		expect(
			compilePlan(value).find((o) => o.step === "ingest:track"),
		).toMatchObject({
			payload: { requireAudioCapture: true },
			refs: { encodingId: "encoding" },
		});
	});
	it.each([
		["PCM", "MP4", "audio.mp4", "2.203.0"],
		["AAC", "PROGRESSIVE_WAV", "audio.wav", "2.203.0"],
		["PCM", "PROGRESSIVE_WAV", "audio.wav", "2.201.0"],
	])("rejects unsupported %s to %s on %s (%s)", (codec, kind, filename, version) => {
		expect(
			validatePlan(plan(copy(codec), kind, filename, version)).some(
				(i) => i.level === "error",
			),
		).toBe(true);
	});
	it("exports the PCM WAV template with its references and holds copy templates to immutable input execution", () => {
		const document = parse(
			planToEncodingTemplateYaml(plan(pcm, "PROGRESSIVE_WAV", "master.wav")),
		);
		const validator = new Ajv2020({ strict: false, logger: false }).compile(
			JSON.parse(
				readFileSync(
					new URL(
						"./__fixtures__/bitmovin-encoding-template.schema.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		expect(validator(document), JSON.stringify(validator.errors)).toBe(true);
		expect(document.configurations.audio.pcm.audio.properties).toMatchObject({
			channelLayout: "STEREO",
			sampleFormat: "S24LE",
		});
		expect(JSON.stringify(document.encodings)).toContain(
			"$/configurations/audio/pcm/audio",
		);
		expect(JSON.stringify(document.encodings)).toContain("progressiveWav");
		expect(() =>
			planToEncodingTemplateYaml(
				plan(copy("PCM"), "PROGRESSIVE_WAV", "master.wav"),
			),
		).toThrow("verified input version");
	});
	it("rejects AAC-style audio settings on a copy, and WAV video/multiple streams", () => {
		expect(() =>
			plan({ ...copy("AAC"), bitrate: 128000 }, "MP4", "x.mp4"),
		).toThrow();
		const value = plan(pcm, "PROGRESSIVE_WAV", "master.wav");
		expect(
			encodingPlanSchema.safeParse({
				...value,
				muxings: [{ ...value.muxings[0], additionalStreamKeys: ["v"] }],
			}).success,
		).toBe(false);
	});
});

it("rejects embedded caption reads outside the one verified copied audio source", () => {
	const p = plan(copy("AAC"), "MP4", "audio.mp4");
	p.captionStreams.push({
		key: "unused",
		kind: "CEA608",
		channel: "CC1",
		inputKey: "in",
		inputPath: "another.mov",
	});
	expect(validatePlan(p).some((issue) => issue.level === "error")).toBe(true);
});
