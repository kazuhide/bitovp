import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";

it("copies a DASH CMAF plan into the form without losing chunk or init options", () => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.name = "CMAF copy";
	state.inputFiles[0] = {
		key: "main",
		inputKey: "main",
		kind: "S3",
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucket: "input",
		path: "source.mp4",
	};
	state.output = {
		kind: "S3",
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "output",
		basePath: "cmaf-copy",
		name: "Output",
		publicRead: false,
	};
	state.manifests = {
		hls: false,
		dash: true,
		dashOptions: { videoMuxingKind: "CMAF", audioMuxingKind: "CMAF" },
	};
	state.timing = "POST_ENCODING";
	for (const row of [...state.videos, ...state.audios]) {
		row.muxing = {
			kind: "CMAF",
			initSegmentNameTemplate: "init_%representation_id%.mp4",
			framesPerCmafChunk: 8,
		};
	}
	const original = encodingPlanSchema.parse(buildPlan(state));
	expect(
		validatePlan(original).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const imported = tryImportPresetIntoWizard(original);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("CMAF must remain form-editable");
	expect(
		encodingPlanSchema.parse(buildPlan(planToWizardState(original))),
	).toEqual(original);
	expect(imported.state.videos[0]?.muxing?.framesPerCmafChunk).toBe(8);
});
