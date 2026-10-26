import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { enumerateLiveCaptureTargets } from "../vmaf/live-targets";
import { compileLiveChannel } from "./compiler";
import { liveManifestPathIssues } from "./manifest-paths";
import { liveChannelPlanSchema } from "./schema";

function fixture() {
	return liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
}

describe("Live media naming", () => {
	it.each([
		"FMP4",
		"TS",
		"CMAF",
	] as const)("uses a template-only %s name consistently after schema defaults", (kind) => {
		const source = fixture();
		const first = source.muxings[0];
		if (!first) throw new Error("Missing muxing");
		const segmentNamingTemplate = "seg_{rand_chars:8}_%number%.mp4";
		const plan = liveChannelPlanSchema.parse({
			...source,
			muxings: [
				{
					key: first.key,
					kind,
					streamKey: first.streamKey,
					destination: first.destination,
					segmentLength: 6,
					segmentNamingTemplate,
				},
				...source.muxings.slice(1),
			],
		});
		const payload = compileLiveChannel(plan).find(
			(op) => op.step === `muxing:${first.key}`,
		)?.payload;
		expect(payload).toHaveProperty(
			"segmentNamingTemplate",
			segmentNamingTemplate,
		);
		expect(payload).not.toHaveProperty("segmentNaming");
		expect(
			compileExpectedLiveArtefacts(plan).muxings.find(
				(muxing) => muxing.muxingKey === first.key,
			)?.segmentNaming,
		).toBe(segmentNamingTemplate);
		expect(
			enumerateLiveCaptureTargets(plan).find(
				(target) => target.renditionKey === first.streamKey,
			)?.segmentNaming,
		).toBe(segmentNamingTemplate);
	});

	it("detects a segment pattern overwriting the same muxing's literal init file", () => {
		const plan = fixture();
		const muxing = plan.muxings[0];
		if (muxing?.kind !== "FMP4") throw new Error("Missing fMP4");
		muxing.segmentNamingTemplate = "segment_%number%.mp4";
		muxing.initSegmentName = "segment_0.mp4";
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({ code: "LIVE_OUTPUT_NAMESPACE_COLLISION" }),
		);
	});

	it.each([
		false,
		true,
	])("expands random-looking segment tokens only for a real template (template=%s)", (template) => {
		const plan = fixture();
		const muxing = plan.muxings[0];
		if (muxing?.kind !== "FMP4") throw new Error("Missing fMP4");
		const filename = "seg-{rand_chars}-%number%.mp4";
		muxing.segmentNaming = filename;
		if (template) muxing.segmentNamingTemplate = filename;
		muxing.initSegmentName = `seg-${"A".repeat(32)}-0.mp4`;
		const issues = liveManifestPathIssues(plan);
		if (template)
			expect(issues).toContainEqual(
				expect.objectContaining({ code: "LIVE_OUTPUT_NAMESPACE_COLLISION" }),
			);
		else expect(issues).toEqual([]);
	});

	it("detects a literal random-looking segment name colliding with a manifest", () => {
		const plan = fixture();
		const muxing = plan.muxings[0],
			manifest = plan.liveManifests[0];
		if (muxing?.kind !== "FMP4" || !muxing.destination || !manifest)
			throw new Error("Missing fixtures");
		muxing.segmentNaming = "seg-{rand_chars}-%number%.m3u8";
		manifest.destination = { ...muxing.destination };
		manifest.manifestName = "seg-{rand_chars}-0.m3u8";
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				path: "muxings[0].segmentNaming",
			}),
		);
	});

	it.each([
		false,
		true,
	])("keeps a template's directory prefix literal (expanded directory=%s)", (expandedDirectory) => {
		const plan = fixture();
		const muxing = plan.muxings[0],
			manifest = plan.liveManifests[0];
		if (muxing?.kind !== "FMP4" || !muxing.destination || !manifest)
			throw new Error("Missing fixtures");
		muxing.destination.path = "media/{rand_chars}/";
		muxing.segmentNamingTemplate = "seg-{rand_chars:8}-%number%.m3u8";
		manifest.destination = {
			outputKey: muxing.destination.outputKey,
			path: expandedDirectory
				? `media/${"A".repeat(32)}/`
				: "media/{rand_chars}/",
		};
		manifest.manifestName = "seg-Ab12Cd34-0.m3u8";
		const issues = liveManifestPathIssues(plan);
		if (expandedDirectory) expect(issues).toEqual([]);
		else
			expect(issues).toContainEqual(
				expect.objectContaining({ code: "LIVE_OUTPUT_NAMESPACE_COLLISION" }),
			);
	});

	it("compares normalized physical paths while retaining filename token origin", () => {
		const plan = fixture();
		const muxing = plan.muxings[0];
		const manifest = plan.liveManifests[0];
		if (muxing?.kind !== "FMP4" || !muxing.destination || !manifest)
			throw new Error("Missing fixtures");
		muxing.destination.path = "root/./media/unused/..";
		muxing.segmentNamingTemplate = "child/../seg-{rand_chars:8}-%number%.m3u8";
		manifest.destination = {
			outputKey: muxing.destination.outputKey,
			path: "root/media",
		};
		manifest.manifestName = "seg-Ab12Cd34-0.m3u8";
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({ code: "LIVE_OUTPUT_NAMESPACE_COLLISION" }),
		);
	});

	it("checks the literal fallback when a segment template is empty", () => {
		const plan = fixture();
		const muxing = plan.muxings[0];
		if (muxing?.kind !== "FMP4") throw new Error("Missing fMP4");
		muxing.segmentNaming = "segment_%number%.mp4";
		muxing.segmentNamingTemplate = "";
		muxing.initSegmentName = "segment_0.mp4";
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				path: "muxings[0].segmentNaming",
			}),
		);
	});

	it.each([
		["track_%number%.mp4", "track_meta.mp4"],
		["seg_{rand_chars:8}_%number%.mp4", "seg_short_0.mp4"],
		["seg_{rand_chars}_%number%.mp4", "seg_short_0.mp4"],
	])("keeps nonmatching init name %s / %s available", (segmentNamingTemplate, initSegmentName) => {
		const plan = fixture();
		const muxing = plan.muxings[0];
		if (muxing?.kind !== "FMP4") throw new Error("Missing fMP4");
		muxing.segmentNamingTemplate = segmentNamingTemplate;
		muxing.initSegmentName = initSegmentName;
		expect(liveManifestPathIssues(plan)).toEqual([]);
	});

	it("detects numbered segment names overwriting a manifest through an output alias", () => {
		const plan = fixture();
		const muxing = plan.muxings[0],
			output = plan.outputs[0],
			manifest = plan.liveManifests[0];
		if (muxing?.kind !== "FMP4" || !muxing.destination || !output || !manifest)
			throw new Error("Missing fixtures");
		plan.outputs.push({ ...output, key: "alias" });
		muxing.segmentNaming = "playlist_%number%.m3u8";
		manifest.destination = {
			outputKey: "alias",
			path: muxing.destination.path,
		};
		manifest.manifestName = "playlist_1.m3u8";
		expect(liveManifestPathIssues(plan)).toContainEqual(
			expect.objectContaining({ code: "LIVE_OUTPUT_NAMESPACE_COLLISION" }),
		);
	});
});
