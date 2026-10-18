import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "../live/compiler";
import { liveChannelPlanSchema } from "../live/schema";
import { enumerateLiveCaptureTargets } from "./live-targets";

/**
 * enumerateLiveCaptureTargets is the pure half of live VMAF capture: from a
 * LiveChannelPlan it resolves where the encoder wrote each video rendition's
 * segments. Driven by the real live fixtures so the prefixes match the
 * compiler's outputPath exactly.
 */

function loadPlan(name: string) {
	const raw = readFileSync(
		join(__dirname, "..", "live", "__fixtures__", `${name}.plan.json`),
		"utf8",
	);
	return liveChannelPlanSchema.parse(JSON.parse(raw));
}

describe("enumerateLiveCaptureTargets", () => {
	function mirroredPlan() {
		const plan = loadPlan("live-akamai-msl-storage");
		for (const muxing of plan.muxings) {
			if (muxing.destination) muxing.destination.outputKey = "mirror-1";
		}
		plan.deliveryMirrors = [{ outputKey: "origin" }];
		return plan;
	}

	it("selects the sole readable mirror of the same muxing without changing its identity", () => {
		const plan = mirroredPlan();
		const before = structuredClone(plan);
		const primaryTargets = enumerateLiveCaptureTargets({
			...plan,
			deliveryMirrors: [],
		});
		expect(enumerateLiveCaptureTargets(plan)).toEqual(
			primaryTargets.map((target) => ({ ...target, outputKey: "origin" })),
		);
		expect(plan).toEqual(before);
		for (const target of enumerateLiveCaptureTargets(plan)) {
			const op = compileLiveChannel(plan).find(
				(candidate) =>
					candidate.kind === "CREATE_MUXING_FMP4" &&
					candidate.payload.outputPath === target.segmentPrefix,
			);
			expect(op?.refs).toMatchObject({
				outputId: "output:mirror-1",
				mirrorOutputIds: [`output:${target.outputKey}`],
			});
		}
	});

	it("keeps a readable primary even with multiple readable mirrors", () => {
		const plan = mirroredPlan();
		const storage = plan.outputs.find((output) => output.key === "origin");
		if (!storage) throw new Error("missing storage");
		plan.outputs.push({ ...storage, key: "storage-two" });
		plan.deliveryMirrors?.push({ outputKey: "storage-two" });
		for (const muxing of plan.muxings) {
			if (muxing.destination) muxing.destination.outputKey = "origin";
		}
		expect(
			enumerateLiveCaptureTargets(plan).every((t) => t.outputKey === "origin"),
		).toBe(true);
	});

	it.each([
		false,
		true,
	])("does not choose between two readable mirrors (reverse=%s)", (reverse) => {
		const plan = mirroredPlan();
		const storage = plan.outputs.find((output) => output.key === "origin");
		if (!storage) throw new Error("missing storage");
		plan.outputs.push({ ...storage, key: "storage-two" });
		plan.deliveryMirrors?.push({ outputKey: "storage-two" });
		if (reverse) plan.deliveryMirrors?.reverse();
		expect(
			enumerateLiveCaptureTargets(plan).every(
				(t) => t.outputKey === "mirror-1",
			),
		).toBe(true);
	});

	it("ignores undeclared storage and unreadable or self mirrors", () => {
		const plan = mirroredPlan();
		plan.deliveryMirrors = [{ outputKey: "mirror-1" }];
		expect(
			enumerateLiveCaptureTargets(plan).every(
				(t) => t.outputKey === "mirror-1",
			),
		).toBe(true);
		plan.deliveryMirrors.push({ outputKey: "origin" });
		expect(
			enumerateLiveCaptureTargets(plan).every((t) => t.outputKey === "origin"),
		).toBe(true);
	});

	it("preserves rebased paths and TS literal names while excluding MP4", () => {
		const plan = mirroredPlan();
		plan.muxings = plan.muxings.map((muxing) => ({
			key: muxing.key,
			kind: "TS",
			streamKey: muxing.streamKey,
			segmentLength: 2,
			segmentNaming: "seg-{rand_chars:8}-%number%.ts",
			destination: {
				outputKey: "mirror-1",
				path: `runs/2-exact/${muxing.key}`,
			},
		}));
		plan.muxings.unshift({
			key: "archive",
			kind: "MP4",
			streamKey: "v720",
			filename: "archive.mp4",
			destination: { outputKey: "origin", path: "archive" },
		});
		const targets = enumerateLiveCaptureTargets(plan);
		expect(targets).toHaveLength(3);
		for (const target of targets) {
			expect(target).toMatchObject({
				outputKey: "origin",
				kind: "TS",
				segmentNaming: "seg-{rand_chars:8}-%number%.ts",
				segmentLengthSec: 2,
			});
			expect(target.segmentPrefix).toBe(`runs/2-exact/${target.renditionKey}`);
		}
	});
	it("returns one target per VIDEO rendition with the muxing segment prefix", () => {
		const plan = loadPlan("live-rtmp-simple");
		const targets = enumerateLiveCaptureTargets(plan);

		// 3 video renditions (1080/720/360); the audio rendition is skipped.
		expect(targets.map((t) => t.renditionKey)).toEqual([
			"v1080",
			"v720",
			"v360",
		]);
		expect(targets.every((t) => t.codec === "H264")).toBe(true);

		const v1080 = targets[0];
		expect(v1080).toMatchObject({
			renditionKey: "v1080",
			height: 1080,
			bitrate: 4500000,
			outputKey: "origin",
			segmentPrefix: "output/live-rtmp-simple/video/1080p",
			kind: "FMP4",
			initSegmentName: "init.mp4",
			segmentNaming: "segment_%number%.m4s",
		});
		// : the per-segment aligner splits on the muxing's real length
		const muxing = plan.muxings.find(
			(m) => m.streamKey === "v1080" && m.kind === "FMP4",
		);
		if (muxing?.kind !== "FMP4") throw new Error("fixture FMP4 missing");
		expect(muxing?.segmentLength).toBeGreaterThan(0);
		expect(v1080?.segmentLengthSec).toBe(muxing?.segmentLength);
	});

	it("prefers fMP4 over TS and carries the init name only for fMP4", () => {
		const plan = loadPlan("live-rtmp-simple");
		// Add a TS muxing alongside the fMP4 for v360; fMP4 must win.
		plan.muxings.push({
			key: "v360ts",
			kind: "TS",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
			destination: { outputKey: "origin", path: "output/live/v360-ts" },
		});
		const targets = enumerateLiveCaptureTargets(plan);
		const v360 = targets.find((t) => t.renditionKey === "v360");
		expect(v360?.kind).toBe("FMP4");
		expect(v360?.initSegmentName).toBe("init.mp4");
	});

	it("falls back to TS (no init name) when only a TS muxing exists", () => {
		const plan = loadPlan("live-rtmp-simple");
		// Replace v360's fMP4 with a TS-only muxing.
		plan.muxings = plan.muxings.filter((m) => m.key !== "v360");
		plan.muxings.push({
			key: "v360ts",
			kind: "TS",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "seg_%number%.ts",
			destination: { outputKey: "origin", path: "output/live/v360-ts" },
		});
		const v360 = enumerateLiveCaptureTargets(plan).find(
			(t) => t.renditionKey === "v360",
		);
		expect(v360?.kind).toBe("TS");
		expect(v360?.initSegmentName).toBeUndefined();
		expect(v360?.segmentNaming).toBe("seg_%number%.ts");
		expect(v360?.segmentPrefix).toBe("output/live/v360-ts");
	});

	it("skips a video rendition whose muxing carries no destination", () => {
		const plan = loadPlan("live-rtmp-simple");
		const v720 = plan.muxings.find((m) => m.key === "v720");
		if (v720) {
			v720.destination = undefined;
		}
		const keys = enumerateLiveCaptureTargets(plan).map((t) => t.renditionKey);
		expect(keys).toEqual(["v1080", "v360"]);
	});
});
