import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

const code = "PLAN_DASH_ONDEMAND_CLEAR_DRM";

function planFixture() {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "OnDemand MP4",
		bitmovin: {},
		inputs: [
			{
				key: "source",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "input",
			},
		],
		outputs: [
			{
				key: "output",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "output",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "source",
				inputPath: "sample.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
			{
				key: "audio",
				inputKey: "source",
				inputPath: "sample.mp4",
				selectionMode: "AUDIO_RELATIVE",
			},
		],
		renditions: [
			{
				key: "video",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 1_000_000,
				rate: 24,
				dashSetKey: "video",
			},
			{
				key: "audio",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128_000,
				rate: 48_000,
				dashSetKey: "audio",
			},
		],
		muxings: ["video", "audio"].map((key) => ({
			key,
			kind: "MP4",
			streamKey: key,
			filename: `${key}.mp4`,
			fragmentDuration: 2000,
			manifestType: "DASH_ON_DEMAND",
			destination: {
				outputKey: "output",
				path: `clear/${key}`,
				acl: "PRIVATE",
			},
		})),
		drm: ["video", "audio"].map((key) => ({
			key: `${key}-cenc`,
			kind: "CENC",
			muxingKey: key,
			credentialId: "00000000-0000-4000-8000-000000000003",
			kid: "0123456789abcdef0123456789abcdef",
			encryptionMode: "CTR",
			ivSize: "IV_8_BYTES",
			destination: { outputKey: "output", path: `cenc/${key}`, acl: "PRIVATE" },
		})),
		manifests: [
			"clear-standard",
			"clear-explicit",
			"cenc-standard",
			"cenc-explicit",
		].map((key) => ({
			key,
			kind: "DASH",
			name: key,
			manifestName: `${key}.mpd`,
			profile: "ON_DEMAND",
			...(key.startsWith("cenc") ? { drmKind: "CENC" } : {}),
			...(key.endsWith("explicit")
				? {
						adaptationSets: [
							{ key: "video", type: "VIDEO" },
							{ key: "audio", type: "AUDIO", lang: "en" },
						],
					}
				: {}),
			destination: { outputKey: "output", path: "", acl: "PRIVATE" },
		})),
		generation: { timing: "POST_ENCODING" },
	});
}

describe("clear OnDemand DASH with DRM MP4 muxings", () => {
	it.each([
		"clear-standard",
		"clear-explicit",
	])("rejects both selected DRM-bearing tracks in %s", (key) => {
		const plan = planFixture();
		plan.manifests = plan.manifests.filter((manifest) => manifest.key === key);
		const issues = validatePlan(plan).filter((issue) => issue.code === code);
		expect(issues).toHaveLength(2);
		expect(issues).toEqual([
			expect.objectContaining({ level: "error", path: "manifests[0]" }),
			expect.objectContaining({ level: "error", path: "manifests[0]" }),
		]);
		expect(
			issues.every((issue) =>
				issue.message.includes("separate encoding plans"),
			),
		).toBe(true);
	});

	it("reports the two clear manifests without rejecting the two encrypted ones", () => {
		const issues = validatePlan(planFixture()).filter(
			(issue) => issue.code === code,
		);
		expect(issues.map((issue) => issue.path)).toEqual([
			"manifests[0]",
			"manifests[0]",
			"manifests[1]",
			"manifests[1]",
		]);
	});

	it("preserves clear-only native MP4 representations", () => {
		const plan = planFixture();
		plan.drm = [];
		plan.manifests = plan.manifests.filter((manifest) => !manifest.drmKind);
		expect(validatePlan(plan)).toEqual([]);
		const representations = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_MP4",
		);
		expect(representations).toHaveLength(4);
		expect(representations.every((op) => !op.refs.drmId)).toBe(true);
	});

	it("preserves encrypted-only native MP4 DRM representations", () => {
		const plan = planFixture();
		plan.manifests = plan.manifests.filter(
			(manifest) => manifest.drmKind === "CENC",
		);
		expect(validatePlan(plan)).toEqual([]);
		const ops = compilePlan(plan);
		const representations = ops.filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_MP4",
		);
		expect(representations).toHaveLength(4);
		expect(representations.every((op) => op.refs.drmId)).toBe(true);
		expect(ops.some((op) => op.kind === "CREATE_DASH_CONTENT_PROTECTION")).toBe(
			false,
		);
	});

	it("does not reject an unselected MP4 leg carrying DRM", () => {
		const plan = planFixture();
		const drm = plan.drm[0];
		const muxing = plan.muxings[0];
		if (!drm || muxing?.kind !== "MP4") throw Error("fixture");
		plan.drm = [{ ...drm, muxingKey: "unselected" }];
		plan.muxings.push({
			...muxing,
			key: "unselected",
			manifestType: "HLS_BYTE_RANGES",
			destination: { outputKey: "output", path: "other", acl: "PRIVATE" },
		});
		plan.manifests = plan.manifests.filter((manifest) => !manifest.drmKind);
		expect(validatePlan(plan)).toEqual([]);
	});

	it("does not add shared-output errors for an unrouted track in another encoding", () => {
		const plan = planFixture();
		plan.encodings = [
			{ key: "clear", name: "Clear" },
			{ key: "encrypted", name: "Encrypted" },
		];
		for (const source of plan.ingest) {
			source.encodingKey = source.key === "video" ? "clear" : "encrypted";
		}
		for (const rendition of plan.renditions) {
			rendition.encodingKey = rendition.key === "video" ? "clear" : "encrypted";
		}
		plan.drm = plan.drm.filter((drm) => drm.muxingKey === "audio");
		plan.manifests = plan.manifests.filter(
			(manifest) => manifest.key === "clear-explicit",
		);
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw Error("fixture");
		manifest.adaptationSets = [{ key: "video", type: "VIDEO" }];
		// Existing membership checks still reject the unrouted audio track.
		// It must not also acquire a shared-MP4 error from an unused muxing.
		expect(validatePlan(plan).map((issue) => issue.code)).toEqual([
			"PLAN_DASH_SET_UNRESOLVED",
			"PLAN_DASH_AUDIO_UNSELECTED",
		]);
	});

	it("does not apply the restriction to segmented clear and encrypted fMP4", () => {
		const plan = planFixture();
		const segmented = encodingPlanSchema.parse({
			...plan,
			muxings: plan.muxings.map((muxing) => ({
				key: muxing.key,
				kind: "FMP4",
				streamKey: muxing.streamKey,
				segmentLength: 2,
				destination: muxing.destination,
			})),
			manifests: plan.manifests.map((manifest) => ({
				...manifest,
				profile: undefined,
			})),
		});
		expect(validatePlan(segmented)).toEqual([]);
	});

	it("does not select a per-title or unrouted explicit video muxing", () => {
		const plan = planFixture();
		plan.manifests = plan.manifests.filter(
			(manifest) => manifest.key === "clear-explicit",
		);
		const drm = plan.drm[0];
		const video = plan.renditions[0];
		if (!drm || video?.codec !== "H264") throw Error("fixture");
		plan.drm = [drm];
		video.dashSetKey = undefined;
		expect(validatePlan(plan).filter((issue) => issue.code === code)).toEqual(
			[],
		);
		video.dashSetKey = "video";
		video.mode = "PER_TITLE_TEMPLATE";
		video.bitrate = null;
		expect(validatePlan(plan).filter((issue) => issue.code === code)).toEqual(
			[],
		);
	});
});
