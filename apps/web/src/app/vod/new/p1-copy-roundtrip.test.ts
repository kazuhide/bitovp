import { encodingPlanSchema } from "@bitovp/core";
import { expect, it } from "vitest";
import audio from "@/test/fixtures/p1-audio-copy.json";
import video from "@/test/fixtures/p1-video-copy.json";
import { buildPlan } from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";

it.each([
	["video", video],
	["audio", audio],
])("preserves the saved P1 %s plan exactly", (_name, raw) => {
	for (const plan of [raw, encodingPlanSchema.parse(raw)]) {
		expect(tryImportPresetIntoWizard(plan).ok).toBe(true);
		const state = planToWizardState(plan);
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(
			encodingPlanSchema.parse(plan),
		);
		state.output.publicRead = true;
		const published = encodingPlanSchema.parse(buildPlan(state));
		expect(
			[...published.muxings, ...published.manifests].every(
				(row) => row.destination?.acl === "PUBLIC_READ",
			),
		).toBe(true);
	}
});

it("preserves mixed destination ACLs and lets explicit HLS versions override omission", () => {
	const plan = encodingPlanSchema.parse(video);
	const first = plan.muxings[0]?.destination;
	const second = plan.muxings[1]?.destination;
	if (!first || !second) throw new Error("Missing muxing fixture");
	first.acl = "PUBLIC_READ";
	delete second.acl;
	const state = planToWizardState(plan);
	expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
	state.manifests.hlsOptions = {
		...state.manifests.hlsOptions,
		masterVersion: "HLS_V7",
		mediaVersion: "HLS_V7",
	};
	const hls = encodingPlanSchema
		.parse(buildPlan(state))
		.manifests.find((m) => m.kind === "HLS");
	expect(hls).toMatchObject({
		masterVersion: "HLS_V7",
		mediaVersion: "HLS_V7",
	});
});
