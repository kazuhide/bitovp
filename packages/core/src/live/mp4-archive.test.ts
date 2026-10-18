import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import { enumerateLiveCaptureTargets } from "../vmaf/live-targets";
import { compileLiveChannel, selectLiveManifestMuxings } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("fixture item missing");
	return value;
}

function rawPlan() {
	const value = JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	);
	value.start.encodingOption = "AUTO";
	for (const r of value.renditions)
		if (r.codec === "H264") {
			r.width = r.height === 1080 ? 1920 : r.height === 720 ? 1280 : 640;
			r.rate = 30;
		}
	value.liveManifests = value.liveManifests.filter(
		(m: { kind: string }) => m.kind === "HLS",
	);
	value.muxings = value.muxings.map((m: Record<string, unknown>) => {
		const { initSegmentName: _, ...rest } = m;
		return { ...rest, kind: "TS", segmentNaming: "segment_%number%.ts" };
	});
	value.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: "v1080",
		additionalStreamKeys: ["a128"],
		filename: "archive.mp4",
		destination: {
			outputKey: "origin",
			path: "output/live-rtmp-simple/archive",
		},
	});
	return value;
}

const parse = () => liveChannelPlanSchema.parse(rawPlan());
const errors = (raw = rawPlan()) =>
	validateLiveChannel(liveChannelPlanSchema.parse(raw)).filter(
		(issue) => issue.level === "error",
	);

describe("Live progressive MP4 archive", () => {
	it("parses and compiles HD plus TS plus a same-encoding H264/AAC archive", () => {
		const p = parse();
		expect(errors()).toEqual([]);
		const ops = compileLiveChannel(p);
		const mp4 = ops.find((op) => op.kind === "CREATE_MUXING_MP4");
		expect(mp4).toEqual({
			step: "muxing:archive",
			kind: "CREATE_MUXING_MP4",
			payload: {
				filename: "archive.mp4",
				outputPath: "output/live-rtmp-simple/archive",
				name: "Video MP4 Muxing 1080p",
			},
			refs: {
				encodingId: "encoding",
				streamId: "stream:v1080",
				additionalStreamIds: ["stream:a128"],
				outputId: "output:origin",
			},
		});
		expect(ops.filter((op) => op.kind === "CREATE_ENCODING")).toHaveLength(1);
		expect(
			ops.find((op) => op.kind === "START_LIVE_ENCODING")?.payload
				.encodingOption,
		).toBe("HD");
		const seen = new Set<string>();
		for (const op of ops) {
			for (const ref of Object.values(op.refs).flat())
				expect(seen.has(ref), `${op.step}: ${ref}`).toBe(true);
			seen.add(op.step);
		}
	});
	it("keeps MP4 out of HLS/DASH, active segment verification, and VMAF capture", () => {
		const p = parse();
		for (const manifest of p.liveManifests)
			expect(
				selectLiveManifestMuxings(p, manifest).map(({ muxing }) => muxing.key),
			).not.toContain("archive");
		const expected = compileExpectedLiveArtefacts(p);
		expect(expected.muxings.map((m) => m.muxingKey)).not.toContain("archive");
		expect(expected).toHaveProperty("archives", [
			expect.objectContaining({
				muxingKey: "archive",
				outputKey: "origin",
				filename: "archive.mp4",
				mirrorOutputKeys: [],
			}),
		]);
		expect(expected.notes.join(" ")).toContain("post-stop");
		expect(
			enumerateLiveCaptureTargets(p).map((target) => target.segmentPrefix),
		).not.toContain("output/live-rtmp-simple/archive");
		p.liveManifests[0] = {
			...p.liveManifests[0],
			kind: "DASH",
		} as (typeof p.liveManifests)[number];
		expect(selectLiveManifestMuxings(p, required(p.liveManifests[0]))).toEqual(
			[],
		);
	});
	it.each(["HLS", "DASH"])("rejects an MP4-only %s manifest", (kind) => {
		const p = rawPlan();
		p.muxings = p.muxings.filter((m: { kind: string }) => m.kind === "MP4");
		if (kind === "DASH")
			p.liveManifests = [
				{
					key: "dash",
					kind,
					destination: { outputKey: "origin", path: "output/live-rtmp-simple" },
				},
			];
		expect(errors(p).map((issue) => issue.code)).toContain(
			kind === "HLS" ? "LIVE_HLS_NO_ENTRIES" : "LIVE_DASH_NO_REPRESENTATIONS",
		);
	});
	it.each([
		"fragmentDuration",
		"manifestType",
		"dolbyVisionConfiguration",
	])("rejects unproven archive option %s", (key) => {
		const p = rawPlan();
		p.muxings.at(-1)[key] =
			key === "fragmentDuration"
				? 4000
				: key === "manifestType"
					? "HLS_BYTE_RANGES"
					: { trackSampleEntryName: "DVHE" };
		expect(errors(p).map((issue) => issue.code)).toContain(
			"LIVE_MP4_PROGRESSIVE_ONLY",
		);
	});
	it("retains missing destination and stream-reference rails", () => {
		const p = rawPlan();
		delete p.muxings.at(-1).destination;
		p.muxings.at(-1).additionalStreamKeys = ["missing-audio"];
		expect(errors(p).map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"LIVE_MUXING_NO_DESTINATION",
				"LIVE_UNRESOLVED_REF",
			]),
		);
	});
	it("does not accept an incompatible audio codec hidden behind the video primary", () => {
		const p = rawPlan();
		p.renditions.push({
			key: "bad-audio",
			codec: "DD",
			ingestKey: "audio",
			bitrate: 192000,
			rate: 48000,
			channelLayout: "CL_STEREO",
		});
		p.muxings.at(-1).additionalStreamKeys = ["bad-audio"];
		expect(errors(p)).toContainEqual(
			expect.objectContaining({
				code: "LIVE_MUXING_CODEC_MISMATCH",
				path: "muxings[4].additionalStreamKeys[0]",
			}),
		);
	});
	it.each([
		"RTMP",
		"AKAMAI_MSL",
		"SFTP",
	])("rejects archive primary %s and nonstorage delivery mirrors", (kind) => {
		const p = parse();
		// Validation also guards typed callers; output parsing is covered separately.
		p.outputs.push({ key: "unsupported", kind } as (typeof p.outputs)[number]);
		const archive = required(p.muxings.at(-1));
		archive.destination = { outputKey: "unsupported", path: "archive" };
		expect(validateLiveChannel(p).map((i) => i.code)).toContain(
			"LIVE_MP4_STORAGE_ONLY",
		);
		archive.destination = { outputKey: "origin", path: "archive" };
		p.deliveryMirrors = [{ outputKey: "unsupported" }];
		expect(validateLiveChannel(p).map((i) => i.code)).toContain(
			"LIVE_MP4_STORAGE_ONLY",
		);
	});
	it("preserves storage mirrors and excludes the archive own storage mirror", () => {
		const p = parse();
		p.outputs.push({ ...required(p.outputs[0]), key: "second" });
		p.deliveryMirrors = [{ outputKey: "origin" }, { outputKey: "second" }];
		expect(validateLiveChannel(p).filter((i) => i.level === "error")).toEqual(
			[],
		);
		expect(
			compileLiveChannel(p).find((op) => op.kind === "CREATE_MUXING_MP4")?.refs
				.mirrorOutputIds,
		).toEqual(["output:second"]);
	});
	it("writes TS to MSL4 and AOS while the archive reaches AOS only", () => {
		const p = parse();
		p.outputs[0] = {
			...required(p.outputs[0]),
			kind: "GENERIC_S3",
		} as (typeof p.outputs)[number];
		p.outputs.push({
			key: "msl",
			kind: "AKAMAI_MSL",
			credentialId: "00000000-0000-4000-8000-000000000004",
			streamFormat: "HLS",
			mslVersion: "MSL4",
			name: "MSL test output",
		});
		p.deliveryMirrors = [{ outputKey: "origin" }];
		for (const m of p.muxings)
			if (m.kind === "TS") {
				m.destination = { ...required(m.destination), outputKey: "msl" };
				m.segmentNaming = "seg-{rand_chars:8}-%number%.ts";
			}
		required(p.liveManifests[0]).destination = { outputKey: "msl", path: "" };
		expect(
			validateLiveChannel(p).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const ops = compileLiveChannel(p);
		for (const ts of ops.filter((op) => op.kind === "CREATE_MUXING_TS"))
			expect(ts.refs).toMatchObject({
				outputId: "output:msl",
				mirrorOutputIds: ["output:origin"],
			});
		const archive = ops.find((op) => op.kind === "CREATE_MUXING_MP4");
		expect(archive?.refs.outputId).toBe("output:origin");
		expect(archive?.refs).not.toHaveProperty("mirrorOutputIds");
	});
});
