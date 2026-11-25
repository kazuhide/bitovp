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
	it("names the refused Opus leg by its place in the plan, not among the legs the manifest selects", () => {
		const plan = opusPlan();
		const base = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const hls = base.manifests.find((m) => m.kind === "HLS");
		if (!hls) throw new Error("Missing HLS");
		plan.manifests.push({
			...hls,
			audioMuxingKind: undefined,
			generationMode: "DEFAULT",
		});
		// A muxing of another encoding, which a Default manifest does not select,
		// ahead of the legs it does.
		const [first] = plan.renditions;
		const leg = plan.muxings.find((m) => m.streamKey === first?.key);
		if (!first || !leg) throw new Error("Missing leg");
		plan.renditions.push({ ...first, key: "elsewhere", encodingKey: "second" });
		plan.muxings.unshift({
			...leg,
			key: "elsewhere-mux",
			streamKey: "elsewhere",
		});
		const opus = plan.muxings.findIndex(
			(m) =>
				plan.renditions.find((r) => r.key === m.streamKey)?.codec === "OPUS",
		);
		expect(opus).toBeGreaterThan(1);
		expect(
			validatePlan(plan)
				.filter((x) => x.code === "PLAN_HLS_OPUS_WEBM_UNSUPPORTED")
				.map((x) => x.path),
		).toEqual([`muxings[${opus}]`]);
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
	it("enforces per-encoding conform consistency, subtitle restrictions and codec frame rates", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		plan.filters = [
			{ key: "rate", kind: "CONFORM", targetFps: 25 },
			{ key: "other", kind: "CONFORM", targetFps: 24 },
		];
		const [first, second] = plan.renditions;
		if (!first || !second) throw new Error("Missing renditions");
		first.filters = [{ filterKey: "rate", position: 0 }];
		const conformIssues = () =>
			validatePlan(plan).filter((i) => i.code === "PLAN_CONFORM_FILTER");
		expect(conformIssues().length).toBeGreaterThan(0);
		for (const rendition of plan.renditions) {
			rendition.filters = [{ filterKey: "rate", position: 0 }];
			if (rendition.codec === "H264") rendition.rate = 25;
		}
		expect(conformIssues()).toEqual([]);
		second.filters = [{ filterKey: "other", position: 0 }];
		expect(conformIssues().length).toBeGreaterThan(0);
		second.filters = [
			{ filterKey: "rate", position: 0 },
			{ filterKey: "other", position: 1 },
		];
		expect(conformIssues().length).toBeGreaterThan(0);
		second.filters.pop();
		const video = plan.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("Missing video");
		video.rate = 30;
		expect(conformIssues().length).toBeGreaterThan(0);
		video.rate = 25;
		const subs = imscPlan().renditions.find((r) => r.codec === "IMSC");
		if (!subs) throw new Error("Missing captions");
		subs.filters = [{ filterKey: "rate", position: 0 }];
		plan.renditions.push(subs);
		expect(conformIssues().length).toBeGreaterThan(0);
		subs.encodingKey = "other";
		delete subs.filters;
		expect(conformIssues()).toEqual([]);
	});
	it("keeps ordinary storage-object keys containing punctuation executable and rejects incorrect filter speaker mappings", () => {
		expect(
			encodingPlanSchema.shape.filters.safeParse([
				{
					key: "logo",
					kind: "WATERMARK",
					inputKey: "main",
					imagePath: "brand:promo@2x.png",
					left: 0,
					top: 0,
				},
			]).success,
		).toBe(true);
		for (const [channelLayout, count] of [
			["2.1", 3],
			["5.0", 5],
			["HEXAGONAL", 6],
			["STEREO_DOWNMIX", 4],
		] as const) {
			const audioMixChannels = Array.from({ length: count }, (_, i) => ({
				channelNumber: i,
				sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: i }],
			}));
			expect(
				encodingPlanSchema.shape.filters.safeParse([
					{ kind: "AUDIO_MIX", key: "pan", channelLayout, audioMixChannels },
				]).success,
			).toBe(false);
		}
	});
	it("refuses skipped filters on an Atmos file and rejects downstream processing before input mixing", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const audio = plan.renditions.find((r) => r.codec === "AAC");
		if (!audio) throw new Error("Missing audio");
		plan.filters = [
			{
				key: "pan",
				kind: "AUDIO_MIX",
				channelLayout: "STEREO",
				audioMixChannels: [0, 1].map((n) => ({
					channelNumber: n,
					sourceChannels: [
						{ type: "CHANNEL_NUMBER", channelNumber: n, gain: n === 1 ? 0 : 1 },
					],
				})),
			},
			{ key: "ebu", kind: "EBU_R128_SINGLE_PASS" },
			{ key: "dolby", kind: "DOLBY_LOUDNESS" },
			{ key: "volume", kind: "AUDIO_VOLUME", volume: 100, unit: "PERCENT" },
			{ key: "rate", kind: "CONFORM", targetFps: 25 },
		];
		for (const key of ["ebu", "dolby", "volume"]) {
			audio.filters = [
				{ filterKey: "pan", position: 1 },
				{ filterKey: key, position: 0 },
			];
			expect(validatePlan(plan).map((i) => i.code)).toContain(
				"PLAN_AUDIO_FILTER",
			);
			audio.filters = [
				{ filterKey: key, position: 1 },
				{ filterKey: "pan", position: 0 },
			];
			expect(
				validatePlan(plan).filter((i) => i.code === "PLAN_AUDIO_FILTER"),
			).toEqual([]);
		}
		for (const key of ["volume", "ebu"]) {
			audio.filters = [
				{ filterKey: "pan", position: 0 },
				{ filterKey: key, position: 1 },
				{ filterKey: "dolby", position: 2 },
			];
			expect(validatePlan(plan).map((issue) => issue.code)).toContain(
				"PLAN_AUDIO_FILTER",
			);
		}
		Object.assign(audio, { codec: "DOLBY_ATMOS", ingestKey: "adm" });
		plan.dolbyStreams = [
			{
				kind: "ATMOS",
				key: "adm",
				inputKey: plan.inputs[0]?.key ?? "main",
				inputPath: "input.wav",
				inputFormat: "ADM",
			},
		];
		for (const rendition of plan.renditions)
			rendition.filters = [{ filterKey: "rate", position: 0 }];
		audio.filters?.push({ filterKey: "pan", position: 1 });
		const codes = validatePlan(plan)
			.filter(
				(i) =>
					i.path === `renditions[${plan.renditions.indexOf(audio)}].filters`,
			)
			.map((i) => i.code);
		expect(codes).toContain("PLAN_AUDIO_FILTER");
		expect(codes).toContain("PLAN_CONFORM_FILTER");
		Object.assign(audio, { codec: "AAC", ingestKey: "trimmed-adm" });
		plan.trimmingStreams = [
			{
				kind: "TIME_BASED",
				key: "trimmed-adm",
				sourceKey: "adm",
				offset: 1,
				duration: 5,
			},
		];
		const trimmed = validatePlan(plan)
			.filter(
				(issue) =>
					issue.path ===
					`renditions[${plan.renditions.indexOf(audio)}].filters`,
			)
			.map((issue) => issue.code);
		expect(trimmed).toContain("PLAN_AUDIO_FILTER");
		expect(trimmed).toContain("PLAN_CONFORM_FILTER");
	});
	it("requires the same speaker positions when Audio Mix derives its layout from the output rows", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const audio = plan.renditions.find((r) => r.codec === "AAC");
		if (!audio) throw new Error("Missing audio");
		Object.assign(audio, {
			codec: "DDPLUS",
			channelLayout: "CL_QUAD_LFE",
			filters: [{ filterKey: "pan", position: 0 }],
		});
		const channels = Array.from({ length: 5 }, (_, i) => ({
			channelNumber: i,
			sourceChannels: [{ type: "CHANNEL_NUMBER" as const, channelNumber: i }],
		}));
		plan.filters = [
			{
				key: "pan",
				kind: "AUDIO_MIX",
				channelLayout: "NONE",
				audioMixChannels: channels,
			},
		];
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_AUDIO_FILTER",
		);
		Object.assign(audio, { codec: "AAC", channelLayout: "CL_5_0_BACK" });
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_AUDIO_FILTER"),
		).toEqual([]);
		channels.pop();
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_AUDIO_FILTER",
		);
		Object.assign(audio, { channelLayout: "NONE" });
		for (const count of [8, 9, 16, 17, 24, 25]) {
			channels.splice(
				0,
				channels.length,
				...Array.from({ length: count }, (_, n) => ({
					channelNumber: n,
					sourceChannels: [
						{ type: "CHANNEL_NUMBER" as const, channelNumber: 0 },
					],
				})),
			);
			expect(
				validatePlan(plan).some((issue) => issue.code === "PLAN_AUDIO_FILTER"),
			).toBe([9, 17, 25].includes(count));
		}
	});
	it("rejects mutually exclusive deinterlace filters and unrepresentable enhanced watermark geometry", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const video = plan.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("Missing video");
		plan.filters = encodingPlanSchema.shape.filters.parse([
			{ key: "normal", kind: "DEINTERLACE" },
			{ key: "enhanced", kind: "ENHANCED_DEINTERLACE" },
		]);
		video.filters = plan.filters.map((f, position) => ({
			filterKey: f.key,
			position,
		}));
		expect(validatePlan(plan).map((i) => i.code)).toContain(
			"PLAN_DEINTERLACE_CONFLICT",
		);
		const mark = {
			key: "logo",
			kind: "ENHANCED_WATERMARK",
			inputKey: "main",
			imagePath: "logo.png",
			left: 0,
			top: 0,
		};
		const parses = (over: Record<string, unknown>) =>
			encodingPlanSchema.shape.filters.safeParse([{ ...mark, ...over }])
				.success;
		for (const over of [
			{ width: 0.5 },
			{ unit: "PERCENTS", height: 101 },
			{ unit: "PERCENTS", width: 0.01 },
			{ top: undefined },
			{ left: undefined },
			{ left: 0, right: 0 },
		])
			expect(parses(over)).toBe(false);
		expect(
			parses({ unit: "PERCENTS", width: 0.1, height: 100, opacity: 0 }),
		).toBe(true);
	});
	it("refuses Conform on a one-entry concatenation while accepting a strict multi-entry programme", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		plan.filters = [{ key: "rate", kind: "CONFORM", targetFps: 25 }];
		for (const r of plan.renditions) {
			const key = `join-${r.key}`;
			const trimKey = `trim-${r.key}`;
			plan.trimmingStreams.push({
				key: trimKey,
				kind: "TIME_BASED",
				sourceKey: r.ingestKey,
				offset: 0,
				duration: 10,
			});
			plan.concatenationStreams.push({
				key,
				sources: [{ sourceKey: trimKey, position: 0 }],
			});
			r.ingestKey = key;
			r.filters = [{ filterKey: "rate", position: 0 }];
		}
		const problems = () =>
			validatePlan(plan).filter((i) => i.code === "PLAN_CONFORM_CONCATENATION");
		expect(problems().length).toBeGreaterThan(0);
		for (const concat of plan.concatenationStreams) {
			const [first] = concat.sources;
			if (!first) throw new Error("Missing concat entry");
			concat.sources.push({ ...first, position: 1 });
		}
		expect(problems()).toEqual([]);
		const first = plan.concatenationStreams[0];
		if (!first?.sources[0]) throw new Error("Missing join");
		first.sources.push({ ...first.sources[0], position: 2 });
		plan.renditions = plan.renditions.filter((r) => r.codec === "H264");
		expect(problems().length).toBeGreaterThan(0);
	});
	it("rejects stream-level audio filters that would fail at start or be silently ignored by the encoder", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const audio = plan.renditions.find((r) => r.codec === "AAC");
		if (!audio) throw new Error("Missing audio");
		plan.filters = [
			{ key: "level", kind: "DOLBY_LOUDNESS" },
			{ key: "level2", kind: "DOLBY_LOUDNESS" },
			{
				key: "mix",
				kind: "AUDIO_MIX",
				channelLayout: "MONO",
				audioMixChannels: [
					{ channelNumber: 0, sourceChannels: [{ type: "CENTER" }] },
				],
			},
		];
		const issues = () =>
			validatePlan(plan).filter(
				(i) =>
					i.code === "PLAN_AUDIO_FILTER" ||
					i.code === "PLAN_FILTER_ENCODER_VERSION",
			);
		audio.filters = [
			{ filterKey: "level", position: 0 },
			{ filterKey: "level2", position: 1 },
		];
		expect(issues()).toHaveLength(1);
		audio.filters.pop();
		plan.bitmovin.encoderVersion = "2.281.0";
		expect(issues()).toHaveLength(1);
		plan.bitmovin.encoderVersion = "2.282.0";
		expect(issues()).toEqual([]);
		plan.generation.audioVideoSyncMode = "RESYNC_AT_START";
		expect(issues()).toHaveLength(1);
		delete plan.generation.audioVideoSyncMode;
		plan.kantar = {
			credentialId: "11111111-1111-4111-8111-111111111111",
			licenseId: 1,
			channelName: "main",
			contentReference: "movie",
			serverUrl: "https://kantar.example",
			reportDestination: { outputKey: "reports", path: "reports/" },
		};
		expect(issues()).toHaveLength(1);
		delete plan.kantar;
		audio.filters = [{ filterKey: "mix", position: 0 }];
		expect(issues()).toHaveLength(1);
		audio.channelLayout = "MONO";
		expect(issues()).toEqual([]);
		plan.audioMixStreams = [
			{
				key: "mixed",
				channelLayout: "MONO",
				audioMixChannels: [
					{
						sourceKey: audio.ingestKey,
						outputChannelType: "CENTER",
						sourceChannels: [{ type: "CENTER" }],
					},
				],
			},
		];
		audio.ingestKey = "mixed";
		expect(issues()).toHaveLength(1);
		const mix = plan.audioMixStreams[0];
		const source = plan.ingest[0];
		if (!mix || !source) throw new Error("Missing input mix");
		const originalTrack = plan.ingest.find(
			(i) => i.key === mix.audioMixChannels[0]?.sourceKey,
		);
		if (!originalTrack) throw new Error("Missing audio track");
		originalTrack.selectionMode = "POSITION_ABSOLUTE";
		originalTrack.position = 0;
		plan.ingest.push({
			...originalTrack,
			key: "relative",
			selectionMode: "AUDIO_RELATIVE",
		});
		mix.audioMixChannels.push({
			sourceKey: "relative",
			outputChannelType: "FRONT_RIGHT",
			sourceChannels: [{ type: "FRONT_RIGHT" }],
		});
		expect(issues()).toHaveLength(1);
		mix.audioMixChannels.pop();
		// A multi-track merge subsequently applies the rendition filter.
		plan.ingest.push({
			...source,
			key: "second-track",
			inputPath: "second-audio.wav",
		});
		mix.audioMixChannels.push({
			sourceKey: "second-track",
			outputChannelType: "FRONT_RIGHT",
			sourceChannels: [{ type: "FRONT_RIGHT" }],
		});
		expect(issues()).toEqual([]);
	});
	it("retains field conversion and fractional conform in the rendition attachment order", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const video = plan.renditions.find((item) => item.codec === "H264");
		if (!video) throw new Error("Missing fixture video");
		plan.filters = [
			{
				key: "fields",
				kind: "ENHANCED_DEINTERLACE",
				mode: "FIELD",
				parity: "TOP_FIELD_FIRST",
				autoEnable: "META_DATA_BASED",
			},
			{ key: "rate", kind: "CONFORM", targetFps: 24_000 / 1_001 },
			{
				key: "output",
				kind: "INTERLACE",
				mode: "TOP",
				verticalLowPassFilteringMode: "LOW_PASS",
			},
		];
		video.filters = plan.filters.map((f, position) => ({
			filterKey: f.key,
			position,
		}));
		for (const rendition of plan.renditions) {
			if (rendition.codec === "H264") delete rendition.rate;
			if (rendition !== video)
				rendition.filters = [{ filterKey: "rate", position: 0 }];
		}
		const normalized = encodingPlanSchema.parse(plan);
		expect(validatePlan(normalized).filter((i) => i.level === "error")).toEqual(
			[],
		);
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(normalized)))
				.filters,
		).toEqual(plan.filters);
		const ops = compilePlan(normalized);
		expect(
			ops
				.filter((op) => op.step.startsWith(`filter:${video.key}:`))
				.map((op) => op.kind),
		).toEqual([
			"CREATE_FILTER_ENHANCED_DEINTERLACE",
			"CREATE_FILTER_CONFORM",
			"CREATE_FILTER_INTERLACE",
		]);
		expect(
			ops.find((op) => op.kind === "CREATE_FILTER_CONFORM")?.payload.targetFps,
		).toBe(24_000 / 1_001);
		expect(
			encodingPlanSchema.safeParse({
				...plan,
				filters: [{ key: "rate", kind: "CONFORM", targetFps: 0 }],
			}).success,
		).toBe(false);
	});

	it("uses the native codec precision consistently across streams with configured fractional Conform rates", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const target = 24000 / 1001;
		plan.filters = [{ key: "rate", kind: "CONFORM", targetFps: target }];
		for (const r of plan.renditions) {
			r.filters = [{ filterKey: "rate", position: 0 }];
			if (r.codec === "H264") r.rate = target;
		}
		expect(
			validatePlan(plan).filter((i) => i.code === "PLAN_CONFORM_FILTER"),
		).toEqual([]);
		const ops = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_FILTER_CONFORM",
		);
		expect(ops).toHaveLength(plan.renditions.length);
		expect(
			ops.every((op) => op.payload.targetFps === Math.fround(target)),
		).toBe(true);
		const rows = Object.values<{ properties: { targetFps: number } }>(
			parse(planToEncodingTemplateYaml(plan)).filters.conform,
		);
		expect(rows).toHaveLength(ops.length);
		expect(
			rows.every((row) => row.properties.targetFps === Math.fround(target)),
		).toBe(true);
		expect(plan.filters[0]).toMatchObject({ targetFps: target });
		// Another encoding can share the same authored filter without inheriting
		// this ladder's codec precision requirement.
		const separate = structuredClone(plan);
		separate.encodings = [
			{ key: "configured", name: "Configured" },
			{ key: "from-source", name: "Source" },
		];
		for (const r of separate.renditions) r.encodingKey = "configured";
		const other = separate.renditions.find((r) => r.codec === "H264");
		if (!other) throw new Error("Missing video");
		const sourceVideo = {
			...other,
			key: "source-fps",
			encodingKey: "from-source",
		};
		delete sourceVideo.rate;
		separate.renditions.push(sourceVideo);
		expect(
			compilePlan(separate).find((op) => op.step === "filter:source-fps:rate")
				?.payload.targetFps,
		).toBe(target);
		const video = plan.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("Missing video");
		video.rate = 24;
		expect(
			validatePlan(plan).some((i) => i.code === "PLAN_CONFORM_FILTER"),
		).toBe(true);
	});

	it("exports different image placeholders for distinct watermark keys that normalize to the same name", () => {
		const plan = sourcePlan("fixed-bitrate-dash-hls-streamcondition-on-aws");
		const video = plan.renditions.find((r) => r.codec === "H264");
		const [input] = plan.inputs;
		if (!video || !input) throw new Error("Missing fixture");
		plan.filters = ["logo-a", "logo_a"].map((key, i) => ({
			key,
			kind: "ENHANCED_WATERMARK",
			inputKey: input.key,
			imagePath: `logos/${i}.png`,
			left: 0,
			top: 0,
		}));
		video.filters = plan.filters.map((f, position) => ({
			filterKey: f.key,
			position,
		}));
		const doc = parse(planToEncodingTemplateYaml(plan));
		const group = doc.filters.enhancedWatermark;
		expect(group[`${video.key}-logo-a`].properties.image).not.toEqual(
			group[`${video.key}-logo_a`].properties.image,
		);
	});
	it("exports audio channel gains and loudness, and keeps the enhanced watermark out of the template as a signed URL", () => {
		const value = imscPlan();
		const audio = value.renditions.find((r) => r.codec === "AAC"),
			video = value.renditions.find((r) => r.codec === "H264");
		const storage = value.inputs.find((r) => r.kind === "S3");
		if (!audio || !video || !storage) throw new Error("Missing fixture inputs");
		audio.channelLayout = "MONO";
		value.filters = [
			{
				key: "mix",
				kind: "AUDIO_MIX",
				channelLayout: "MONO",
				audioMixChannels: [
					{
						channelNumber: 0,
						sourceChannels: [
							{ type: "FRONT_LEFT", gain: -0.5 },
							{ type: "FRONT_RIGHT", gain: 0 },
						],
					},
				],
			},
			{
				key: "loudness",
				kind: "DOLBY_LOUDNESS",
				targetLoudness: -23,
				maximumTruePeakLevel: -2,
				speechDetectionThreshold: 0,
			},
			{
				key: "mark",
				kind: "ENHANCED_WATERMARK",
				inputKey: storage.key,
				imagePath: "private/logo.png",
				left: 0,
				top: 0,
				height: 10.5,
				opacity: 0,
			},
		];
		audio.filters = [
			{ filterKey: "loudness", position: 1 },
			{ filterKey: "mix", position: 0 },
		];
		video.filters = [{ filterKey: "mark", position: 0 }];
		expect(validatePlan(value).filter((i) => i.level === "error")).toEqual([]);
		expect(() => planToEncodingTemplateYaml(value)).toThrow(/Dolby Loudness/i);
		const templatePlan = structuredClone(value);
		for (const rendition of templatePlan.renditions)
			if (rendition.filters)
				rendition.filters = rendition.filters.filter(
					(f) => f.filterKey !== "loudness",
				);
		const template = planToEncodingTemplateYaml(templatePlan);
		const parsed = parse(template);
		const key = (filter: string) => `${audio.key}-${filter}`;
		expect(
			parsed.filters.audioMix[key("mix")].properties.audioMixChannels[0]
				.sourceChannels[1].gain,
		).toBe(0);
		expect(parsed.filters).not.toHaveProperty("dolbyLoudness");
		const watermark =
			parsed.filters.enhancedWatermark[`${video.key}-mark`].properties;
		expect(watermark).toMatchObject({
			height: 10.5,
			opacity: 0,
			image: expect.stringContaining("WATERMARK"),
		});
		expect(watermark).not.toHaveProperty("inputKey");
		expect(watermark).not.toHaveProperty("imagePath");
		const attached = compilePlan(value).find(
			(op) =>
				op.kind === "CREATE_STREAM_FILTERS" &&
				op.step.endsWith(`:${audio.key}`),
		);
		expect(attached?.payload.positions).toEqual([1, 0]);
		expect(attached?.refs.filterIds).toEqual([
			`filter:${audio.key}:loudness`,
			`filter:${audio.key}:mix`,
		]);
		Object.assign(audio, { codec: "AC3" });
		expect(validatePlan(value)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_FILTER_MEDIA_TYPE",
				path: expect.stringContaining(".filters[0]"),
			}),
		);
	});
	it.each([
		{ key: "f", kind: "DOLBY_LOUDNESS", targetLoudness: -23.5 },
		{ key: "f", kind: "DOLBY_LOUDNESS", speechDetectionThreshold: 20.5 },
		{
			key: "f",
			kind: "AUDIO_MIX",
			channelLayout: "STEREO",
			audioMixChannels: [
				{ channelNumber: 0, sourceChannels: [{ type: "FRONT_LEFT" }] },
				{
					channelNumber: 1,
					sourceChannels: [{ type: "CHANNEL_NUMBER", channelNumber: 1 }],
				},
			],
		},
		{
			key: "f",
			kind: "DOLBY_LOUDNESS",
			targetLoudness: -8,
			maximumTruePeakLevel: -3,
		},
		{
			key: "f",
			kind: "ENHANCED_WATERMARK",
			inputKey: "input",
			imagePath: "https://private.example/logo?token=test",
		},
		{
			key: "f",
			kind: "ENHANCED_WATERMARK",
			inputKey: "input",
			imagePath: "logo.png",
			opacity: 1.1,
		},
		{
			key: "f",
			kind: "AUDIO_MIX",
			channelLayout: "STEREO",
			audioMixChannels: [
				{ channelNumber: 0, sourceChannels: [{ type: "FRONT_LEFT" }] },
			],
		},
		{
			key: "f",
			kind: "AUDIO_MIX",
			channelLayout: "MONO",
			audioMixChannels: [
				{
					channelNumber: 0,
					sourceChannels: [{ type: "FRONT_LEFT", channelNumber: 1 }],
				},
			],
		},
	])("rejects an invalid authored broadcast filter %#", (filter) => {
		expect(
			encodingPlanSchema.safeParse({ ...imscPlan(), filters: [filter] })
				.success,
		).toBe(false);
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
