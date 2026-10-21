import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { loadPlan } from "../plan/test-support";
import { buildPlan } from "./build-plan";
import { plansDeepEqual, planToWizardState } from "./plan-to-wizard";

describe("HLS video URI wizard round-trip", () => {
	it("keeps an imported filename through readback and rebuilding", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		Object.assign(plan.renditions[0] ?? {}, {
			hlsVariantUri: "custom-video.m3u8",
		});
		const parsed = encodingPlanSchema.parse(plan);
		const state = planToWizardState(
			parsed as unknown as Record<string, unknown>,
		);
		expect(state.videos[0]?.extras).toMatchObject({
			hlsVariantUri: "custom-video.m3u8",
		});
		expect(
			plansDeepEqual(encodingPlanSchema.parse(buildPlan(state)), parsed),
		).toBe(true);
	});
	it("keeps a group pattern without expanding it in the saved plan", () => {
		const plan = loadPlan("fixed-bitrate-hls-on-aws");
		Object.assign(plan.renditions[0] ?? {}, {
			hlsVariantUri: "custom-{group}.m3u8",
		});
		const state = planToWizardState(plan as unknown as Record<string, unknown>);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.renditions[0]?.hlsVariantUri).toBe("custom-{group}.m3u8");
	});
});
