import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { validatePlan } from "../plan/validate";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	remapEncodingKeyRefs,
	remapInputKeyRefs,
	type WizardState,
} from "./build-plan";
import {
	applyPreparedVodInputTimeline,
	applyVodInputTimeline,
} from "./input-timeline";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";

function state(): WizardState {
	const value = structuredClone(DEFAULT_WIZARD_STATE);
	value.name = "HDR10+ wizard";
	value.inputFiles[0] = {
		key: "main",
		inputKey: "main",
		kind: "S3",
		credentialId: "11111111-1111-4111-8111-111111111111",
		bucket: "input",
		path: "video/hdr10.mov",
	};
	value.output = {
		...value.output,
		credentialId: "11111111-1111-4111-8111-111111111111",
		bucket: "output",
		basePath: "hdr10plus/",
	};
	value.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr-plus",
				videoInputFile: "main",
				metadataInputPath: "metadata/hdr10plus.json",
				selectionMode: "AUTO",
			},
		],
	};
	value.videos = [
		{
			codec: "H265",
			height: 1080,
			bitrate: 5_000_000,
			h265: { profile: "MAIN10", dynamicRangeFormat: "HDR10" },
			extras: { source: "hdr-plus" },
		},
	];
	return value;
}

function hdr10PlusSource(value: WizardState) {
	const source = value.sources?.hdr10PlusStreams?.[0];
	if (!source) throw new Error("Missing HDR10+ source");
	return source;
}

describe("HDR10+ wizard source", () => {
	it("splits a copied shared input when the picture and JSON move to another store", () => {
		const original = state();
		const base = original.inputFiles[0];
		if (!base) throw new Error("missing input");
		original.inputFiles.push({
			...base,
			key: "picture-file",
			path: "old-picture.mov",
		});
		hdr10PlusSource(original).videoInputFile = "picture-file";
		const copied = planToWizardState(
			encodingPlanSchema.parse(buildPlan(original)),
		);
		const picture = copied.inputFiles.find(
			(file) => file.path === "old-picture.mov",
		);
		if (!picture) throw new Error("missing copied picture");
		picture.bucket = "new-bucket";
		picture.credentialId = "22222222-2222-4222-8222-222222222222";
		picture.path = "new-picture.mov";
		hdr10PlusSource(copied).metadataInputPath = "new-picture.json";
		const built = encodingPlanSchema.parse(buildPlan(copied));
		const source = built.hdr10PlusStreams[0];
		expect(source).toMatchObject({
			videoInputPath: "new-picture.mov",
			metadataInputPath: "new-picture.json",
		});
		expect(
			built.inputs.find((input) => input.key === source?.inputKey),
		).toMatchObject({
			bucket: "new-bucket",
			credentialId: picture.credentialId,
		});
		expect(
			built.inputs.find((input) => input.key === built.ingest[0]?.inputKey),
		).toMatchObject({ bucket: "input", credentialId: base.credentialId });
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(built))),
		).toEqual(built);
	});
	it.each([
		{ selectionMode: "AUTO" as const },
		{ selectionMode: "VIDEO_RELATIVE" as const },
		{ selectionMode: "VIDEO_RELATIVE" as const, position: 0 },
		{ selectionMode: "POSITION_ABSOLUTE" as const, position: 3 },
	])("round-trips a same-input sidecar with $selectionMode and $position", (selection) => {
		const original = state();
		Object.assign(hdr10PlusSource(original), selection);
		const plan = encodingPlanSchema.parse(buildPlan(original));
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const restored = planToWizardState(plan);
		expect(restored.inputFiles).toHaveLength(1);
		expect(restored.inputFiles[0]?.path).toBe("video/hdr10.mov");
		expect(restored.sources?.hdr10PlusStreams?.[0]).toMatchObject({
			metadataInputPath: "metadata/hdr10plus.json",
			...selection,
		});
		if (!("position" in selection))
			expect(restored.sources?.hdr10PlusStreams?.[0]).not.toHaveProperty(
				"position",
			);
		expect(encodingPlanSchema.parse(buildPlan(restored))).toEqual(plan);
		expect(tryImportPresetIntoWizard(plan).ok).toBe(true);
	});

	it("keeps invalid AUTO position available for validation", () => {
		const value = state();
		hdr10PlusSource(value).position = 0;
		const raw = buildPlan(value);
		expect(raw.hdr10PlusStreams?.[0]?.position).toBe(0);
		const parsed = encodingPlanSchema.safeParse(raw);
		expect(
			parsed.success &&
				validatePlan(parsed.data).every((issue) => issue.level !== "error"),
		).toBe(false);
	});

	it("remaps references without altering the literal JSON path", () => {
		const value = state();
		hdr10PlusSource(value).encodingKey = "first";
		const filePatch = remapInputKeyRefs(value, "main", "renamed");
		expect(filePatch.sources?.hdr10PlusStreams?.[0]).toMatchObject({
			videoInputFile: "renamed",
			metadataInputPath: "metadata/hdr10plus.json",
		});
		const encodingPatch = remapEncodingKeyRefs(value, "first", "second");
		expect(encodingPatch.sources?.hdr10PlusStreams?.[0]?.encodingKey).toBe(
			"second",
		);
	});

	it("does not silently retarget a removed video input to the primary source", () => {
		const value = state();
		hdr10PlusSource(value).videoInputFile = "removed";
		const raw = buildPlan(value);
		expect(raw.hdr10PlusStreams?.[0]).toMatchObject({
			inputKey: "removed",
			videoInputPath: "",
		});
		const parsed = encodingPlanSchema.safeParse(raw);
		expect(
			parsed.success &&
				validatePlan(parsed.data).every((issue) => issue.level !== "error"),
		).toBe(false);
	});

	it("rejects both timeline paths before they replace the HDR10+ source", () => {
		const value = state();
		value.inputTimeline = {
			schemaVersion: 2,
			id: "hdr-timeline",
			durationMs: 1000,
			audioEnabled: false,
			videoClips: [],
			audioClips: [],
		};
		expect(() => applyVodInputTimeline(value)).toThrow(
			"TIMELINE_GRAPH_CONFLICT",
		);
		expect(() => applyPreparedVodInputTimeline(value, {} as never)).toThrow(
			"TIMELINE_GRAPH_CONFLICT",
		);
		expect(() => buildPlan(value)).toThrow("TIMELINE_GRAPH_CONFLICT");
	});
});
