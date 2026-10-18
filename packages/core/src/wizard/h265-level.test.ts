import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

describe("H265 level authoring", () => {
	it("retains imported levels through form edits and compiles the selected value", () => {
		const plan = encodingPlanSchema.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		plan.renditions = plan.renditions.map((r) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec: "H265",
						height: r.height,
						bitrate: r.bitrate,
						mode: r.mode,
						level: "L4_1",
					}
				: r,
		);
		const state = planToWizardState(plan);
		const video = state.videos[0];
		if (!video) throw new Error("Missing fixture video");
		expect(video.h265?.level).toBe("L4_1");
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
		video.h265 = { ...video.h265, level: "L5_1" };
		const ops = compilePlan(encodingPlanSchema.parse(buildPlan(state)));
		expect(ops.some((op) => op.payload.level === "L5_1")).toBe(true);
		video.h265.level = undefined;
		expect(
			encodingPlanSchema.parse(buildPlan(state)).renditions[0],
		).toHaveProperty("level", null);
	});
});
