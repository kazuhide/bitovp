import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";

function copiedSource() {
	const state: WizardState = structuredClone(DEFAULT_WIZARD_STATE);
	const credentialId = "00000000-0000-4000-8000-000000000001";
	const media = {
		key: "main",
		inputKey: "main",
		kind: "S3" as const,
		bucket: "original",
		credentialId,
		path: "program.wav",
	};
	state.name = "Picture with separate assets";
	state.inputFiles = [media, { ...media, key: "picture", path: "picture.mxf" }];
	state.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: "picture",
				metadataInputPath: "meta.json",
				selectionMode: "AUTO",
			},
		],
	};
	state.videos = [
		{
			codec: "H265",
			height: 1080,
			bitrate: 4000000,
			h265: { profile: "MAIN10", dynamicRangeFormat: "HDR10" },
			extras: { source: "hdr", filters: [{ filterKey: "logo", position: 0 }] },
		},
	];
	state.filters = [
		{
			key: "logo",
			kind: "WATERMARK",
			inputKey: "main",
			imagePath: "logo.png",
			left: 0,
			top: 0,
		},
	];
	state.output = {
		...state.output,
		bucket: "output",
		credentialId,
		basePath: "output/",
	};
	return encodingPlanSchema.parse(buildPlan(state));
}
describe("copied picture and storage identities", () => {
	it("allocates the implicit picture after both HDR and embedded caption sources", () => {
		const form = planToWizardState(copiedSource());
		const hdr = form.sources?.hdr10PlusStreams?.[0],
			video = form.videos[0];
		if (!form.sources || !hdr || !video?.extras)
			throw Error("missing imported HDR");
		hdr.key = "video";
		form.sources.captionStreams = [
			{ kind: "CEA708", key: "video-input-1", inputFile: hdr.videoInputFile },
		];
		delete video.extras.source;
		const plan = encodingPlanSchema.parse(buildPlan(form));
		expect(plan.renditions[0]?.ingestKey).toBe("video-input-2");
		expect(
			plan.ingest.find((i) => i.selectionMode === "VIDEO_RELATIVE")?.key,
		).toBe("video-input-2");
		expect(plan.captionStreams[0]?.key).toBe("video-input-1");
	});
	it.each([
		"program.wav",
		"picture.mxf",
		"logo.png",
	])("moving only %s keeps the logo on its own chosen input", (path) => {
		const source = copiedSource(),
			form = planToWizardState(source);
		const moved = form.inputFiles.find((f) => f.path === path);
		expect(moved).toBeDefined();
		if (!moved) throw new Error("missing imported media or logo row");
		moved.bucket = "moved";
		const rebuilt = encodingPlanSchema.parse(buildPlan(form));
		const filter = rebuilt.filters.find((f) => f.kind === "WATERMARK");
		if (filter?.kind !== "WATERMARK") throw new Error("missing watermark");
		expect(rebuilt.inputs.find((i) => i.key === filter.inputKey)).toMatchObject(
			{ bucket: path === "logo.png" ? "moved" : "original" },
		);
		expect(
			compilePlan(rebuilt).find((op) => op.kind === "CREATE_FILTER_WATERMARK")
				?.payload,
		).toMatchObject({
			imagePath: "logo.png",
			imageInput: { bucket: path === "logo.png" ? "moved" : "original" },
		});
	});
	it("reserves declared provider keys before allocating copied file-row identities", () => {
		const source = copiedSource();
		const first = source.inputs[0];
		if (!first) throw new Error("missing storage declaration");
		const second = { ...first, key: "main-2", bucket: "logo-bucket" };
		const original = encodingPlanSchema.parse({
			...source,
			inputs: [first, second],
			filters: source.filters.map((f) => ({ ...f, inputKey: "main-2" })),
		});
		const form = planToWizardState(original);
		expect(new Set(form.inputFiles.map((f) => f.key)).size).toBe(
			form.inputFiles.length,
		);
		expect(encodingPlanSchema.parse(buildPlan(form))).toEqual(original);
	});
	it("holds a Dolby Vision XML selection on a different provider input until the operator chooses matching storage", () => {
		const original = copiedSource();
		const form = planToWizardState({
			...original,
			dolbyStreams: [
				{
					key: "dv",
					kind: "VISION",
					inputKey: "main",
					videoInputPath: "picture.mxf",
					metadataInputPath: "vision.xml",
				},
			],
		});
		const picture = form.inputFiles.find((f) => f.path === "picture.mxf"),
			xml = form.inputFiles.find((f) => f.path === "vision.xml");
		if (!picture || !xml) throw new Error("missing VISION file");
		picture.bucket = "moved";
		expect(encodingPlanSchema.safeParse(buildPlan(form)).success).toBe(false);
		xml.bucket = "moved";
		const resolved = encodingPlanSchema.parse(buildPlan(form)),
			dv = resolved.dolbyStreams[0];
		expect(dv).toMatchObject({
			videoInputPath: "picture.mxf",
			metadataInputPath: "vision.xml",
		});
		expect(resolved.inputs.find((i) => i.key === dv?.inputKey)).toMatchObject({
			bucket: "moved",
		});
	});
	it.each([
		false,
		true,
	])("retains the copied picture and separate audio while switching to implicit video (separate buckets %s)", (separate) => {
		const source = copiedSource();
		const first = source.inputs[0];
		if (!first) throw new Error("missing input");
		const native = encodingPlanSchema.parse({
			...source,
			inputs: separate
				? [
						...source.inputs,
						{ ...first, key: "picture-storage", bucket: "pictures" },
					]
				: source.inputs,
			hdr10PlusStreams: source.hdr10PlusStreams.map((s) => ({
				...s,
				key: "video",
				inputKey: separate ? "picture-storage" : s.inputKey,
			})),
			renditions: source.renditions.map((r) =>
				r.ingestKey === "hdr" ? { ...r, ingestKey: "video" } : r,
			),
		});
		const form = planToWizardState(native);
		expect(form.videos[0]?.extras?.source).toBe("video");
		expect(encodingPlanSchema.parse(buildPlan(form))).toEqual(native);
		const video = form.videos[0];
		if (!video) throw new Error("missing HEVC rendition");
		delete video.extras?.source;
		const switched = encodingPlanSchema.parse(buildPlan(form));
		const sourceKey = switched.renditions.find(
			(r) => r.codec === "H265",
		)?.ingestKey;
		expect(sourceKey).not.toBe("video");
		expect(switched.ingest.find((s) => s.key === sourceKey)).toMatchObject({
			selectionMode: "VIDEO_RELATIVE",
			inputPath: "picture.mxf",
			inputKey: separate ? "picture-storage" : "main",
		});
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(switched))),
		).toEqual(switched);
	});
	it.each([
		false,
		true,
	])("uses the first rendition's wrapped picture on a copied plan with another HDR picture (concat %s)", (concat) => {
		const source = copiedSource();
		const video = source.renditions.find((r) => r.codec === "H265");
		if (!video) throw new Error("missing video");
		const raw = encodingPlanSchema.parse({
			...source,
			ingest: [
				...source.ingest,
				{
					key: "master",
					inputKey: "main",
					inputPath: "ordinary.mxf",
					selectionMode: "VIDEO_RELATIVE",
					position: 0,
				},
			],
			trimmingStreams: [
				{
					key: "clipped",
					kind: "TIME_BASED",
					sourceKey: "master",
					offset: 0,
					duration: 1,
				},
			],
			...(concat
				? {
						concatenationStreams: [
							{
								key: "joined",
								sources: [{ sourceKey: "clipped", isMain: true, position: 0 }],
							},
						],
					}
				: {}),
			renditions: [
				{ ...video, key: "first", ingestKey: concat ? "joined" : "clipped" },
				...source.renditions,
			],
		});
		const state = planToWizardState(raw);
		for (const [i, rendition] of state.videos.entries())
			if (i === 0)
				rendition.extras = { ...rendition.extras, source: undefined };
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(
			rebuilt.ingest.find(
				(r) =>
					r.key ===
					rebuilt.renditions.find((r) => r.key === "first")?.ingestKey,
			)?.inputPath,
		).toBe("ordinary.mxf");
	});
	it.each([
		false,
		true,
	])("opens a mixed copy on the ordinary video file even when the first rendition uses HDR (wrapped %s)", (wrapped) => {
		const state = planToWizardState(copiedSource());
		const accountCredential = crypto.randomUUID();
		for (const row of state.inputFiles) row.credentialId = accountCredential;
		state.output.credentialId = accountCredential;
		const picture = state.inputFiles[0],
			hdr = state.videos[0];
		if (!picture || !hdr) throw new Error("missing HDR picture");
		state.inputFiles.unshift({
			...picture,
			key: "ordinary-master",
			path: "ordinary-master.mov",
		});
		if (wrapped) {
			state.sources = {
				...state.sources,
				trimmingStreams: [
					{
						kind: "TIME_BASED",
						key: "trimmed",
						sourceKey: "hdr",
						offset: 0,
						duration: 1,
					},
				],
			};
			hdr.extras = { ...hdr.extras, source: "trimmed" };
		}
		state.videos.push({ ...hdr, height: 720, extras: undefined });
		const plan = encodingPlanSchema.parse(buildPlan(state));
		const copied = tryImportPresetIntoWizard(plan);
		expect(copied.ok).toBe(true);
		if (!copied.ok) return;
		expect(copied.state.inputFiles[0]?.path).toBe("ordinary-master.mov");
		expect(encodingPlanSchema.parse(buildPlan(copied.state))).toEqual(plan);
	});
	it("adds implicit audio to an HDR master named audio without changing its video binding", () => {
		const source = copiedSource();
		const native = encodingPlanSchema.parse({
			...source,
			ingest: [],
			hdr10PlusStreams: source.hdr10PlusStreams.map((s) => ({
				...s,
				key: "audio",
			})),
			renditions: source.renditions
				.filter((r) => r.codec === "H265")
				.map((r) => ({ ...r, ingestKey: "audio" })),
		});
		const form = planToWizardState(native);
		form.audios = structuredClone(DEFAULT_WIZARD_STATE.audios);
		const rebuilt = encodingPlanSchema.parse(buildPlan(form));
		const audio = rebuilt.renditions.find((r) => r.codec === "AAC");
		expect(audio?.ingestKey).not.toBe("audio");
		expect(
			rebuilt.ingest.find((row) => row.key === audio?.ingestKey),
		).toMatchObject({
			selectionMode: "AUDIO_RELATIVE",
			inputPath: "picture.mxf",
		});
		expect(rebuilt.renditions.find((r) => r.codec === "H265")?.ingestKey).toBe(
			"audio",
		);
	});
	it.each([
		"picture.mxf",
		"/picture.mxf",
	])("rejects a metadata selection pointing to the same picture %s", (path) => {
		const source = copiedSource();
		expect(
			encodingPlanSchema.safeParse({
				...source,
				hdr10PlusStreams: source.hdr10PlusStreams.map((s) => ({
					...s,
					metadataInputPath: path,
				})),
			}).success,
		).toBe(false);
	});
});
