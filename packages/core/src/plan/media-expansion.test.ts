import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compileExpectedArtefacts } from "../verify/expected";
import { buildPlan } from "../wizard/build-plan";
import {
	planToWizardState,
	tryImportPresetIntoWizard,
} from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function sourcePlan(name: string) {
	const p = loadPlan(name);
	for (const x of [...p.inputs, ...p.outputs])
		if ("credentialId" in x)
			x.credentialId = "11111111-1111-4111-8111-111111111111";
	for (const x of p.ingest) x.inputPath = "source.mp4";
	return p;
}
function imscPlan() {
	const base = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
	return encodingPlanSchema.parse({
		...base,
		fileStreams: [
			{
				key: "ttml",
				inputKey: base.inputs[0]?.key,
				inputPath: "captions/en.ttml",
				fileType: "TTML",
			},
		],
		renditions: [
			...base.renditions,
			{
				key: "imsc",
				codec: "IMSC",
				ingestKey: "ttml",
				language: "en",
				label: "English",
				styling: { mode: "PASSTHROUGH" },
			},
		],
		muxings: [
			...base.muxings,
			{
				key: "imsc-text",
				kind: "TEXT",
				streamKey: "imsc",
				filename: "english.ttml",
				destination: {
					...base.manifests[0]?.destination,
					path: `${base.manifests[0]?.destination.path}subtitles/en/`,
				},
			},
		],
	});
}
function opusPlan() {
	const base = sourcePlan("vp9-webm-fixed-dash");
	return encodingPlanSchema.parse({
		...base,
		renditions: [
			...base.renditions.filter((r) => r.codec !== "AAC"),
			{
				key: "opus",
				codec: "OPUS",
				ingestKey:
					base.ingest.find((i) => i.selectionMode === "AUDIO_RELATIVE")?.key ??
					base.ingest[0]?.key,
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: [
			...base.muxings.filter((m) => m.kind === "WEBM"),
			{
				key: "opus-webm",
				kind: "WEBM",
				streamKey: "opus",
				destination: {
					...base.manifests[0]?.destination,
					path: `${base.manifests[0]?.destination.path}audio/opus/`,
				},
			},
		],
		manifests: base.manifests.map((m) =>
			m.kind === "DASH" ? { ...m, audioMuxingKind: "WEBM" } : m,
		),
	});
}
describe("IMSC and Opus contracts", () => {
	it("creates TTML→IMSC→Text and DASH IMSC while HLS still uses only WebVTT", () => {
		const plan = imscPlan();
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		expect(ops.find((o) => o.kind === "CREATE_CODEC_IMSC")?.payload).toEqual({
			styling: { mode: "PASSTHROUGH" },
		});
		expect(
			ops.find((o) => o.kind === "CREATE_MUXING_TEXT")?.payload,
		).toMatchObject({ filename: "english.ttml" });
		expect(
			ops.find((o) => o.kind === "CREATE_DASH_REPRESENTATION_IMSC")?.payload
				.imscUrl,
		).toContain("english.ttml");
		expect(ops.filter((o) => o.kind === "CREATE_HLS_SUBTITLES_MEDIA")).toEqual(
			[],
		);
		expect(
			encodingPlanSchema.parse(
				buildPlan(planToWizardState(JSON.parse(JSON.stringify(plan)))),
			),
		).toEqual(plan);
		const restored = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(plan)),
		);
		if (!restored.ok) throw new Error(JSON.stringify(restored));
		expect(restored.ok).toBe(true);
		expect(encodingPlanSchema.parse(buildPlan(restored.state))).toEqual(plan);
		const doc = parse(planToEncodingTemplateYaml(plan));
		expect(doc.configurations.subtitles.imsc.imsc.properties.styling.mode).toBe(
			"PASSTHROUGH",
		);
		expect(JSON.stringify(doc)).toContain("english.ttml");
		expect(
			compileExpectedArtefacts(plan).muxings.find(
				(m) => m.muxingKey === "imsc-text",
			),
		).toMatchObject({
			container: "TEXT_SINGLE",
			filename: "english.ttml",
			text: {},
		});
	});
	it("joins IMSC output filenames when the directory has no trailing slash", () => {
		const plan = imscPlan();
		const mux = plan.muxings.find((m) => m.kind === "TEXT");
		if (mux?.kind !== "TEXT") throw new Error("Missing Text muxing");
		mux.destination.path = mux.destination.path.replace(/\/$/, "");
		const url = compilePlan(plan).find(
			(o) => o.kind === "CREATE_DASH_REPRESENTATION_IMSC",
		)?.payload.imscUrl;
		expect(url).toBe("subtitles/en/english.ttml");
	});
	it.each([
		["out/manifests/captions/", "captions/english.ttml"],
		["out/captions/", "../captions/english.ttml"],
		["out/manifests", "english.ttml"],
		["", "../../english.ttml"],
	])("resolves IMSC output directory %s from the MPD directory", (path, expected) => {
		const plan = imscPlan();
		const mux = plan.muxings.find((m) => m.kind === "TEXT");
		if (mux?.kind !== "TEXT") throw new Error("Missing Text muxing");
		mux.destination.path = path;
		const dash = plan.manifests.find((m) => m.kind === "DASH");
		if (!dash) throw new Error("Missing DASH");
		dash.destination.path = "out/manifests/";
		const url = compilePlan(plan).find(
			(o) => o.kind === "CREATE_DASH_REPRESENTATION_IMSC",
		)?.payload.imscUrl;
		expect(url).toBe(expected);
		expect(
			new URL(String(url), "https://origin.test/out/manifests/stream.mpd")
				.pathname,
		).toBe(`/${path.replace(/\/$/, "")}${path ? "/" : ""}english.ttml`);
		const doc = parse(planToEncodingTemplateYaml(plan));
		expect(
			doc.manifests.dash[dash.key].periods.period.adaptationsets.subtitle[
				"subtitle-imsc-text"
			].representations.imsc["imsc-text"].properties.imscUrl,
		).toBe(expected);
	});
	it("refuses Opus WebM in an HLS playlist before charging for the encode", () => {
		const plan = opusPlan();
		const base = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const hls = base.manifests.find((m) => m.kind === "HLS");
		if (!hls) throw new Error("Missing HLS");
		plan.manifests.push({ ...hls, audioMuxingKind: undefined });
		expect(
			validatePlan(plan).some(
				(x) => x.code === "PLAN_HLS_OPUS_WEBM_UNSUPPORTED",
			),
		).toBe(true);
	});
	it("rejects a relative IMSC URL pointing to a different output storage", () => {
		const plan = imscPlan();
		const mux = plan.muxings.find((m) => m.kind === "TEXT");
		if (mux?.kind !== "TEXT") throw new Error("Missing Text muxing");
		mux.destination.outputKey = "other";
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_IMSC_OUTPUT_MISMATCH"),
		).toBe(true);
	});
	it("requires matching TTML input and Text packaging", () => {
		const plan = imscPlan();
		const file = plan.fileStreams[0];
		if (!file) throw new Error("Missing file");
		file.fileType = "WEBVTT";
		expect(
			validatePlan(plan).some((x) => x.code === "PLAN_STREAM_SOURCE_MISMATCH"),
		).toBe(true);
	});
	it("creates Opus and selects its WebM audio representation without loss on clone", () => {
		const plan = opusPlan();
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.find((o) => o.kind === "CREATE_CODEC_OPUS")?.payload,
		).toMatchObject({ rate: 48000, channelLayout: "CL_STEREO" });
		expect(
			ops
				.filter((o) => o.kind === "CREATE_DASH_REPRESENTATION_WEBM")
				.some((o) => o.refs.muxingId === "muxing:opus-webm"),
		).toBe(true);
		expect(
			encodingPlanSchema.parse(
				buildPlan(planToWizardState(JSON.parse(JSON.stringify(plan)))),
			),
		).toEqual(plan);
		const restored = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(plan)),
		);
		if (!restored.ok) throw new Error(JSON.stringify(restored));
		expect(restored.ok).toBe(true);
		expect(encodingPlanSchema.parse(buildPlan(restored.state))).toEqual(plan);
		const doc = parse(planToEncodingTemplateYaml(plan));
		expect(doc.configurations.audio.opus.opus.properties.channelLayout).toBe(
			"STEREO",
		);
		expect(JSON.stringify(doc.manifests.dash)).toContain('"webm"');
	});
	it.each([
		[undefined, "PLAN_DASH_SET_UNRESOLVED"],
		["video", "PLAN_DASH_SET_TYPE_MISMATCH"],
	] as const)("rejects an Opus WebM track with invalid set %s even alongside valid audio", (dashSetKey, code) => {
		const plan = opusPlan();
		for (const rendition of plan.renditions)
			rendition.dashSetKey = rendition.codec === "OPUS" ? "audio" : "video";
		const opus = plan.renditions.find((r) => r.codec === "OPUS");
		const muxing = plan.muxings.find((m) => m.streamKey === opus?.key);
		if (!opus || !muxing) throw new Error("Missing Opus track");
		plan.renditions.push({ ...opus, key: "invalid-opus", dashSetKey });
		plan.muxings.push({
			...muxing,
			key: "invalid-opus-webm",
			streamKey: "invalid-opus",
		});
		for (const manifest of plan.manifests)
			if (manifest.kind === "DASH")
				manifest.adaptationSets = [
					{ key: "video", type: "VIDEO" },
					{ key: "audio", type: "AUDIO" },
				];
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([
			expect.objectContaining({
				code,
				path: `renditions[${plan.renditions.length - 1}].dashSetKey`,
			}),
		]);
	});
	it("rejects invalid filters and retains ordered denoise/sharpen through clone", () => {
		const base = imscPlan();
		const video = base.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("Missing video");
		video.filters = [
			{ filterKey: "denoise", position: 0 },
			{ filterKey: "sharp", position: 1 },
		];
		base.filters = [
			{ key: "denoise", kind: "DENOISE_HQDN3D", lumaSpatial: 4, chromaTmp: 0 },
			{
				key: "sharp",
				kind: "UNSHARP",
				lumaMatrixHorizontalSize: 5,
				lumaEffectStrength: 0.5,
			},
		];
		const plan = encodingPlanSchema.parse(base);
		expect(validatePlan(plan).filter((x) => x.level === "error")).toEqual([]);
		expect(
			compilePlan(plan)
				.filter((o) => o.kind.startsWith("CREATE_FILTER_"))
				.map((o) => o.kind),
		).toEqual(["CREATE_FILTER_DENOISE_HQDN3D", "CREATE_FILTER_UNSHARP"]);
		expect(
			encodingPlanSchema.parse(
				buildPlan(planToWizardState(JSON.parse(JSON.stringify(plan)))),
			),
		).toEqual(plan);
		const restored = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(plan)),
		);
		if (!restored.ok) throw new Error(JSON.stringify(restored));
		expect(restored.ok).toBe(true);
		expect(encodingPlanSchema.parse(buildPlan(restored.state))).toEqual(plan);
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				filters: [
					{ key: "sharp", kind: "UNSHARP", lumaMatrixHorizontalSize: 4 },
				],
			}).success,
		).toBe(false);
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				filters: [{ key: "denoise", kind: "DENOISE_HQDN3D", lumaSpatial: -1 }],
			}).success,
		).toBe(false);
	});
});
