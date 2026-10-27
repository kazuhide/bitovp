import { expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { curlForStep } from "./curl-from-step";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function configured(detailPreservationMode?: unknown) {
	const base = loadPlan("av1-fmp4-dash-hls");
	return {
		...base,
		bitmovin: { ...base.bitmovin, encoderVersion: "2.291.0" },
		renditions: base.renditions.map((rendition) =>
			rendition.codec === "AV1" && detailPreservationMode !== undefined
				? { ...rendition, detailPreservationMode }
				: rendition,
		),
	};
}

it.each([
	"OFF",
	"AUTO",
	"ON",
	undefined,
])("retains AV1 detail preservation %s through editing and every request export", (mode) => {
	const plan = encodingPlanSchema.parse(configured(mode));
	const state = planToWizardState(plan);
	expect(encodingPlanSchema.parse(buildPlan(state))).toEqual(plan);
	expect(state.encoderVersion).toBe("2.291.0");
	for (const row of plan.renditions.filter((row) => row.codec === "AV1")) {
		if (mode === undefined)
			expect(row).not.toHaveProperty("detailPreservationMode");
		else expect(row).toHaveProperty("detailPreservationMode", mode);
	}
	const template = parse(planToEncodingTemplateYaml(plan));
	const codecOps = compilePlan(plan).filter(
		(op) => op.kind === "CREATE_CODEC_AV1",
	);
	expect(codecOps).toHaveLength(2);
	for (const op of codecOps) {
		const request = Object.freeze({ ...op.payload, refs: {} });
		const curl = curlForStep({ ...op, status: "DONE", request });
		if (!curl.ok) throw new Error("Expected AV1 cURL request");
		const body = curl.command.match(/--data '([\s\S]*)'$/)?.[1];
		if (body === undefined) throw new Error("Missing cURL JSON body");
		for (const output of [op.payload, JSON.parse(body), request]) {
			if (mode === undefined)
				expect(output).not.toHaveProperty("detailPreservationMode");
			else expect(output).toHaveProperty("detailPreservationMode", mode);
		}
	}
	for (const key of ["v360", "v720"]) {
		const output = template.configurations.video.av1[key].properties;
		if (mode === undefined)
			expect(output).not.toHaveProperty("detailPreservationMode");
		else expect(output).toHaveProperty("detailPreservationMode", mode);
	}
});

it.each([
	"",
	"ENABLED",
	"FUTURE_MODE",
	"constructor",
	null,
	false,
	0,
])("rejects invalid AV1 detail preservation %j at plan and cURL boundaries", (mode) => {
	expect(encodingPlanSchema.safeParse(configured(mode)).success).toBe(false);
	expect(
		curlForStep({
			step: "codec:av1",
			kind: "CREATE_CODEC_AV1",
			status: "DONE",
			payload: {},
			refs: {},
			request: { detailPreservationMode: mode, refs: {} },
		}),
	).toEqual({ ok: false, code: "NO_ENDPOINT", kind: "CREATE_CODEC_AV1" });
});

it.each([
	"AUTO",
	"ON",
])("requires a supported numeric encoder version for AV1 %s", (mode) => {
	for (const version of ["2.9.0", "2.290.9", "1.999.0"]) {
		const raw = configured(mode);
		raw.bitmovin.encoderVersion = version;
		const plan = encodingPlanSchema.parse(raw);
		expect(
			validatePlan(plan).filter(
				(issue) => issue.code === "PLAN_AV1_DETAIL_PRESERVATION_VERSION",
			),
		).toEqual([
			expect.objectContaining({
				level: "error",
				path: "renditions[0].detailPreservationMode",
			}),
			expect.objectContaining({
				level: "error",
				path: "renditions[1].detailPreservationMode",
			}),
		]);
		expect(plan.bitmovin.encoderVersion).toBe(version);
	}
	for (const version of ["2.291.0", "2.292.0", "3.0.0"]) {
		const raw = configured(mode);
		raw.bitmovin.encoderVersion = version;
		expect(
			validatePlan(encodingPlanSchema.parse(raw)).filter((issue) =>
				issue.code.startsWith("PLAN_AV1_DETAIL_PRESERVATION_VERSION"),
			),
		).toEqual([]);
	}
});

it.each([
	"STABLE",
	"BETA",
	"custom-version",
])("warns about unresolved %s without rewriting it", (encoderVersion) => {
	const raw = configured("AUTO");
	raw.bitmovin.encoderVersion = encoderVersion;
	const plan = encodingPlanSchema.parse(raw);
	expect(
		validatePlan(plan).filter(
			(issue) =>
				issue.code === "PLAN_AV1_DETAIL_PRESERVATION_VERSION_UNRESOLVED",
		),
	).toEqual([
		expect.objectContaining({
			level: "warning",
			message: expect.stringContaining("2.291.0"),
		}),
		expect.objectContaining({
			level: "warning",
			message: expect.stringContaining("2.291.0"),
		}),
	]);
	expect(buildPlan(planToWizardState(plan)).bitmovin?.encoderVersion).toBe(
		encoderVersion,
	);
});

it.each([
	"OFF",
	undefined,
])("keeps %s compatible with old numeric encoders and aliases", (mode) => {
	for (const version of ["2.290.0", "STABLE", "BETA", "custom-version"]) {
		const raw = configured(mode);
		raw.bitmovin.encoderVersion = version;
		expect(
			validatePlan(encodingPlanSchema.parse(raw)).filter((issue) =>
				issue.code.startsWith("PLAN_AV1_DETAIL_PRESERVATION_VERSION"),
			),
		).toEqual([]);
	}
});

it("validates the actual encoding owner, its override and first-encoding fallback", () => {
	const raw = configured("ON");
	const plan = encodingPlanSchema.parse({
		...raw,
		encodings: [
			{ key: "first", name: "First", encoderVersion: "2.290.0" },
			{ key: "second", name: "Second", encoderVersion: "2.291.0" },
		],
		renditions: raw.renditions.map((row) =>
			row.key === "v720" ? { ...row, encodingKey: "second" } : row,
		),
	});
	expect(
		validatePlan(plan).filter(
			(issue) => issue.code === "PLAN_AV1_DETAIL_PRESERVATION_VERSION",
		),
	).toEqual([
		expect.objectContaining({
			path: "renditions[0].detailPreservationMode",
			level: "error",
		}),
	]);
	const first = plan.encodings?.[0];
	if (!first) throw new Error("Missing first encoding");
	first.encoderVersion = "2.291.0";
	plan.bitmovin.encoderVersion = "2.290.0";
	expect(
		validatePlan(plan).filter((issue) =>
			issue.code.startsWith("PLAN_AV1_DETAIL_PRESERVATION_VERSION"),
		),
	).toEqual([]);
	delete first.encoderVersion;
	expect(
		validatePlan(plan).filter(
			(issue) => issue.code === "PLAN_AV1_DETAIL_PRESERVATION_VERSION",
		),
	).toHaveLength(1);
});

it("retains per-encoding version overrides through import and form rebuilding", () => {
	const base = loadPlan("dolby-dv-hdr10-sdr-3ladder-profile5-single-input");
	const plan = encodingPlanSchema.parse({
		...base,
		encodings: base.encodings?.map((row, index) => ({
			...row,
			encoderVersion: index === 0 ? "2.291.0" : "STABLE",
		})),
	});
	expect(plan.encodings?.length).toBeGreaterThan(1);
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
});
