import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { planToWizardState } from "./plan-to-wizard";

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
	it("retains a native HDR source called video without adding an ingest stream on copy", () => {
		const source = copiedSource();
		const native = encodingPlanSchema.parse({
			...source,
			hdr10PlusStreams: source.hdr10PlusStreams.map((s) => ({
				...s,
				key: "video",
			})),
			renditions: source.renditions.map((r) =>
				r.ingestKey === "hdr" ? { ...r, ingestKey: "video" } : r,
			),
		});
		const form = planToWizardState(native);
		expect(form.videos[0]?.extras?.source).toBe("video");
		expect(encodingPlanSchema.parse(buildPlan(form))).toEqual(native);
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
