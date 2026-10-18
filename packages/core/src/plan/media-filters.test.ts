import { describe, expect, it } from "vitest";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { mediaFilterSchema } from "./media-filters";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function plan(): EncodingPlan {
	const p = loadPlan("fixed-bitrate-hls-on-aws");
	p.filters = [
		{ key: "crop", kind: "CROP", top: 4, bottom: 4, unit: "PIXELS" },
		{ key: "rotate", kind: "ROTATE", rotation: 90 },
		{
			key: "text",
			kind: "TEXT",
			text: "Hello",
			x: "main_w-text_w-10",
			y: "10",
			font: "DEJAVUSANS",
			fontSize: 24,
		},
		{
			key: "image",
			kind: "WATERMARK",
			inputKey: p.inputs[0]?.key ?? "main",
			imagePath: "images/logo.png",
			right: 10,
			bottom: 10,
		},
		{ key: "volume", kind: "AUDIO_VOLUME", volume: -6, unit: "DB" },
		{
			key: "ebu",
			kind: "EBU_R128_SINGLE_PASS",
			integratedLoudness: -23,
			maximumTruePeakLevel: -1,
		},
	];
	for (const r of p.renditions)
		r.filters = (
			r.codec === "AAC"
				? ["volume", "ebu"]
				: ["crop", "rotate", "text", "image"]
		).map((filterKey, position) => ({ filterKey, position }));
	return p;
}
describe("P1 media filters", () => {
	it("compiles ordered paired attachment positions and secret-free image references", () => {
		const p = plan();
		expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(p);
		const video = p.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("missing fixture video");
		expect(
			ops.find((o) => o.step === `stream-filters:${video.key}`),
		).toMatchObject({
			payload: { positions: [0, 1, 2, 3] },
			refs: {
				filterIds: ["crop", "rotate", "text", "image"].map(
					(k) => `filter:${video.key}:${k}`,
				),
			},
		});
		expect(
			ops.find((o) => o.kind === "CREATE_FILTER_WATERMARK")?.payload,
		).toEqual({
			inputKey: p.inputs[0]?.key ?? "main",
			imagePath: "images/logo.png",
			right: 10,
			bottom: 10,
			imageInput: p.inputs[0],
		});
		expect(
			ops.find((o) => o.kind === "CREATE_FILTER_AUDIO_VOLUME")?.payload,
		).toEqual({ volume: -6, unit: "DB" });
	});
	it("rejects wrong media families, duplicate order and unresolved image input", () => {
		const p = plan();
		const first = p.renditions[0];
		if (!first) throw new Error("missing fixture rendition");
		first.filters = [
			{ filterKey: "volume", position: 0 },
			{ filterKey: "crop", position: 0 },
		];
		p.filters.push({
			key: "missing",
			kind: "WATERMARK",
			inputKey: "unknown",
			imagePath: "logo.png",
		});
		expect(validatePlan(p).map((i) => i.code)).toEqual(
			expect.arrayContaining([
				"PLAN_FILTER_MEDIA_TYPE",
				"PLAN_DUPLICATE_FILTER_POSITION",
				"PLAN_WATERMARK_INPUT",
			]),
		);
	});
	it.each([
		{ key: "bad", kind: "ROTATE", rotation: 90.5 },
		{ key: "bad", kind: "CROP", left: 1.5 },
		{
			key: "bad",
			kind: "WATERMARK",
			inputKey: "main",
			imagePath: "https://user:secret@host/logo.png",
		},
		{
			key: "bad",
			kind: "WATERMARK",
			inputKey: "main",
			imagePath: "logo.png",
			left: 0,
			right: 0,
		},
		{ key: "bad", kind: "AUDIO_VOLUME", volume: 10 },
		{ key: "bad", kind: "AUDIO_VOLUME", volume: -1, unit: "PERCENT" },
		{ key: "bad", kind: "CROP", unit: "PERCENTS", left: 50, right: 50 },
		{ key: "bad", kind: "EBU_R128_SINGLE_PASS", maximumTruePeakLevel: 1 },
		{ key: "bad", kind: "TEXT", text: "hello", x: "0" },
	])("rejects invalid filter %j", (filter) => {
		expect(mediaFilterSchema.safeParse(filter).success).toBe(false);
	});
	it("round-trips all six filter types and ordered references through wizard editing", () => {
		const p = plan();
		const rebuilt = encodingPlanSchema.parse(buildPlan(planToWizardState(p)));
		expect(rebuilt.filters).toEqual(p.filters);
		expect(rebuilt.renditions.map((r) => r.filters)).toEqual(
			p.renditions.map((r) => r.filters),
		);
	});
	it("exports correct template groups with runtime watermark capability placeholder", () => {
		const yaml = planToEncodingTemplateYaml(plan());
		expect(yaml).toContain("audioVolume:");
		expect(yaml).toContain("ebuR128SinglePass:");
		expect(yaml).toContain("/filters/watermark/");
		expect(yaml).toContain("_URL}}");
		expect(yaml).not.toContain("imagePath:");
	});
});
