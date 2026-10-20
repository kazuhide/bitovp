import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { afterEach, expect, it } from "vitest";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";

afterEach(() => localStorage.clear());

it.each([
	"SDR",
	"HDR10",
	"DOLBY_VISION_PROFILE_10_0",
	"DOLBY_VISION_PROFILE_10_1",
])("imports, drafts and copies AV1 %s without losing siblings", (format) => {
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
			),
			"utf8",
		),
	);
	raw.renditions[1].dynamicRangeFormat = format;
	raw.renditions[1].ingestKey = "vision";
	raw.dolbyStreams = [
		{
			key: "vision",
			kind: "VISION",
			inputKey: raw.inputs[0].key,
			videoInputPath: "video.mov",
			metadataInputPath: "metadata.xml",
		},
	];
	const plan = encodingPlanSchema.parse(raw);
	expect(tryImportPresetIntoWizard(plan).ok).toBe(true);
	const state = planToWizardState(plan);
	expect(state.videos[1]?.av1).toMatchObject({
		dynamicRangeFormat: format,
		presetConfiguration: "VOD_QUALITY",
		autoLevelSetup: "ENABLED",
	});
	expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
	writeWizardDraft("av1-format", "vod", state, 2);
	const draft = readWizardDraft("av1-format", "vod");
	if (!draft) throw new Error("Missing saved AV1 draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.videos[1]?.av1).toEqual(state.videos[1]?.av1);
	const copied = { ...restored, ...addVodVideo(restored, 1) };
	expect(copied.videos.at(-1)?.av1).toEqual(restored.videos[1]?.av1);
	expect(copied.videos.at(-1)?.av1).not.toBe(restored.videos[1]?.av1);
	const built = encodingPlanSchema.parse(buildPlan(copied));
	expect(built.renditions.filter((r) => r.codec === "AV1")).toHaveLength(3);
	expect(
		built.renditions.filter((r) => r.codec === "AV1").at(-1),
	).toHaveProperty("dynamicRangeFormat", format);
});
