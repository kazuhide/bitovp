import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileExpectedArtefacts } from "../verify/expected";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { validatePlan } from "./validate";

function progressiveTsPlan() {
	const raw = JSON.parse(
		readFileSync(
			new URL(
				"./__fixtures__/mp4-muxed-av-progressive.plan.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	raw.muxings[0] = {
		...raw.muxings[0],
		kind: "PROGRESSIVE_TS",
		filename: "timeline.ts",
		name: "Progressive TS",
		startOffset: 0,
	};
	return encodingPlanSchema.parse(raw);
}

describe("progressive TS files", () => {
	it("compiles one file after both video and audio, without segmented TS or manifests", () => {
		const plan = progressiveTsPlan();
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		const muxing = ops.find((op) => op.kind === "CREATE_MUXING_PROGRESSIVE_TS");
		expect(muxing).toMatchObject({
			step: "muxing:file",
			payload: { filename: "timeline.ts", startOffset: 0 },
			refs: {
				streamId: "stream:v1080",
				additionalStreamIds: ["stream:a192"],
			},
		});
		expect(
			ops.findIndex((op) => op.kind === "CREATE_MUXING_PROGRESSIVE_TS"),
		).toBeGreaterThan(ops.findIndex((op) => op.step === "stream:a192"));
		expect(ops.some((op) => op.kind === "CREATE_MUXING_TS")).toBe(false);
		expect(ops.some((op) => op.kind.startsWith("CREATE_MANIFEST"))).toBe(false);
		expect(muxing?.payload).not.toHaveProperty("segmentNaming");
		expect(muxing?.payload).not.toHaveProperty("segmentLength");
	});

	it("keeps ordinary segmented TS unchanged", () => {
		const plan = progressiveTsPlan();
		plan.muxings = encodingPlanSchema.shape.muxings.parse([
			{
				key: "segments",
				kind: "TS",
				streamKey: "v1080",
				additionalStreamKeys: ["a192"],
				destination: plan.muxings[0]?.destination,
			},
		]);
		const muxing = compilePlan(plan).find(
			(op) => op.kind === "CREATE_MUXING_TS",
		);
		expect(muxing?.payload).toMatchObject({
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
		});
		expect(muxing?.payload).not.toHaveProperty("filename");
	});

	it("round-trips the file and its carried audio through the wizard and template", () => {
		const plan = progressiveTsPlan();
		const rebuilt = encodingPlanSchema.parse(
			buildPlan(planToWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		const yaml = planToEncodingTemplateYaml(plan);
		expect(yaml).toContain("progressiveTs:");
		expect(yaml).toContain("filename: timeline.ts");
		expect(yaml).toContain("startOffset: 0");
	});

	it("expects a single TS file with video and audio", () => {
		const expected = compileExpectedArtefacts(progressiveTsPlan());
		expect(expected.muxings[0]).toMatchObject({
			container: "PROGRESSIVE_TS",
			filename: "timeline.ts",
			video: { codec: "H264" },
			audio: { codec: "AAC" },
		});
		expect(expected.muxings[0]).not.toHaveProperty("segmentNaming");
	});

	it("validates every packaged codec and refuses segment naming on a file", () => {
		const plan = progressiveTsPlan();
		plan.renditions[1] = {
			key: "a192",
			codec: "OPUS",
			ingestKey: "audio",
			bitrate: 192000,
			rate: 48000,
			channelLayout: "CL_STEREO",
		};
		expect(validatePlan(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_MUXING_CODEC_MISMATCH",
				path: "muxings[0].additionalStreamKeys[0]",
			}),
		);
		expect(
			encodingPlanSchema.safeParse({
				...progressiveTsPlan(),
				muxings: [
					{
						...progressiveTsPlan().muxings[0],
						segmentNaming: "seg_%number%.ts",
					},
				],
			}).success,
		).toBe(false);
	});

	it("reports an incompatible VP9 file codec without rewriting the rendition", () => {
		const original = progressiveTsPlan();
		const plan = encodingPlanSchema.parse({
			...original,
			renditions: [
				{
					key: "v1080",
					codec: "VP9",
					ingestKey: "video",
					height: 1080,
					bitrate: 5000000,
				},
				original.renditions[1],
			],
		});
		expect(validatePlan(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_MUXING_CODEC_MISMATCH",
				message: expect.stringContaining("cannot package the VP9 rendition"),
			}),
		);
		expect(plan.renditions[0]?.codec).toBe("VP9");
	});
});
