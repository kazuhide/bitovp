import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlan, remapInputKeyRefs } from "../wizard/build-plan";
import {
	planToWizardState,
	tryImportPresetIntoWizard,
} from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function planWith(source: Record<string, unknown>) {
	const fixture = loadPlan("fixed-bitrate-hls-vtt-on-aws");
	const first = fixture.fileStreams[0];
	if (!first) throw new Error("missing subtitle fixture");
	const { fileType: _, ...common } = first;
	return {
		...fixture,
		fileStreams: fixture.fileStreams.slice(1),
		captionStreams: [{ ...common, inputPath: "feed.ts", ...source }],
	};
}
describe("subtitle extraction from input media", () => {
	it.each([
		[{ kind: "CEA608", channel: "CC3" }, "cea608", { channel: "CC3" }],
		[{ kind: "CEA708", channel: 63 }, "cea708", { channel: 63 }],
		[{ kind: "CEA708" }, "cea708", {}],
		[
			{ kind: "DVB", selectionMode: "SUBTITLE_RELATIVE", position: 2 },
			"dvbSubtitle",
			{ selectionMode: "SUBTITLE_RELATIVE", position: 2 },
		],
		[
			{ kind: "DVB", selectionMode: "AUTO" },
			"dvbSubtitle",
			{ selectionMode: "AUTO" },
		],
	] as const)("validates, compiles and exports %j", (source, collection, wire) => {
		const plan = encodingPlanSchema.parse(planWith(source));
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const [caption] = plan.captionStreams;
		if (!caption) throw new Error("missing caption source");
		const { key } = caption;
		const op = compilePlan(plan).find((o) => o.step === `caption:${key}`);
		expect(op).toMatchObject({
			kind:
				source.kind === "DVB"
					? "CREATE_DVB_SUBTITLE_INPUT_STREAM"
					: `CREATE_${source.kind}_INPUT_STREAM`,
			payload: { ...wire, inputPath: "feed.ts" },
		});
		expect(
			compilePlan(plan).some(
				(o) => o.kind === "CREATE_STREAM" && o.refs?.inputStreamId === op?.step,
			),
		).toBe(true);
		const imported = tryImportPresetIntoWizard(plan);
		expect(imported.ok).toBe(true);
		const state = planToWizardState(plan);
		expect(encodingPlanSchema.parse(buildPlan(state)).captionStreams).toEqual(
			plan.captionStreams,
		);
		const file = state.sources?.captionStreams?.[0]?.inputFile;
		if (!file) throw new Error("missing caption input after import");
		expect(
			remapInputKeyRefs(state, file, "renamed").sources?.captionStreams?.[0]
				?.inputFile,
		).toBe("renamed");
		state.inputFiles = state.inputFiles.filter((input) => input.key !== file);
		expect(encodingPlanSchema.safeParse(buildPlan(state)).success).toBe(false);

		const template = parse(planToEncodingTemplateYaml(plan));
		expect(
			template.encodings.main.inputStreams[
				source.kind === "DVB" ? "subtitles" : "captions"
			][collection][key].properties,
		).toMatchObject({ ...wire, inputPath: "feed.ts" });
	});
	it("downloads a standalone WebVTT file with a stable filename alongside the video", () => {
		const original = encodingPlanSchema.parse(
			planWith({ kind: "CEA608", channel: "CC1" }),
		);
		const state = planToWizardState(original);
		const subtitle = state.subtitles?.[0];
		if (!subtitle) throw new Error("missing subtitle rendition");
		subtitle.muxing = { kind: "TEXT" };
		const plan = encodingPlanSchema.parse(buildPlan(state));
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(plan.muxings.find((m) => m.kind === "TEXT")?.filename).toMatch(
			/\.vtt$/,
		);
		const ops = compilePlan(plan);
		expect(ops.filter((op) => op.kind === "CREATE_MUXING_TEXT")).toHaveLength(
			1,
		);
		expect(ops.some((op) => op.kind === "CREATE_HLS_SUBTITLES_MEDIA")).toBe(
			false,
		);
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(plan))).muxings,
		).toEqual(plan.muxings);
	});
	it.each([
		{ kind: "CEA608", channel: "CC2" },
		{ kind: "CEA708", channel: 0 },
		{ kind: "CEA708", channel: 64 },
		{ kind: "DVB", selectionMode: "AUTO", position: 1 },
	])("rejects an unavailable selection %j", (source) => {
		expect(encodingPlanSchema.safeParse(planWith(source)).success).toBe(false);
	});
});
