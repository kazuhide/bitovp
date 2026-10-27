import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function fixture() {
	const plan = loadPlan("fixed-bitrate-hls-on-aws");
	plan.renditions = plan.renditions.filter((row) =>
		["v360", "a128"].includes(row.key),
	);
	plan.muxings = plan.muxings.filter((row) =>
		["v360", "a128"].includes(row.streamKey),
	);
	for (const muxing of plan.muxings)
		muxing.destination = {
			outputKey: "origin",
			path: `asset/${muxing.streamKey === "v360" ? "video" : "audio"}/`,
		};
	const manifest = plan.manifests[0];
	if (manifest?.kind !== "HLS") throw new Error("HLS fixture missing");
	manifest.generationMode = "DEFAULT";
	manifest.destination = { outputKey: "origin", path: "asset/manifests/" };
	plan.generation.timing = "POST_ENCODING";
	return { plan, manifest };
}
const pathIssues = (plan: ReturnType<typeof fixture>["plan"]) =>
	validatePlan(encodingPlanSchema.parse(plan)).filter(
		(issue) => issue.code === "PLAN_DEFAULT_HLS_OUTPUT_PATH",
	);

describe("Default HLS output hierarchy", () => {
	it("rejects a sibling manifest directory before provider resource creation", () => {
		const { plan } = fixture();
		expect(pathIssues(plan)).toMatchObject([
			{ level: "error", path: "manifests[0].destination.path" },
		]);
	});
	it.each(["asset/", "/asset/./", ""])("accepts ancestor %j", (path) => {
		const { plan, manifest } = fixture();
		manifest.destination.path = path;
		expect(pathIssues(plan)).toEqual([]);
	});
	it("checks directory boundaries instead of accepting a sibling string prefix", () => {
		const { plan, manifest } = fixture();
		manifest.destination.path = "asset/base";
		for (const muxing of plan.muxings)
			if (muxing.destination)
				muxing.destination.path = `asset/base2/${muxing.key}/`;
		expect(pathIssues(plan)).toHaveLength(1);
	});
	it("keeps manual parent-relative media paths valid", () => {
		const { plan, manifest } = fixture();
		manifest.generationMode = "MANUAL";
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			compilePlan(plan).find(
				(operation) => operation.kind === "CREATE_HLS_STREAM_INFO",
			)?.payload.segmentPath,
		).toBe("../video/");
	});
	it("does not infer a DASH ancestor restriction from the HLS contract", () => {
		const { plan, manifest } = fixture();
		plan.manifests = [
			{
				key: "dash",
				kind: "DASH",
				name: "Default DASH",
				generationMode: "DEFAULT",
				manifestName: "stream.mpd",
				profile: "LIVE",
				representationType: "TEMPLATE",
				audioLanguage: "en",
				destination: manifest.destination,
			},
		];
		expect(pathIssues(plan)).toEqual([]);
	});
	it("checks the fixed parent of dynamic Per-Title media paths", () => {
		const { plan, manifest } = fixture();
		const video = plan.renditions[0],
			muxing = plan.muxings[0];
		if (video?.codec !== "H264" || !muxing) throw new Error("video missing");
		video.mode = "PER_TITLE_TEMPLATE";
		video.bitrate = null;
		video.height = null;
		muxing.destination = {
			outputKey: "origin",
			path: "asset/video/{height}p_{bitrate}_{uuid}/",
		};
		plan.perTitle = { h264Configuration: { autoRepresentations: {} } };
		manifest.destination.path = "asset/";
		expect(pathIssues(plan)).toEqual([]);
		manifest.destination.path = "asset/manifests/";
		expect(pathIssues(plan)).toHaveLength(1);
	});
	it("does not reject an unresolved Per-Title directory as a proven mismatch", () => {
		const { plan, manifest } = fixture();
		plan.renditions = plan.renditions.filter((row) => row.key === "v360");
		plan.muxings = plan.muxings.filter((row) => row.streamKey === "v360");
		const video = plan.renditions[0],
			muxing = plan.muxings[0];
		if (video?.codec !== "H264" || !muxing) throw new Error("video missing");
		video.mode = "PER_TITLE_TEMPLATE";
		video.height = null;
		video.bitrate = null;
		muxing.destination = {
			outputKey: "origin",
			path: "asset/video/{height}p/{uuid}/",
		};
		plan.perTitle = { h264Configuration: { autoRepresentations: {} } };
		manifest.destination.path = "asset/video/720p/";
		expect(pathIssues(plan)).toEqual([]);
		expect(
			validatePlan(plan).filter(
				(issue) => issue.code === "PLAN_DEFAULT_HLS_OUTPUT_PATH_UNVERIFIED",
			),
		).toMatchObject([{ level: "warning" }]);
	});
	it("does not apply an HLS hierarchy rule to an unselected WebM container", () => {
		const { plan, manifest } = fixture();
		manifest.destination.path = "asset/";
		plan.muxings.push({
			key: "webm-copy",
			kind: "WEBM",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "segment_%number%.chk",
			initSegmentName: "init.hdr",
			destination: { outputKey: "origin", path: "elsewhere/webm/" },
		});
		expect(pathIssues(plan)).toEqual([]);
	});
	it("includes DRM-owned destinations even when the clear muxing has no output", () => {
		const { plan, manifest } = fixture();
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("muxing missing");
		delete muxing.destination;
		plan.drm.push({
			key: "encrypted",
			kind: "CENC",
			muxingKey: muxing.key,
			credentialId: "00000000-0000-4000-8000-000000000003",
			kid: "00000000000000000000000000000001",
			destination: { outputKey: "origin", path: "asset/encrypted/video/" },
		});
		expect(pathIssues(plan)).toHaveLength(1);
		manifest.destination.path = "asset/";
		expect(pathIssues(plan)).toEqual([]);
	});
	it("recognizes physical output aliases without rewriting their provider references", () => {
		const { plan, manifest } = fixture();
		const output = plan.outputs[0];
		if (!output) throw new Error("output missing");
		plan.outputs.push({ ...output, key: "alias", name: "Alias" });
		manifest.destination.outputKey = "alias";
		expect(pathIssues(plan)).toEqual([]);
		expect(
			validatePlan(plan).filter(
				(issue) => issue.code === "PLAN_DEFAULT_HLS_OUTPUT_PATH_UNVERIFIED",
			),
		).toMatchObject([{ level: "warning" }]);
		manifest.destination.path = "asset/";
		expect(pathIssues(plan)).toEqual([]);
		expect(
			compilePlan(plan).find(
				(operation) => operation.kind === "CREATE_MANIFEST_HLS",
			)?.refs.outputId,
		).toBe("output:alias");
	});
	it("checks media copied to a shared delivery mirror", () => {
		const { plan, manifest } = fixture();
		const output = plan.outputs[0];
		if (output?.kind !== "S3") throw new Error("S3 missing");
		plan.outputs.push({ ...output, key: "mirror", bucket: "sample-mirror" });
		plan.deliveryMirrors = [{ outputKey: "mirror" }];
		manifest.destination.outputKey = "mirror";
		expect(pathIssues(plan)).toHaveLength(1);
	});
	it("does not mix another encoding or unrelated storage into the selected output hierarchy", () => {
		const { plan, manifest } = fixture();
		plan.encodings = [
			{ key: "other", name: "Other" },
			{ key: "selected", name: "Selected" },
		];
		for (const rendition of plan.renditions) rendition.encodingKey = "selected";
		const video = plan.renditions[0],
			muxing = plan.muxings[0],
			output = plan.outputs[0];
		if (!video || !muxing || output?.kind !== "S3")
			throw new Error("fixture missing");
		plan.renditions.push({
			...video,
			key: "other-video",
			encodingKey: "other",
		});
		plan.muxings.push({
			...muxing,
			key: "other-video",
			streamKey: "other-video",
			destination: { outputKey: "origin", path: "elsewhere/" },
		});
		manifest.destination.path = "asset/";
		expect(pathIssues(plan)).toEqual([]);
		plan.outputs.push({
			...output,
			key: "unrelated",
			bucket: "sample-unrelated",
		});
		manifest.destination = { outputKey: "unrelated", path: "elsewhere/" };
		expect(pathIssues(plan)).toEqual([]);
	});
});
