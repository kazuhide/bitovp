import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "../heartbeat-cadence";
import { type LiveEngineDeps, verifyLiveChannel } from "./engine-live";

function scenario(
	topology: "ALIAS" | "MIRROR" | "SEPARATE",
	literalOnly = false,
	cmaf = false,
) {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	const output = plan.outputs[0];
	const video = plan.muxings[0];
	const audio = plan.muxings[3];
	if (
		output?.kind !== "S3" ||
		video?.kind !== "FMP4" ||
		audio?.kind !== "FMP4" ||
		!video.destination
	)
		throw new Error("Missing fixture outputs");
	plan.outputs.push({
		...output,
		key: "secondary",
		bucket: topology === "ALIAS" ? output.bucket : "separate-live-output",
	});
	if (topology === "MIRROR")
		plan.deliveryMirrors = [
			{ outputKey: "origin" },
			{ outputKey: "secondary" },
		];
	const destination = { ...video.destination };
	plan.renditions = plan.renditions.filter(
		(r) => r.key === video.streamKey || r.key === audio.streamKey,
	);
	plan.muxings = [video, audio].map((m, i) => ({
		...m,
		destination: {
			...destination,
			outputKey: i === 1 ? "secondary" : "origin",
		},
		segmentNaming: `writer_${i}_%number%.m4s`,
		initSegmentName: `init_${i}_%number%.mp4`,
	}));
	if (literalOnly)
		for (const muxing of plan.muxings)
			if (muxing.destination) muxing.destination.outputKey = "origin";
	if (cmaf) {
		plan.muxings = plan.muxings.map((m, i) => {
			if (m.kind !== "FMP4") throw new Error("Missing fMP4 fixture");
			return {
				...m,
				kind: "CMAF" as const,
				...(i === 0
					? {
							segmentNamingTemplate: "writer_0_{rand_chars:8}_%number%.m4s",
							initSegmentNameTemplate: "init_0_{rand_chars:8}_%number%.mp4",
						}
					: {}),
			};
		});
		plan.liveManifests = plan.liveManifests.filter((m) => m.kind === "DASH");
	}
	if (topology === "SEPARATE") {
		// Distinct container families keep both physical outputs independently playable.
		plan.muxings = [video, audio].map((m, i) => ({
			...m,
			destination: { ...destination },
			segmentNaming: `writer_${i}_%number%.m4s`,
			initSegmentName: `init_${i}_%number%.mp4`,
		}));
		plan.muxings.push(
			...[video, audio].map((m, i) => ({
				key: `${m.key}-ts`,
				kind: "TS" as const,
				streamKey: m.streamKey,
				segmentLength: m.segmentLength,
				segmentNaming: `secondary_${i}_%number%.ts`,
				destination: { ...destination, outputKey: "secondary" },
			})),
		);
	}
	for (const manifest of plan.liveManifests) {
		manifest.destination = {
			...destination,
			outputKey:
				topology !== "ALIAS" && manifest.kind === "DASH"
					? "origin"
					: "secondary",
		};
		if (manifest.kind === "HLS" && topology === "SEPARATE") {
			manifest.videoMuxingKind = "TS";
			manifest.audioMuxingKind = "TS";
		}
	}
	plan.muxings.push({
		key: "archive",
		kind: "MP4",
		streamKey: video.streamKey,
		filename: "archive_%number%_{rand_chars:8}.mp4",
		destination: { ...destination, outputKey: "secondary" },
	});
	expect(
		validateLiveChannel(plan).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const expected = compileExpectedLiveArtefacts(plan);
	const deps: LiveEngineDeps = {
		coordinates: { streamKey: "test", encoderIp: "10.0.0.7" },
		fed: true,
		samples: [0, 1].map((index) => {
			const physical = {
				origin: new Map<string, number>(),
				secondary: new Map<string, number>(),
			};
			const write = (primary: string, key: string, size: number) => {
				const targets =
					topology === "SEPARATE" ? [primary] : ["origin", "secondary"];
				for (const target of targets) {
					if (target === "origin") physical.origin.set(key, size);
					else if (target === "secondary") physical.secondary.set(key, size);
					else throw new Error("Unknown fixture output");
				}
			};
			for (const muxing of expected.muxings) {
				const init =
					muxing.initSegmentNameTemplate?.replace(
						"{rand_chars:8}",
						"Ab12Cd34",
					) || muxing.initSegment;
				if (init) write(muxing.outputKey, `${muxing.dir.prefix}${init}`, 900);
				for (let number = 1; number <= index + 2; number++) {
					const pattern = muxing.segmentNamingIsTemplate
						? muxing.segmentNaming.replace("{rand_chars:8}", "Ab12Cd34")
						: muxing.segmentNaming;
					write(
						muxing.outputKey,
						`${muxing.dir.prefix}${pattern.replace(/%number%/g, String(number))}`,
						500_000,
					);
				}
			}
			for (const manifest of expected.manifests)
				for (const filename of [...manifest.files, ...manifest.mediaPlaylists])
					write(manifest.outputKey, `${manifest.dir.prefix}${filename}`, 900);
			for (const archive of expected.archives ?? [])
				write(
					archive.outputKey,
					`${archive.dir.prefix}${archive.filename}`,
					500_000,
				);
			return {
				at: 1_760_000_000_000 + index * HEARTBEAT_SWEEP_INTERVAL_MS,
				status: "RUNNING",
				mediaSequence: 12 + index * 2,
				playlistSegments: 8 + index * 2,
				heartbeatRows: 3 + index * 2,
				objects: Object.entries(physical).flatMap(([outputKey, files]) =>
					[...files].map(([key, size]) => ({ outputKey, key, size })),
				),
			};
		}),
	};
	return { expected, deps };
}

it.each([
	"ALIAS",
	"MIRROR",
] as const)("recognizes all physically emitted literal and dynamic writers for %s", async (topology) => {
	const { expected, deps } = scenario(topology);
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.filter((c) => c.verdict === "FAIL")).toEqual([]);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("PASS");
	expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"PASS",
	);
	for (const check of report.checks.filter((c) =>
		c.id.startsWith("live:archive:"),
	))
		expect(check.verdict).toBe("SKIP");
});

it.each([
	"manifest",
	"archive",
] as const)("does not borrow %s literals from an unrelated bucket", async (kind) => {
	const { expected, deps } = scenario("SEPARATE");
	const healthy = await verifyLiveChannel(expected, deps);
	expect(
		healthy.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("PASS");
	const hls = expected.manifests.find((m) => m.kind === "HLS");
	const archive = expected.archives?.[0];
	if (!hls || !archive) throw new Error("Missing literal fixtures");
	const key =
		kind === "manifest"
			? `${hls.dir.prefix}${hls.files[0]}`
			: `${archive.dir.prefix}${archive.filename}`;
	for (const sample of deps.samples)
		sample.objects?.push({ outputKey: "origin", key, size: 900 });
	const report = await verifyLiveChannel(expected, deps);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("FAIL");
});

it("never uses mirrored media to satisfy a missing primary writer", async () => {
	const { expected, deps } = scenario("MIRROR");
	for (const sample of deps.samples)
		sample.objects = sample.objects?.filter(
			(o) =>
				!(
					o.outputKey === "origin" &&
					(o.key.includes("writer_0_") || o.key.includes("init_0_"))
				),
		);
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"FAIL",
	);
});

it.each([
	"unknown.m4s",
	"archive_1_Ab12Cd34.mp4",
])("does not admit unknown or expanded literal %s through a mirror", async (filename) => {
	const { expected, deps } = scenario("MIRROR");
	const muxing = expected.muxings[0];
	if (!muxing) throw new Error("Missing muxing fixture");
	for (const sample of deps.samples)
		sample.objects?.push({
			outputKey: "origin",
			key: `${muxing.dir.prefix}${filename}`,
			size: 500_000,
		});
	const report = await verifyLiveChannel(expected, deps);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("FAIL");
});

it("recognizes manifest-only aliases observed through the media output", async () => {
	const { expected, deps } = scenario("ALIAS", true);
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.filter((c) => c.verdict === "FAIL")).toEqual([]);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("PASS");
});

it("keeps CMAF init and segment template provenance across mirrored sites", async () => {
	const { expected, deps } = scenario("MIRROR", false, true);
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.filter((c) => c.verdict === "FAIL")).toEqual([]);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("PASS");
});

it("does not promote exhausted membership through an alias or mirror", async () => {
	const { expected, deps } = scenario("MIRROR");
	const writer = expected.muxings[0];
	if (!writer) throw new Error("Missing muxing fixture");
	writer.segmentNaming = `${"%number%".repeat(300)}.m4s`;
	for (const sample of deps.samples) {
		sample.objects = sample.objects?.filter(
			(o) => !o.key.includes("writer_0_"),
		);
		sample.objects?.push({
			outputKey: "origin",
			key: `${writer.dir.prefix}${"1".repeat(700)}.m4s`,
			size: 500_000,
		});
	}
	const report = await verifyLiveChannel(expected, deps);
	expect(
		report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
	).toBe("FAIL");
});
