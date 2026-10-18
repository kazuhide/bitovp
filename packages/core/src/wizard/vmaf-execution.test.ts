import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema, planQcSchema } from "../plan/schema";
import { buildPlan } from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
			import.meta.url,
		),
		"utf8",
	),
);
const cloud = { backend: "CLOUD", profileId: "gcp-qc", budgetUsd: 12 } as const;

describe("VOD automatic VMAF execution", () => {
	it("preserves native generation6 when an API-authored plan is copied through the wizard", () => {
		const plan = encodingPlanSchema.parse({
			...fixture,
			qc: {
				vmaf: true,
				execution: cloud,
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
			},
		});
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(plan))),
		).toEqual(plan);
	});

	it.each([
		cloud,
		{ backend: "LOCAL" } as const,
	])("round-trips $backend execution through the wizard", (execution) => {
		const plan = encodingPlanSchema.parse({
			...fixture,
			qc: { vmaf: true, execution },
		});
		const state = planToWizardState(plan);
		expect(state.qc).toHaveProperty("execution", execution);
		expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
	});
	it("keeps legacy local plans without an execution key", () => {
		const plan = encodingPlanSchema.parse({ ...fixture, qc: { vmaf: true } });
		expect(plan.qc).not.toHaveProperty("execution");
		expect(buildPlan(planToWizardState(plan)).qc).not.toHaveProperty(
			"execution",
		);
	});
	it.each([
		0,
		-1,
		100001,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("refuses cloud budget %s", (budgetUsd) => {
		expect(
			planQcSchema.safeParse({ vmaf: true, execution: { ...cloud, budgetUsd } })
				.success,
		).toBe(false);
	});
	it("does not silently drop an invalid cloud budget from wizard output", () => {
		const state = planToWizardState({ ...fixture, qc: { vmaf: true } });
		if (!state.qc) throw new Error("Missing QC state");
		const plan = buildPlan({
			...state,
			qc: { ...state.qc, execution: { ...cloud, budgetUsd: 0 } },
		});
		expect(plan.qc).toHaveProperty("execution", { ...cloud, budgetUsd: 0 });
		expect(encodingPlanSchema.safeParse(plan).success).toBe(false);
	});
	it("prunes execution when measurement is disabled", () => {
		const state = planToWizardState({ ...fixture, qc: { vmaf: true } });
		if (!state.qc) throw new Error("Missing QC state");
		expect(
			buildPlan({
				...state,
				qc: { ...state.qc, vmaf: false, psnr: false, execution: cloud },
			}),
		).not.toHaveProperty("qc");
	});
	it("rejects provider configuration in the public plan", () => {
		expect(
			planQcSchema.safeParse({
				vmaf: true,
				execution: { ...cloud, executionProfile: { credential: "secret" } },
			}).success,
		).toBe(false);
	});
});
