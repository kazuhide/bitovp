import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	remapInputKeyRefs,
} from "../wizard/build-plan";
import { tryImportPresetIntoWizard } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test fixture value");
	return value;
}
function subtitlePlan(
	fixture = "fixed-bitrate-dash-hls-streamcondition-on-aws",
) {
	const plan = loadPlan(fixture);
	return encodingPlanSchema.parse({
		...plan,
		fileStreams: [
			{
				key: "vtt-file",
				inputKey: required(plan.inputs[0]).key,
				inputPath: "captions/en.vtt",
				fileType: "WEBVTT",
			},
		],
		renditions: [
			...plan.renditions,
			{
				key: "vtt",
				codec: "WEBVTT",
				ingestKey: "vtt-file",
				language: "en",
				label: "English",
			},
		],
		muxings: [
			...plan.muxings,
			{
				key: "vtt-mux",
				kind: "CHUNKED_TEXT",
				streamKey: "vtt",
				destination: {
					...required(plan.manifests[0]).destination,
					path: "output/subtitles/en",
				},
			},
		],
	});
}

it.each([
	"SUBTITLE",
	"translated",
])("links HLS video variants to subtitle group %s", (groupId) => {
	const plan = subtitlePlan();
	const subtitle = required(plan.renditions.find((r) => r.codec === "WEBVTT"));
	if (subtitle.codec !== "WEBVTT") throw new Error("missing subtitle");
	subtitle.groupId = groupId;
	const variants = compilePlan(plan).filter(
		(o) => o.kind === "CREATE_HLS_STREAM_INFO",
	);
	expect(variants.length).toBeGreaterThan(0);
	expect(variants.every((o) => o.payload.subtitles === groupId)).toBe(true);
	const doc = parse(planToEncodingTemplateYaml(plan));
	const manifests = Object.values(doc.manifests.hls) as {
		streams: Record<string, { properties: Record<string, unknown> }>;
	}[];
	expect(
		manifests
			.flatMap((m) => Object.values(m.streams))
			.every((s) => s.properties.subtitles === groupId),
	).toBe(true);
});

it("omits subtitle references without packaged subtitles and rejects ambiguous HLS groups", () => {
	const plan = subtitlePlan();
	plan.muxings = plan.muxings.filter((m) => m.kind !== "CHUNKED_TEXT");
	expect(
		compilePlan(plan)
			.filter((o) => o.kind === "CREATE_HLS_STREAM_INFO")
			.every((o) => !("subtitles" in o.payload)),
	).toBe(true);
	const multiple = subtitlePlan();
	const subtitle = required(
		multiple.renditions.find((r) => r.codec === "WEBVTT"),
	);
	if (subtitle.codec !== "WEBVTT") throw new Error("missing subtitle");
	multiple.renditions.push({
		...subtitle,
		key: "second-vtt",
		groupId: "other",
		uri: "second.m3u8",
	});
	multiple.muxings.push({
		...required(multiple.muxings.find((m) => m.kind === "CHUNKED_TEXT")),
		key: "second-text",
		streamKey: "second-vtt",
	});
	expect(
		validatePlan(multiple).some(
			(i) => i.code === "PLAN_HLS_SUBTITLE_GROUP_AMBIGUOUS",
		),
	).toBe(true);
	multiple.manifests = multiple.manifests.filter((m) => m.kind !== "HLS");
	expect(
		validatePlan(multiple).some(
			(i) => i.code === "PLAN_HLS_SUBTITLE_GROUP_AMBIGUOUS",
		),
	).toBe(false);
});
describe("DASH subtitles and SRT burn-in", () => {
	it("preserves burn-in through save/edit and rename; removed input fails closed", () => {
		const state = {
			...DEFAULT_WIZARD_STATE,
			name: "Subtitles",
			accountId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
			inputFiles: [
				{
					...required(DEFAULT_WIZARD_STATE.inputFiles[0]),
					credentialId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
					bucket: "bucket",
					path: "source.mov",
				},
				{
					...required(DEFAULT_WIZARD_STATE.inputFiles[0]),
					key: "srt",
					credentialId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
					bucket: "bucket",
					path: "captions/ja.srt",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
				bucket: "output",
			},
			videos: [
				{
					height: 360,
					bitrate: 200000,
					extras: {
						burnInSrt: {
							inputFile: "srt",
							characterEncoding: "SHIFT_JIS" as const,
						},
					},
				},
			],
		};
		const plan = encodingPlanSchema.parse(buildPlan(state));
		const restored = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(plan)),
		);
		expect(restored.ok).toBe(true);
		if (!restored.ok) throw new Error("round trip rejected");
		expect(encodingPlanSchema.parse(buildPlan(restored.state))).toEqual(plan);
		const renamed = {
			...state,
			...remapInputKeyRefs(state, "srt", "japanese"),
			inputFiles: state.inputFiles.map((f) =>
				f.key === "srt" ? { ...f, key: "japanese" } : f,
			),
		};
		expect(encodingPlanSchema.parse(buildPlan(renamed))).toEqual(plan);
		expect(
			encodingPlanSchema.safeParse(
				buildPlan({ ...state, inputFiles: state.inputFiles.slice(0, 1) }),
			).success,
		).toBe(false);
	});
	it("keeps post-encoding Per-Title expansion and explicit AV sets independent of subtitle sets", () => {
		const perTitle = subtitlePlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		const ops = compilePlan(perTitle);
		expect(
			ops.find((o) => o.kind === "CREATE_HLS_PER_TITLE_VARIANTS")?.payload
				.subtitles,
		).toBe("SUBTITLE");
		expect(
			ops.findIndex((o) => o.kind === "CREATE_DASH_ADAPTATION_SET_SUBTITLE"),
		).toBeGreaterThan(ops.findIndex((o) => o.kind === "AWAIT_ENCODING"));
		expect(
			ops.some((o) => o.kind === "CREATE_DASH_PER_TITLE_REPRESENTATIONS"),
		).toBe(true);
		const plan = subtitlePlan();
		const dash = required(plan.manifests.find((m) => m.kind === "DASH"));
		if (dash.kind !== "DASH") throw new Error("missing DASH");
		dash.adaptationSets = [
			{ key: "subtitle-vtt-mux", type: "VIDEO" },
			{ key: "audio", type: "AUDIO" },
		];
		for (const rendition of plan.renditions) {
			if (rendition.codec !== "WEBVTT")
				rendition.dashSetKey =
					rendition.codec === "AAC" ? "audio" : "subtitle-vtt-mux";
		}
		const explicitOps = compilePlan(plan);
		expect(new Set(explicitOps.map((o) => o.step)).size).toBe(
			explicitOps.length,
		);
		expect(
			explicitOps.filter(
				(o) => o.kind === "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
			),
		).toHaveLength(1);
	});
	it("exports SRT burn-in and DASH subtitle resource trees", () => {
		const plan = subtitlePlan();
		required(plan.renditions[0]).burnInSrt = {
			inputKey: "main",
			inputPath: "ja.srt",
			characterEncoding: "SHIFT_JIS",
		};
		const doc = parse(planToEncodingTemplateYaml(plan));
		const encoding = Object.values(doc.encodings)[0] as {
			streams: Record<string, unknown>;
		};
		expect(encoding.streams[required(plan.renditions[0]).key]).toMatchObject({
			burnInSubtitles: {
				srt: {
					subtitles: {
						properties: {
							name: "SRT subtitles",
							characterEncoding: "SHIFT-JIS",
							input: { inputPath: "ja.srt", inputId: "$/inputs/s3/main" },
						},
					},
				},
			},
		});
		const manifest = Object.values(doc.manifests.dash)[0] as {
			periods: { period: { adaptationsets: Record<string, unknown> } };
		};
		expect(manifest.periods.period.adaptationsets.subtitle).toMatchObject({
			"subtitle-vtt-mux": {
				properties: { lang: "en" },
				representations: {
					chunkedText: { "vtt-mux": { properties: { type: "TEMPLATE" } } },
				},
			},
		});
	});

	it("omits DASH resources from HLS-only plans", () => {
		const plan = subtitlePlan();
		plan.manifests = plan.manifests.filter((m) => m.kind === "HLS");
		expect(
			compilePlan(plan).filter((o) => o.kind.startsWith("CREATE_DASH")),
		).toEqual([]);
	});
	it("connects segmented WebVTT to a DASH subtitle set and retains HLS", () => {
		const plan = subtitlePlan();
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const ops = compilePlan(plan);
		const set = ops.find(
			(o) => o.kind === "CREATE_DASH_ADAPTATION_SET_SUBTITLE",
		);
		expect(set?.payload).toEqual({
			lang: "en",
			labels: [{ value: "English" }],
		});
		const rep = ops.find(
			(o) => o.kind === "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT",
		);
		expect(rep?.refs).toMatchObject({
			adaptationSetId: set?.step,
			muxingId: "muxing:vtt-mux",
		});
		expect(rep?.payload).toMatchObject({
			type: "TEMPLATE",
			segmentPath: expect.stringContaining("subtitles/en"),
		});
		expect(ops.some((o) => o.kind === "CREATE_HLS_SUBTITLES_MEDIA")).toBe(true);
	});
	it("attaches SRT burn-in after its video using a stored input reference", () => {
		const plan = subtitlePlan();
		required(plan.renditions[0]).burnInSrt = {
			inputKey: required(plan.inputs[0]).key,
			inputPath: "captions/ja.srt",
			characterEncoding: "UTF_8",
		};
		const ops = compilePlan(plan);
		const burn = ops.find((o) => o.kind === "CREATE_BURN_IN_SRT");
		expect(burn).toMatchObject({
			payload: { inputPath: "captions/ja.srt", characterEncoding: "UTF_8" },
			refs: {
				inputId: `input:${required(plan.inputs[0]).key}`,
				streamId: `stream:${required(plan.renditions[0]).key}`,
			},
		});
		expect(ops.indexOf(required(burn))).toBeGreaterThan(
			ops.findIndex((o) => o.step === burn?.refs.streamId),
		);
	});
	it.each([
		"AAC",
		"WEBVTT",
	])("rejects %s burn-in targets, unknown inputs and encodings", (codec) => {
		const plan = subtitlePlan();
		required(plan.renditions.find((r) => r.codec === codec)).burnInSrt = {
			inputKey: "missing",
			inputPath: "en.srt",
			characterEncoding: "UTF_8",
		};
		expect(validatePlan(plan).map((i) => i.code)).toEqual(
			expect.arrayContaining([
				"PLAN_BURN_IN_VIDEO_ONLY",
				"PLAN_UNRESOLVED_REF",
			]),
		);
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				renditions: [
					{
						...plan.renditions[0],
						burnInSrt: {
							inputKey: "main",
							inputPath: "en.srt",
							characterEncoding: "UTF8_typo",
						},
					},
				],
			}).success,
		).toBe(false);
	});
});
