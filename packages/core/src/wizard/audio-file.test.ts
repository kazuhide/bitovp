import { expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { validatePlan } from "../plan/validate";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";

const credential = "11111111-1111-4111-8111-111111111111";
it.each([
	"PCM",
	"COPY",
] as const)("builds and reopens an editable %s audio-only file with the original output", (mode) => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.name = "Archive";
	Object.assign(state.inputFiles[0] ?? {}, {
		credentialId: credential,
		bucket: "source",
		path: "movie.mov",
	});
	Object.assign(state.output, {
		credentialId: credential,
		bucket: "vault",
		basePath: "exports/",
		publicRead: false,
	});
	state.audioFile =
		mode === "PCM"
			? {
					mode,
					position: 1,
					filename: "master.wav",
					sampleFormat: "S24LE",
					channelLayout: "STEREO",
					rate: 48000,
				}
			: {
					mode,
					position: 1,
					filename: "original.mov",
					container: "PROGRESSIVE_MOV",
					sourceCodec: "PCM",
					inspectionId: credential,
				};
	const p = encodingPlanSchema.parse(buildPlan(state));
	expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
	expect(p.ingest).toMatchObject([
		{ position: 1, inputPath: "movie.mov", selectionMode: "AUDIO_RELATIVE" },
	]);
	expect(p.renditions).toHaveLength(1);
	expect(p.renditions[0]).toMatchObject(
		mode === "PCM"
			? { codec: "PCM", bitrate: 2304000 }
			: {
					codec: "AUDIO_PASSTHROUGH",
					sourceCodec: "PCM",
					inspectionId: credential,
				},
	);
	expect(p.muxings).toMatchObject([
		{ filename: state.audioFile.filename, destination: { path: "exports/" } },
	]);
	expect(p.manifests).toHaveLength(0);
	const back = tryImportPresetIntoWizard(p);
	expect(back.ok).toBe(true);
	if (!back.ok) throw new Error("Audio file must round trip in the form");
	expect(back.state.audioFile).toEqual(state.audioFile);
	expect(encodingPlanSchema.parse(buildPlan(back.state))).toEqual(p);
});
