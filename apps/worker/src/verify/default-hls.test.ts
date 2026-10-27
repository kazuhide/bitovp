import { readFileSync } from "node:fs";
import {
	compileExpectedArtefacts,
	compilePlan,
	encodingPlanSchema,
	validatePlan,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStep } from "../orchestrator/executor";
import { createBitmovinSdkOps } from "../orchestrator/sdk-ops";
import { parseDashText, parseHlsText } from "./adapters";
import {
	type EngineDeps,
	type VerificationReport,
	verifyArtefacts,
} from "./engine";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	plan.renditions = plan.renditions.filter((row) =>
		["v360", "a128"].includes(row.key),
	);
	plan.muxings = plan.muxings.filter((row) =>
		["v360", "a128"].includes(row.streamKey),
	);
	for (const muxing of plan.muxings)
		muxing.destination = {
			outputKey: "origin",
			path: `out/${muxing.streamKey}/`,
		};
	const hls = plan.manifests[0];
	if (hls?.kind !== "HLS") throw new Error("HLS fixture missing");
	hls.generationMode = "DEFAULT";
	hls.destination.path = "out/";
	hls.masterVersion = "HLS_V7";
	hls.mediaVersion = "HLS_V7";
	plan.generation.timing = "POST_ENCODING";
	return { plan, hls };
}

const master =
	'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="generated-audio-group",NAME="generated-en",LANGUAGE="en",URI="generated-audio-902.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=428000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=640x360,AUDIO="generated-audio-group"\ngenerated-video-901.m3u8\n';
function child(track: string) {
	return `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="${track}/init.mp4"\n#EXTINF:6,\n${track}/segment_1.m4s\n#EXTINF:6,\n${track}/segment_2.m4s\n#EXT-X-ENDLIST\n`;
}
function depsFor(root = master): EngineDeps {
	const texts: Record<string, string> = {
		"out/stream.m3u8": root,
		"out/generated-video-901.m3u8": child("v360"),
		"out/generated-audio-902.m3u8": child("a128"),
	};
	const objects = [
		...Object.keys(texts),
		...["v360", "a128"].flatMap((track) =>
			["init.mp4", "segment_1.m4s", "segment_2.m4s"].map(
				(name) => `out/${track}/${name}`,
			),
		),
	];
	return {
		listAll: async (_output, prefix) =>
			objects
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		readText: async (_output, key) => {
			const text = texts[key];
			if (text === undefined) throw new Error("NoSuchKey");
			return text;
		},
		fetchObject: async (_output, key) => key,
		fetchConcatenated: async (_output, keys) => keys.join("+"),
		probe: async (path) =>
			path.includes("v360")
				? {
						videoCodec: "h264",
						height: 360,
						width: 640,
						bitrateBps: 300_000,
						durationSec: 12,
					}
				: {
						audioCodec: "aac",
						audioSampleRate: 48_000,
						audioChannels: 2,
						audioBitrateBps: 128_000,
						bitrateBps: 128_000,
						durationSec: 12,
					},
		scanBoxes: async () => ({ psshSystemIds: [] }),
		parseHls: parseHlsText,
		parseDash: parseDashText,
		reference: { durationSec: 12 },
	};
}
const manifestFailures = (report: VerificationReport) =>
	report.checks.filter(
		(row) => row.area === "manifest" && row.verdict === "FAIL",
	);

describe("Default HLS generated output", () => {
	it("binds generated subtitle names to their selected writer and language", async () => {
		for (const mode of ["healthy", "wrong-writer", "wrong-language"] as const) {
			const { plan } = fixture();
			const source = encodingPlanSchema.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-vtt-on-aws.plan.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			);
			const subtitle = source.renditions.find((row) => row.codec === "WEBVTT"),
				muxing = source.muxings.find((row) => row.kind === "CHUNKED_TEXT");
			if (!subtitle || !muxing) throw new Error("subtitle fixture missing");
			plan.renditions.push(subtitle);
			plan.fileStreams = source.fileStreams;
			plan.muxings.push({
				...muxing,
				destination: { outputKey: "origin", path: "out/subtitles/" },
			});
			const root = master.replace(
				"#EXT-X-STREAM-INF:",
				`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="generated-subs",NAME="generated-name",LANGUAGE="${mode === "wrong-language" ? "ja" : "en"}",URI="generated-subs-903.m3u8"\n#EXT-X-STREAM-INF:`,
			);
			const deps = depsFor(root),
				read = deps.readText,
				list = deps.listAll;
			deps.readText = (output, key) =>
				key === "out/generated-subs-903.m3u8"
					? Promise.resolve(
							`#EXTM3U\n#EXTINF:6,\n${mode === "wrong-writer" ? "v360/segment_1.m4s" : "subtitles/en_webvtt_seg_1.vtt"}\n#EXT-X-ENDLIST\n`,
						)
					: read(output, key);
			const added = [
				"out/generated-subs-903.m3u8",
				"out/subtitles/en_webvtt_seg_1.vtt",
			];
			deps.listAll = async (output, prefix) => [
				...(await list(output, prefix)),
				...added
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key, size: 1024 })),
			];
			const report = await verifyArtefacts(
				compileExpectedArtefacts(plan),
				deps,
			);
			const checks = report.checks.filter((row) =>
				row.id.startsWith("manifest:hls:default-text"),
			);
			expect(checks.some((row) => row.verdict === "FAIL")).toBe(
				mode !== "healthy",
			);
			if (mode === "healthy")
				expect(checks.find((row) => row.id.endsWith(":writer"))?.verdict).toBe(
					"PASS",
				);
		}
	});
	it("runs the actual compiler and installed SDK root request and verifies provider-chosen playlist identities", async () => {
		const { plan, hls } = fixture();
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const calls: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				if (init.method === "GET")
					return new Response(
						JSON.stringify({ data: { result: { items: [] } } }),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				calls.push(JSON.parse(String(init.body)));
				return new Response(
					JSON.stringify({ data: { result: { id: "created" } } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		const ops = compilePlan(plan);
		const op = ops.find((row) => row.step === `manifest:${hls.key}`);
		if (!op) throw new Error("manifest operation missing");
		expect(
			ops.filter((row) => row.step.startsWith(`manifest:${hls.key}`)),
		).toHaveLength(1);
		await executeStep(op, {
			sdk: createBitmovinSdkOps(
				{ apiKey: "synthetic-key", tenantOrgId: null },
				async () => {},
			),
			ids: new Map([
				["encoding", "encoding-id"],
				["output:origin", "output-id"],
			]),
			resolveCredential: vi.fn(),
			poll: { intervalMs: 1, timeoutMs: 1, sleep: async () => {} },
		});
		expect(calls[0]).toMatchObject({
			encodingId: "encoding-id",
			manifestName: "stream.m3u8",
		});
		expect(calls[0]).not.toHaveProperty("uri");
		const report = await verifyArtefacts(
			compileExpectedArtefacts(plan),
			depsFor(),
		);
		expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(
			report.checks.some(
				(row) =>
					row.id.includes("v360") &&
					row.id.endsWith(":codec") &&
					row.verdict === "PASS",
			),
		).toBe(true);
	});
	it.each([
		["missing video", master.replace(/#EXT-X-STREAM-INF:[\s\S]*$/, "")],
		["wrong video codec", master.replace("avc1.64001f", "hvc1.1.6.L93")],
		["wrong geometry", master.replace("640x360", "1280x720")],
		["missing audio", master.replace(/#EXT-X-MEDIA:[^\n]*\n/, "")],
		[
			"unreferenced audio group",
			master.replace(',AUDIO="generated-audio-group"', ""),
		],
		["wrong declared audio codec", master.replace("mp4a.40.2", "ec-3")],
	])("rejects %s instead of accepting arbitrary generated tracks", async (_name, root) => {
		const { plan } = fixture();
		const report = await verifyArtefacts(
			compileExpectedArtefacts(plan),
			depsFor(root),
		);
		expect(report.checks.some((row) => row.verdict === "FAIL")).toBe(true);
	});
	it("rejects a generated audio child pointing at the video writer despite a correct audio group and count", async () => {
		const { plan } = fixture();
		const deps = depsFor();
		const read = deps.readText;
		deps.readText = (output, key) =>
			key === "out/generated-audio-902.m3u8"
				? Promise.resolve(child("v360"))
				: read(output, key);
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-audio:a128:0:present",
			)?.verdict,
		).toBe("FAIL");
	});
	it("retains audio codec, rate and channel checks on the bound writer's actual bytes", async () => {
		const { plan } = fixture();
		const deps = depsFor();
		const probe = deps.probe;
		deps.probe = (path) =>
			path.includes("a128")
				? Promise.resolve({
						audioCodec: "ac3",
						audioSampleRate: 44_100,
						audioChannels: 1,
						durationSec: 12,
					})
				: probe(path);
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.find((row) => row.id === "rendition:a128:audio-codec")
				?.verdict,
		).toBe("FAIL");
		expect(
			report.checks.find((row) => row.id === "rendition:a128:audio-rate")
				?.verdict,
		).toBe("FAIL");
		expect(
			report.checks.find((row) => row.id === "rendition:a128:audio-channels")
				?.verdict,
		).toBe("FAIL");
	});
	it("still fails empty media objects referenced by generated children", async () => {
		const { plan } = fixture();
		const deps = depsFor();
		const list = deps.listAll;
		deps.listAll = async (output, prefix) =>
			(await list(output, prefix)).map((row) =>
				row.key === "out/a128/segment_1.m4s" ? { ...row, size: 0 } : row,
			);
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.some(
				(row) =>
					row.area === "manifest" &&
					row.id.endsWith(":media-closure") &&
					row.verdict === "FAIL",
			),
		).toBe(true);
	});
	it("rejects duplicated variants instead of reducing them to a healthy stream count", async () => {
		const { plan } = fixture();
		const duplicate = master.slice(master.indexOf("#EXT-X-STREAM-INF:"));
		const report = await verifyArtefacts(
			compileExpectedArtefacts(plan),
			depsFor(master + duplicate),
		);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-variants-duplicate",
			)?.verdict,
		).toBe("FAIL");
	});
	it.each([
		"FMP4",
		"TS",
	] as const)("accepts the provider selecting %s when a stream has both compatible containers", async (selected) => {
		const { plan } = fixture();
		plan.muxings.push({
			key: "v360-ts",
			streamKey: "v360",
			kind: "TS",
			segmentLength: 6,
			segmentNaming: "segment_%number%.ts",
			destination: { outputKey: "origin", path: "out/v360-ts/" },
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const deps = depsFor();
		const list = deps.listAll;
		const extra = ["out/v360-ts/segment_1.ts", "out/v360-ts/segment_2.ts"];
		deps.listAll = async (output, prefix) => [
			...(await list(output, prefix)),
			...extra
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		];
		if (selected === "TS") {
			const read = deps.readText;
			deps.readText = (output, key) =>
				key === "out/generated-video-901.m3u8"
					? Promise.resolve(
							"#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6,\nv360-ts/segment_1.ts\n#EXTINF:6,\nv360-ts/segment_2.ts\n#EXT-X-ENDLIST\n",
						)
					: read(output, key);
		}
		const expected = compileExpectedArtefacts(plan);
		expect(expected.manifests[0]?.hlsDefault?.counts.video).toEqual({
			min: 1,
			max: 2,
		});
		const report = await verifyArtefacts(expected, deps);
		expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-video:v360:0:present",
			)?.verdict,
		).toBe("PASS");
	});
	it("accepts a muxed AV writer without AUDIO even when a standalone audio group exists", async () => {
		const { plan } = fixture();
		plan.muxings[0] = {
			key: "v360",
			streamKey: "v360",
			additionalStreamKeys: ["a128"],
			kind: "TS",
			segmentLength: 6,
			segmentNaming: "segment_%number%.ts",
			destination: { outputKey: "origin", path: "out/v360/" },
		};
		const deps = depsFor(master.replace(',AUDIO="generated-audio-group"', ""));
		const read = deps.readText,
			list = deps.listAll,
			probe = deps.probe;
		deps.readText = (output, key) =>
			key === "out/generated-video-901.m3u8"
				? Promise.resolve(
						"#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6,\nv360/segment_1.ts\n#EXTINF:6,\nv360/segment_2.ts\n#EXT-X-ENDLIST\n",
					)
				: read(output, key);
		deps.listAll = async (output, prefix) => [
			...(await list(output, prefix)),
			...["out/v360/segment_1.ts", "out/v360/segment_2.ts"]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		];
		deps.probe = async (path) => ({
			...(await probe(path)),
			...(path.includes("v360")
				? {
						audioCodec: "aac",
						audioSampleRate: 48_000,
						audioChannels: 2,
						audioBitrateBps: 128_000,
					}
				: {}),
		});
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).toEqual([]);
	});
	it("verifies only the chosen encoding when another encoding has a different fixed ladder", async () => {
		const { plan } = fixture();
		plan.encodings = [
			{ key: "other", name: "Other" },
			{ key: "selected", name: "Selected" },
		];
		for (const row of [...plan.renditions, ...plan.ingest])
			row.encodingKey = "selected";
		const input = plan.ingest.find((row) => row.key === "video");
		if (!input) throw new Error("video input missing");
		plan.ingest.push({ ...input, key: "other-ingest", encodingKey: "other" });
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw new Error("video missing");
		plan.renditions.push({
			...video,
			key: "other-video",
			encodingKey: "other",
			ingestKey: "other-ingest",
			height: 720,
		});
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("muxing missing");
		plan.muxings.push({
			...muxing,
			key: "other-video",
			streamKey: "other-video",
			destination: { outputKey: "origin", path: "other/video/" },
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const report = await verifyArtefacts(
			compileExpectedArtefacts(plan),
			depsFor(),
		);
		expect(manifestFailures(report)).toEqual([]);
		expect(
			report.checks.some(
				(row) =>
					row.id.startsWith("manifest:hls") &&
					row.detail.includes("other-video"),
			),
		).toBe(false);
	});
});

describe.each([
	"DEFAULT",
	"MANUAL",
] as const)("%s HLS MP4 byte ranges", (generationMode) => {
	it.each([
		[
			"an explicit range ending at the object boundary",
			"100@0",
			"400@100",
			undefined,
			"500@500",
			false,
		],
		[
			"an implicit media offset ending at the object boundary",
			"100@0",
			"400@100",
			undefined,
			"500",
			false,
		],
		[
			"a media range beyond the object boundary",
			"100@0",
			"200@900",
			undefined,
			"100@100",
			true,
		],
		[
			"an implicit media range beyond the object boundary",
			"100@0",
			"500@100",
			undefined,
			"500",
			true,
		],
		[
			"a later initialization range beyond the object boundary",
			"100@0",
			"100@100",
			"200@900",
			"100@500",
			true,
		],
		[
			"different initialization ranges sharing one object",
			"100@0",
			"100@100",
			"100@500",
			"300@700",
			false,
		],
	] as const)("checks %s against actual object bytes", async (_name, firstMap, firstRange, secondMap, secondRange, invalid) => {
		const { plan, hls } = fixture();
		hls.generationMode = generationMode;
		plan.muxings[0] = {
			key: "v360",
			kind: "MP4",
			streamKey: "v360",
			filename: "video.mp4",
			fragmentDuration: 1000,
			manifestType: "HLS_BYTE_RANGES",
			destination: { outputKey: "origin", path: "out/v360/" },
		};
		if (generationMode === "MANUAL") {
			hls.audioGroupId = "generated-audio-group";
			const video = plan.renditions[0],
				audio = plan.renditions[1];
			if (!video || !audio) throw new Error("tracks missing");
			video.hlsVariantUri = "generated-video-901.m3u8";
			audio.hlsMedia = {
				name: "generated-en",
				groupId: "generated-audio-group",
				uri: "generated-audio-902.m3u8",
			};
		}
		const deps = depsFor(),
			read = deps.readText,
			list = deps.listAll;
		deps.readText = (output, key) =>
			key === "out/generated-video-901.m3u8"
				? Promise.resolve(
						`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="v360/video.mp4",BYTERANGE="${firstMap}"\n#EXTINF:6,\n#EXT-X-BYTERANGE:${firstRange}\nv360/video.mp4\n${secondMap ? `#EXT-X-MAP:URI="v360/video.mp4",BYTERANGE="${secondMap}"\n` : ""}#EXTINF:6,\n#EXT-X-BYTERANGE:${secondRange}\nv360/video.mp4\n#EXT-X-ENDLIST\n`,
					)
				: read(output, key);
		deps.listAll = async (output, prefix) => [
			...(await list(output, prefix)).filter(
				(object) => !object.key.startsWith("out/v360/"),
			),
			...("out/v360/video.mp4".startsWith(prefix)
				? [{ key: "out/v360/video.mp4", size: 1000 }]
				: []),
		];
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		if (!invalid) expect(manifestFailures(report)).toEqual([]);
		expect(manifestFailures(report).length > 0).toBe(invalid);
		expect(
			report.checks.find(
				(check) =>
					check.id.includes("generated-video-901") &&
					check.id.endsWith(":reference-bytes"),
			)?.verdict,
		).toBe(invalid ? "FAIL" : "PASS");
		if (generationMode === "DEFAULT")
			expect(
				report.checks.find(
					(check) => check.id === "manifest:hls:default-video:v360:0:present",
				)?.verdict,
			).toBe(invalid ? "FAIL" : "PASS");
	});
});

function perTitleFixture() {
	const { plan } = fixture();
	const video = plan.renditions[0];
	if (video?.codec !== "H264") throw new Error("video missing");
	video.mode = "PER_TITLE_TEMPLATE";
	video.bitrate = null;
	video.height = null;
	const muxing = plan.muxings[0];
	if (!muxing) throw new Error("video muxing missing");
	muxing.destination = { outputKey: "origin", path: "out/v360/{uuid}/" };
	const directory = "v360/00000000-0000-4000-8000-000000000010";
	const deps = depsFor();
	const read = deps.readText,
		list = deps.listAll;
	deps.readText = (output, key) =>
		key === "out/generated-video-901.m3u8"
			? Promise.resolve(child(directory))
			: read(output, key);
	const objects = ["init.mp4", "segment_1.m4s", "segment_2.m4s"].map(
		(name) => `out/${directory}/${name}`,
	);
	deps.listAll = async (output, prefix) => [
		...(await list(output, prefix)).filter(
			(row) => !row.key.startsWith("out/v360/"),
		),
		...objects
			.filter((key) => key.startsWith(prefix))
			.map((key) => ({ key, size: 1024 })),
	];
	deps.providerOutputIds = { origin: "output-id" };
	deps.perTitlePopulations = {
		status: "complete",
		results: [
			{
				streamId: "selected-result",
				templateRendition: "v360",
				codecType: "H264",
			},
			{
				streamId: "other-result",
				templateRendition: "other-template",
				codecType: "H265",
			},
		],
		qc: [],
		deliveryMuxings: [
			{
				streamId: "selected-result",
				templateRendition: "v360",
				muxingId: "result-muxing",
				muxingType: "FMP4",
				legs: [
					{
						streamId: "selected-result",
						templateRendition: "v360",
						muxingId: "result-muxing",
						muxingType: "FMP4",
						outputId: "output-id",
						resolvedPath: `out/${directory}/`,
					},
				],
			},
		],
	};
	return { plan, deps };
}

describe("Default HLS Per-Title witnesses", () => {
	it("keeps missing output identity unverified without inventing an absent RESULT", async () => {
		const { plan, deps } = perTitleFixture();
		delete deps.providerOutputIds;
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).toEqual([]);
		expect(
			report.checks.find(
				(row) =>
					row.id ===
					"manifest:hls:default-video-result:selected-result:present",
			)?.verdict,
		).toBe("SKIP");
	});
	it("does not treat a missing fixed-resolution template as a pruned flexible template", async () => {
		const { plan, deps } = perTitleFixture();
		const video = plan.renditions[0],
			muxing = plan.muxings[0];
		if (video?.codec !== "H264" || !muxing) throw new Error("fixture missing");
		plan.renditions.push({
			...video,
			key: "required",
			height: 540,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		plan.muxings.push({
			...muxing,
			key: "required",
			streamKey: "required",
			destination: { outputKey: "origin", path: "out/required/{uuid}/" },
		});
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-video-required:required",
			)?.verdict,
		).toBe("FAIL");
	});
	it.each([
		"absent",
		"untyped",
	] as const)("rejects a known wrong codec even with %s RESULT codec evidence", async (evidence) => {
		const { plan, deps } = perTitleFixture();
		if (evidence === "absent") delete deps.perTitlePopulations;
		else if (deps.perTitlePopulations?.status === "complete")
			for (const result of deps.perTitlePopulations.results)
				delete result.codecType;
		const read = deps.readText;
		deps.readText = (output, key) =>
			key === "out/stream.m3u8"
				? Promise.resolve(master.replace("avc1.64001f", "hvc1.1.6.L93"))
				: read(output, key);
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).not.toEqual([]);
	});
	it("accepts one captured RESULT when another flexible template was pruned", async () => {
		const { plan, deps } = perTitleFixture();
		const video = plan.renditions[0],
			muxing = plan.muxings[0];
		if (video?.codec !== "H264" || !muxing) throw new Error("fixture missing");
		plan.renditions.push({ ...video, key: "pruned", height: 540 });
		plan.muxings.push({
			...muxing,
			key: "pruned",
			streamKey: "pruned",
			destination: { outputKey: "origin", path: "out/pruned/{uuid}/" },
		});
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).toEqual([]);
		expect(
			report.checks.find((row) => row.id === "manifest:hls:default-video-count")
				?.verdict,
		).toBe("PASS");
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:pertitle-video-families",
			)?.verdict,
		).toBe("PASS");
	});
	it.each([
		["two RESULTs, both containers from the first", true, true],
		["two RESULTs, one container each", true, false],
		["one RESULT, two distinct containers", false, false],
	] as const)("covers distinct RESULT identities: %s", async (_name, secondResult, omitSecond) => {
		const { plan, deps } = perTitleFixture();
		const muxing = plan.muxings[0];
		const population = deps.perTitlePopulations;
		if (
			!muxing ||
			population?.status !== "complete" ||
			!population.deliveryMuxings[0]
		)
			throw new Error("fixture missing");
		plan.muxings.push({
			key: "video-ts",
			kind: "TS",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "segment_%number%.ts",
			destination: { outputKey: "origin", path: "out/v360/{uuid}/ts/" },
		});
		const directory =
			secondResult && !omitSecond
				? "v360/00000000-0000-4000-8000-000000000011"
				: "v360/00000000-0000-4000-8000-000000000010/ts";
		const source = population.deliveryMuxings[0];
		population.deliveryMuxings.push({
			...source,
			muxingId: "result-ts",
			muxingType: "TS",
			legs: source.legs.map((leg) => ({
				...leg,
				muxingId: "result-ts",
				muxingType: "TS",
				resolvedPath: "out/v360/00000000-0000-4000-8000-000000000010/ts/",
			})),
		});
		if (secondResult) {
			population.results.push({
				streamId: "second-result",
				templateRendition: "v360",
				codecType: "H264",
			});
			population.deliveryMuxings.push({
				...source,
				streamId: "second-result",
				muxingId: "second-muxing",
				legs: source.legs.map((leg) => ({
					...leg,
					streamId: "second-result",
					muxingId: "second-muxing",
					resolvedPath: "out/v360/00000000-0000-4000-8000-000000000011/",
				})),
			});
		}
		const read = deps.readText,
			list = deps.listAll;
		deps.readText = (output, key) => {
			if (key === "out/stream.m3u8")
				return Promise.resolve(
					master +
						master
							.slice(master.indexOf("#EXT-X-STREAM-INF:"))
							.replace("generated-video-901.m3u8", "second-video.m3u8"),
				);
			if (key === "out/second-video.m3u8")
				return Promise.resolve(
					secondResult && !omitSecond
						? child(directory)
						: `#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6,\n${directory}/segment_1.ts\n#EXTINF:6,\n${directory}/segment_2.ts\n#EXT-X-ENDLIST\n`,
				);
			return read(output, key);
		};
		const added = [
			"out/second-video.m3u8",
			...[
				"init.mp4",
				"segment_1.m4s",
				"segment_2.m4s",
				"segment_1.ts",
				"segment_2.ts",
			].map((name) => `out/${directory}/${name}`),
		];
		deps.listAll = async (output, prefix) => [
			...(await list(output, prefix)),
			...added
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		];
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		if (omitSecond) expect(manifestFailures(report)).not.toEqual([]);
		else expect(manifestFailures(report)).toEqual([]);
	});
	it("retains one RESULT offered with distinct proven AAC and Dolby audio groups", async () => {
		const { plan, deps } = perTitleFixture();
		plan.renditions.push({
			key: "a192",
			codec: "DDPLUS",
			ingestKey: "audio",
			bitrate: 192_000,
			rate: 48_000,
			channelLayout: "CL_STEREO",
		});
		plan.muxings.push({
			key: "a192",
			kind: "FMP4",
			streamKey: "a192",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "out/a192/" },
		});
		const read = deps.readText,
			list = deps.listAll,
			probe = deps.probe;
		deps.readText = (output, key) => {
			if (key === "out/stream.m3u8")
				return Promise.resolve(
					master +
						'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="generated-dolby",NAME="Dolby",LANGUAGE="en",URI="generated-dolby.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=492000,CODECS="avc1.64001f,ec-3",RESOLUTION=640x360,AUDIO="generated-dolby"\ngenerated-video-dolby.m3u8\n',
				);
			if (key === "out/generated-dolby.m3u8")
				return Promise.resolve(child("a192"));
			if (key === "out/generated-video-dolby.m3u8")
				return read(output, "out/generated-video-901.m3u8");
			return read(output, key);
		};
		const added = [
			"out/generated-dolby.m3u8",
			"out/generated-video-dolby.m3u8",
			"out/a192/init.mp4",
			"out/a192/segment_1.m4s",
			"out/a192/segment_2.m4s",
		];
		deps.listAll = async (output, prefix) => [
			...(await list(output, prefix)),
			...added
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		];
		deps.probe = (path) =>
			path.includes("a192")
				? Promise.resolve({
						audioCodec: "eac3",
						audioChannels: 2,
						audioSampleRate: 48_000,
						audioBitrateBps: 192_000,
						durationSec: 12,
					})
				: probe(path);
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).toEqual([]);
		expect(
			report.checks.find((row) => row.id === "manifest:hls:default-video-count")
				?.verdict,
		).toBe("PASS");
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-video-associations",
			)?.verdict,
		).toBe("PASS");
	});
	it("rejects repeated writer/audio associations under different playlist aliases", async () => {
		const { plan, deps } = perTitleFixture();
		const read = deps.readText;
		deps.readText = async (output, key) => {
			if (key === "out/stream.m3u8")
				return (
					master +
					master
						.slice(master.indexOf("#EXT-X-STREAM-INF:"))
						.replace("generated-video-901.m3u8", "another-result.m3u8")
				);
			if (key === "out/another-result.m3u8")
				return read(output, "out/generated-video-901.m3u8");
			return read(output, key);
		};
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-video-associations",
			)?.verdict,
		).toBe("FAIL");
	});
	it("compares captured families only for the selected templates and binds their output legs", async () => {
		const { plan, deps } = perTitleFixture();
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(manifestFailures(report)).toEqual([]);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:pertitle-video-families",
			)?.verdict,
		).toBe("PASS");
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:default-video-result:0:writer",
			)?.verdict,
		).toBe("PASS");
	});
	it("does not certify the selection with another encoding's capture or without attribution", async () => {
		for (const missing of ["absent", "other-only", "unattributed"] as const) {
			const { plan, deps } = perTitleFixture();
			if (missing === "absent") delete deps.perTitlePopulations;
			else if (deps.perTitlePopulations?.status === "complete")
				deps.perTitlePopulations.results =
					missing === "other-only"
						? [
								{
									streamId: "other",
									templateRendition: "other-template",
									codecType: "H265",
								},
							]
						: [{ streamId: "selected", codecType: "H264" }];
			const report = await verifyArtefacts(
				compileExpectedArtefacts(plan),
				deps,
			);
			expect(
				report.checks.find(
					(row) => row.id === "manifest:hls:pertitle-video-families",
				)?.verdict,
			).toBe("SKIP");
		}
	});
	it("fails a selected RESULT whose captured codec contradicts its template", async () => {
		const { plan, deps } = perTitleFixture();
		if (
			deps.perTitlePopulations?.status !== "complete" ||
			!deps.perTitlePopulations.results[0]
		)
			throw new Error("capture missing");
		deps.perTitlePopulations.results[0].codecType = "H265";
		const report = await verifyArtefacts(compileExpectedArtefacts(plan), deps);
		expect(
			report.checks.find(
				(row) => row.id === "manifest:hls:pertitle-video-families",
			)?.verdict,
		).toBe("FAIL");
	});
});
