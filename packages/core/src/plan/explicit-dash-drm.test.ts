import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function explicitDrmPlan() {
	const base = loadPlan("av1-fmp4-dash-hls");
	const dash = base.manifests.find((m) => m.kind === "DASH");
	if (!dash) throw new Error("Missing DASH fixture");
	return encodingPlanSchema.parse({
		...base,
		renditions: base.renditions.map((r) => ({
			...r,
			dashSetKey: `${r.key}-set`,
		})),
		muxings: base.muxings.map((m) => ({
			...m,
			destination: {
				outputKey: "origin",
				path: `test/clear/${m.key}`,
				acl: "PRIVATE",
			},
		})),
		drm: base.muxings.flatMap((m) => [
			{
				key: `${m.key}-fairplay`,
				kind: "FAIRPLAY",
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000005",
				iv: "12345678901234567890123456789012",
				uri: "skd://example",
				destination: {
					outputKey: "origin",
					path: `test/cbcs/${m.key}`,
					acl: "PRIVATE",
				},
			},
			{
				key: `${m.key}-cenc`,
				kind: "CENC",
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000005",
				kid: "12345678901234567890123456789012",
				encryptionMode: "CTR",
				ivSize: "IV_8_BYTES",
				destination: {
					outputKey: "origin",
					path: `test/cenc/${m.key}`,
					acl: "PRIVATE",
				},
			},
		]),
		manifests: [false, true].map((encrypted) => ({
			...dash,
			key: encrypted ? "cenc" : "clear",
			manifestName: encrypted ? "cenc.mpd" : "clear.mpd",
			drmKind: encrypted ? "CENC" : undefined,
			destination: { outputKey: "origin", path: "test/", acl: "PRIVATE" },
			adaptationSets: base.renditions.map((r) => ({
				key: `${r.key}-set`,
				type: r.codec === "AAC" ? "AUDIO" : "VIDEO",
			})),
		})),
	});
}

describe("explicit DASH adaptation sets with DRM", () => {
	it("binds every encrypted representation to its own set, muxing and selected DRM", () => {
		const plan = explicitDrmPlan();
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compilePlan(plan);
		const children = ops.filter(
			(op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		expect(children).toHaveLength(plan.muxings.length);
		for (const muxing of plan.muxings) {
			const representation = ops.find(
				(op) => op.step === `manifest:cenc:rep:${muxing.key}`,
			);
			expect(representation).toBeDefined();
			expect(
				children.find((op) => op.step === `${representation?.step}:cp`),
			).toEqual({
				step: `${representation?.step}:cp`,
				kind: "CREATE_DASH_CONTENT_PROTECTION",
				payload: {},
				refs: {
					...representation?.refs,
					representationId: representation?.step,
					drmId: `drm:${muxing.key}-cenc`,
				},
			});
		}
	});

	it("keeps clear representations free of content protection even when DRM resources exist", () => {
		const ops = compilePlan(explicitDrmPlan());
		expect(
			ops.filter(
				(op) =>
					op.kind === "CREATE_DASH_CONTENT_PROTECTION" &&
					op.step.startsWith("manifest:clear:"),
			),
		).toEqual([]);
		expect(
			ops.filter((op) => op.step.startsWith("manifest:clear:rep:")),
		).toHaveLength(3);
	});

	it("uses the WebM content-protection endpoint only for selected WebM representations", () => {
		const base = explicitDrmPlan();
		const plan = encodingPlanSchema.parse({
			...base,
			muxings: base.muxings.map((m) =>
				m.streamKey === "a128"
					? m
					: {
							key: m.key,
							kind: "WEBM",
							streamKey: m.streamKey,
							destination: m.destination,
						},
			),
			drm: base.drm.filter((row) => row.kind === "CENC"),
			manifests: base.manifests.map((m) => ({ ...m, videoMuxingKind: "WEBM" })),
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const children = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		expect(children).toHaveLength(3);
		for (const child of children) {
			expect(child.payload).toEqual(
				child.refs.muxingId === "muxing:a128"
					? {}
					: { representationKind: "WEBM" },
			);
		}
	});

	it("does not attach an unselected WebM muxing or its DRM to fMP4 representations", () => {
		const base = explicitDrmPlan();
		const cenc = base.drm.find((row) => row.kind === "CENC");
		if (!cenc) throw new Error("Missing CENC fixture");
		const plan = encodingPlanSchema.parse({
			...base,
			muxings: [
				...base.muxings,
				{
					key: "unused-webm",
					kind: "WEBM",
					streamKey: "v360",
					destination: {
						outputKey: "origin",
						path: "test/unused",
						acl: "PRIVATE",
					},
				},
			],
			drm: [
				...base.drm,
				{
					...cenc,
					key: "unused-cenc",
					muxingKey: "unused-webm",
					destination: {
						outputKey: "origin",
						path: "test/unused-cenc",
						acl: "PRIVATE",
					},
				},
			],
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const children = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		expect(children).toHaveLength(3);
		expect(
			children.every(
				(op) =>
					op.refs.muxingId !== "muxing:unused-webm" &&
					op.refs.drmId !== "drm:unused-cenc",
			),
		).toBe(true);
	});

	it("leaves subtitle representations outside the AV content-protection population", () => {
		const base = explicitDrmPlan();
		const plan = encodingPlanSchema.parse({
			...base,
			fileStreams: [
				{
					key: "captions",
					inputKey: base.inputs[0]?.key,
					inputPath: "en.vtt",
					fileType: "WEBVTT",
				},
			],
			renditions: [
				...base.renditions,
				{ key: "text", codec: "WEBVTT", ingestKey: "captions", language: "en" },
			],
			muxings: [
				...base.muxings,
				{
					key: "text",
					kind: "CHUNKED_TEXT",
					streamKey: "text",
					destination: {
						outputKey: "origin",
						path: "test/captions",
						acl: "PRIVATE",
					},
				},
			],
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compilePlan(plan);
		expect(
			ops.filter((op) => op.kind === "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT"),
		).toHaveLength(2);
		const children = ops.filter(
			(op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION",
		);
		expect(children).toHaveLength(3);
		expect(children.every((op) => op.refs.muxingId !== "muxing:text")).toBe(
			true,
		);
	});
});
