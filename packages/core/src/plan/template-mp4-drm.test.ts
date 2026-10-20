import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import {
	encodingTemplateExportUnavailableReason,
	planToEncodingTemplateYaml,
} from "./template";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function fixture(explicit = false) {
	const base = loadPlan("fixed-bitrate-hls-on-aws");
	const renditions = base.renditions.filter(
		(r) => r.key === "v360" || r.key === "a128",
	);
	const muxings = base.muxings
		.filter((m) => renditions.some((r) => r.key === m.streamKey))
		.map((m) => ({
			key: m.key,
			kind: "MP4",
			streamKey: m.streamKey,
			filename: `${m.key}.mp4`,
			fragmentDuration: 2000,
			manifestType: "DASH_ON_DEMAND",
			destination: m.destination,
		}));
	return encodingPlanSchema.parse({
		...base,
		renditions: renditions.map((r) => ({
			...r,
			dashSetKey: r.codec === "AAC" ? "audio" : "video",
		})),
		muxings,
		drm: muxings.map((m) => ({
			key: `${m.key}-cenc`,
			kind: "CENC",
			muxingKey: m.key,
			credentialId: "00000000-0000-4000-8000-000000000003",
			kid: "0123456789abcdef0123456789abcdef",
			encryptionMode: "CTR",
			ivSize: "IV_8_BYTES",
			destination: { ...m.destination, path: `cenc/${m.key}` },
		})),
		manifests: [
			{
				key: "ondemand",
				kind: "DASH",
				name: "OnDemand",
				manifestName: "stream.mpd",
				profile: "ON_DEMAND",
				drmKind: "CENC",
				destination: { outputKey: base.outputs[0]?.key, path: "" },
				...(explicit
					? {
							adaptationSets: [
								{ key: "video", type: "VIDEO" },
								{ key: "audio", type: "AUDIO", lang: "en" },
							],
						}
					: {}),
			},
		],
		generation: { timing: "POST_ENCODING" },
	});
}

describe("OnDemand MP4 DRM template availability", () => {
	it.each([
		false,
		true,
	])("refuses lossy YAML while preserving executable DRM operations (explicit=%s)", (explicit) => {
		const plan = fixture(explicit);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const reps = compilePlan(plan).filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_MP4",
		);
		expect(reps).toHaveLength(2);
		expect(reps.map((op) => op.refs.drmId)).toEqual(
			plan.muxings.map((m) => `drm:${m.key}-cenc`),
		);
		expect(() => planToEncodingTemplateYaml(plan)).toThrow(
			/OnDemand MP4 DRM.*Plan JSON/,
		);
	});
	it.each([
		"v360",
		"a128",
	])("refuses a selected %s DRM track even without the other media type", (streamKey) => {
		const plan = fixture();
		plan.renditions = plan.renditions.filter((r) => r.key === streamKey);
		plan.muxings = plan.muxings.filter((m) => m.streamKey === streamKey);
		plan.drm = plan.drm.filter((drm) => drm.muxingKey === streamKey);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(() => planToEncodingTemplateYaml(plan)).toThrow(
			/OnDemand MP4 DRM.*Plan JSON/,
		);
	});
	it("preserves clear-only OnDemand MP4 YAML", () => {
		const plan = fixture();
		plan.drm = [];
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("Missing DASH fixture");
		delete manifest.drmKind;
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const tree = parse(planToEncodingTemplateYaml(plan));
		const reps = tree.manifests.dash.ondemand.periods.period.adaptationsets;
		expect(
			reps.video.video_set.representations.mp4.v360.properties.filePath,
		).toContain("v360.mp4");
		expect(JSON.stringify(reps)).not.toContain("drmId");
	});
	it("preserves segmented FMP4 DRM YAML when an unused MP4 DRM resource exists", () => {
		const plan = fixture();
		const unused = plan.muxings[0];
		const drm = plan.drm[0];
		const manifest = plan.manifests[0];
		if (
			unused?.kind !== "MP4" ||
			drm?.kind !== "CENC" ||
			manifest?.kind !== "DASH"
		)
			throw new Error("Missing MP4 DRM fixture");
		plan.muxings = [
			...plan.muxings.map((m) => ({
				key: m.key,
				kind: "FMP4" as const,
				streamKey: m.streamKey,
				segmentLength: 2,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: m.destination,
			})),
			{ ...unused, key: "unused" },
		];
		plan.drm.push({ ...drm, key: "unused-cenc", muxingKey: "unused" });
		delete manifest.profile;
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(planToEncodingTemplateYaml(plan)).toContain("fmp4:");
	});
	it("does not treat unrelated DRM resources as selected representations", () => {
		const plan = fixture();
		plan.drm = plan.drm.map((drm) => ({ ...drm, muxingKey: "unselected" }));
		expect(encodingTemplateExportUnavailableReason(plan)).toBeUndefined();
	});
	it("excludes per-title entries and renditions outside explicit sets", () => {
		const perTitle = fixture();
		perTitle.renditions = perTitle.renditions.map((r) =>
			r.codec === "H264" ? { ...r, mode: "PER_TITLE_TEMPLATE" } : r,
		);
		perTitle.drm = perTitle.drm.filter((drm) => drm.muxingKey === "v360");
		expect(encodingTemplateExportUnavailableReason(perTitle)).toBeUndefined();
		const outside = fixture(true);
		outside.renditions = outside.renditions.map((r) => ({
			...r,
			dashSetKey: "unselected",
		}));
		expect(encodingTemplateExportUnavailableReason(outside)).toBeUndefined();
	});
});
