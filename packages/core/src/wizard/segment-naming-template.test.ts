import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

describe("wizard segment naming templates", () => {
	it.each([
		"FMP4",
		"TS",
	] as const)("round-trips %s templates and compiles the naming policy exclusively", (kind) => {
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
		const template = `seg-{rand_chars:8}-%number%.${kind === "TS" ? "ts" : "m4s"}`;
		plan.muxings = encodingPlanSchema.shape.muxings.parse(
			plan.muxings.map((muxing) => ({
				key: muxing.key,
				kind,
				streamKey: muxing.streamKey,
				destination: muxing.destination,
				segmentLength: 6,
				segmentNaming: "literal_%number%.m4s",
				segmentNamingTemplate: template,
				...(kind === "FMP4" ? { initSegmentName: "init.mp4" } : {}),
			})),
		);
		const state = planToWizardState(plan);
		expect(state.videos[0]?.muxing).toHaveProperty(
			"segmentNamingTemplate",
			template,
		);
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt).toEqual(plan);
		const ops = compilePlan(rebuilt).filter(
			(op) => op.kind === `CREATE_MUXING_${kind}`,
		);
		expect(ops.length).toBe(plan.muxings.length);
		for (const op of ops) {
			expect(op.payload).toHaveProperty("segmentNamingTemplate", template);
			expect(op.payload).not.toHaveProperty("segmentNaming");
		}
	});
});
