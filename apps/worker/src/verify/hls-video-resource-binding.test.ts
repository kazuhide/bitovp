import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	compileExpectedLiveArtefacts,
	encodingPlanSchema,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { parseHlsText } from "./adapters";
import { type EngineDeps, verifyArtefacts } from "./engine";
import { collectHlsReferenceChecks } from "./manifest-reference-checks";
import { collectEdgeClosures, type LiveRunnerDeps } from "./runner-live";

const FIXTURES = join(import.meta.dirname, "../../../../packages/core/src");
const ROOT = "https://edge.example.test/cmaf/live/1/event/";
const PREFIX = "runs/current/";
const credentialId = "00000000-0000-4000-8000-000000000003";

function live() {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(FIXTURES, "live/__fixtures__/live-rtmp-simple.plan.json"),
				"utf8",
			),
		),
	);
	plan.renditions = plan.renditions.filter((row) =>
		["v1080", "v720"].includes(row.key),
	);
	plan.muxings = plan.muxings
		.filter((row) => ["v1080", "v720"].includes(row.key))
		.map((row, index) => ({
			...row,
			key: index ? "B" : "A",
			destination: {
				outputKey: "origin",
				path: `${PREFIX}${index ? "B" : "A"}`,
			},
			segmentNaming: "media/segment_%number%.m4s",
			initSegmentName: "headers/init.mp4",
		}));
	plan.outputs.push({
		key: "mirror",
		kind: "AKAMAI_MSL",
		name: "Mirror",
		credentialId,
		streamFormat: "CMAF",
		mslVersion: "MSL4",
	});
	plan.deliveryMirrors = [{ outputKey: "mirror" }];
	plan.liveManifests = plan.liveManifests
		.filter((row) => row.kind === "HLS")
		.map((row) => ({
			...row,
			destination: { outputKey: "origin", path: `${PREFIX}manifests` },
			detailed: {
				additionalMedia: [
					{
						type: "VIDEO",
						muxingKey: "A",
						groupId: "angles",
						name: "Alternate",
						uri: "angle.m3u8",
					},
				],
			},
		}));
	return plan;
}

function vod() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(FIXTURES, "plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json"),
				"utf8",
			),
		),
	);
	plan.qc = undefined;
	plan.renditions = plan.renditions
		.filter((row) => row.codec === "H264")
		.slice(0, 2);
	plan.muxings = plan.renditions.map((row, index) => ({
		key: index ? "B" : "A",
		kind: "FMP4",
		streamKey: row.key,
		segmentLength: 6,
		segmentNaming: "media/segment_%number%.m4s",
		initSegmentName: "headers/init.mp4",
		destination: { outputKey: "origin", path: `${PREFIX}${index ? "B" : "A"}` },
	}));
	plan.manifests = plan.manifests
		.filter((row) => row.kind === "HLS")
		.map((row) => ({
			...row,
			destination: { outputKey: "origin", path: `${PREFIX}manifests` },
			detailed: {
				additionalMedia: [
					{
						type: "VIDEO",
						muxingKey: "A",
						groupId: "angles",
						name: "Alternate",
						uri: "angle.m3u8",
					},
				],
			},
		}));
	return plan;
}

const master =
	'#EXTM3U\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="angles",NAME="Alternate",URI="angle.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=4500000\nvideo_4500000.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nvideo_3000000.m3u8\n';
function child(folder: string, edge = false) {
	const base = edge ? `${PREFIX}${folder}` : `../${folder}`;
	return `#EXTM3U\n#EXT-X-MAP:URI="${base}/headers/init.mp4"\n#EXTINF:6,\n${base}/media/segment_1.m4s\n#EXTINF:6,\n${base}/media/segment_2.m4s\n#EXT-X-ENDLIST\n`;
}
const files = ["A", "B"].flatMap((folder) => [
	`${PREFIX}${folder}/headers/init.mp4`,
	`${PREFIX}${folder}/media/segment_1.m4s`,
	`${PREFIX}${folder}/media/segment_2.m4s`,
]);
function originDeps(text: string, objects = files) {
	return {
		readText: async () => text,
		parseHls: parseHlsText,
		listAll: async (_output: string, prefix: string) =>
			objects
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1000 })),
	};
}

async function edgeClosure(
	expected: ReturnType<typeof compileExpectedLiveArtefacts>,
	angle: string,
	objects = files,
	readProof: {
		bodyComplete?: boolean;
		bytes?: number;
		status?: number;
		body?: Uint8Array;
	} = { bodyComplete: true },
) {
	const binding = [
		{
			outputKey: "mirror",
			credentialId,
			streamId: 1,
			eventName: "event",
			streamFormat: "CMAF" as const,
			mslVersion: "MSL4",
			eventRoot: ROOT,
		},
	];
	const deps: LiveRunnerDeps = {
		api: async () => ({ status: 200, json: null }),
		readText: async () => "",
		listAll: async () => [],
		sleep: async () => {},
		now: () => 0,
		readEdge: async (url) => {
			const key = decodeURIComponent(url.slice(ROOT.length));
			const text =
				key === "stream.m3u8"
					? master
					: key === "angle.m3u8"
						? angle
						: key.endsWith(".m3u8")
							? child("A", true)
							: undefined;
			return text !== undefined
				? { status: 200, bytes: text.length, text }
				: {
						status: objects.includes(key) ? 200 : 404,
						bytes: objects.includes(key) ? (readProof.bytes ?? 1000) : 0,
						text: "bytes",
						body: new Uint8Array(1000),
						...readProof,
					};
		},
	};
	return (
		await collectEdgeClosures(
			deps,
			expected,
			binding,
			{ mirror: "provider-mirror" },
			PREFIX,
		)
	)[0];
}

describe("additional HLS VIDEO writer identity", () => {
	it.each([
		["100@0", "200@100", "200@300", true],
		["200@900", "200@100", "200@300", false],
		["100@0", "200@900", "200@300", false],
		["100@0", "200@100", "200@900", false],
	] as const)("checks edge init/media byte bounds %s %s %s", async (initRange, firstRange, secondRange, closed) => {
		const content = `#EXTM3U\n#EXT-X-MAP:URI="${PREFIX}A/headers/init.mp4",BYTERANGE="${initRange}"\n#EXTINF:6,\n#EXT-X-BYTERANGE:${firstRange}\n${PREFIX}A/media/segment_1.m4s\n#EXTINF:6,\n#EXT-X-BYTERANGE:${secondRange}\n${PREFIX}A/media/segment_2.m4s\n`;
		const closure = await edgeClosure(
			compileExpectedLiveArtefacts(live()),
			content,
		);
		expect(closure?.closed).toBe(closed);
	});

	it.each([
		true,
		false,
	])("checks every init-map range, including an earlier invalid map=%s", async (earlier) => {
		const content = `#EXTM3U\n#EXT-X-MAP:URI="${PREFIX}A/headers/init.mp4",BYTERANGE="${earlier ? "200@900" : "100@0"}"\n#EXTINF:6,\n${PREFIX}A/media/segment_1.m4s\n#EXT-X-MAP:URI="${PREFIX}A/headers/init.mp4",BYTERANGE="${earlier ? "100@0" : "200@900"}"\n#EXTINF:6,\n${PREFIX}A/media/segment_2.m4s\n`;
		expect(
			(await edgeClosure(compileExpectedLiveArtefacts(live()), content))
				?.closed,
		).toBe(false);
	});

	it.each([
		{},
		{ bodyComplete: false },
		{ bodyComplete: true, bytes: Number.NaN },
		{ bodyComplete: true, bytes: 0 },
		{ bodyComplete: true, status: 206 },
		{ bodyComplete: true, body: new Uint8Array(10) },
	] as const)("does not certify a range from missing, capped or invalid byte proof %j", async (proof) => {
		const content = child("A", true).replace(
			'init.mp4"',
			'init.mp4",BYTERANGE="100@0"',
		);
		expect(
			(
				await edgeClosure(
					compileExpectedLiveArtefacts(live()),
					content,
					files,
					proof,
				)
			)?.closed,
		).toBe(false);
	});

	it.each([
		false,
		true,
	])("checks even unsampled ranges on a shared fetched object, overrun=%s", async (overrun) => {
		const media = Array.from(
			{ length: 15 },
			(_, index) =>
				`#EXTINF:6,\n#EXT-X-BYTERANGE:${overrun && index === 12 ? "200@900" : `100@${index * 20}`}\n${PREFIX}A/media/segment_1.m4s\n`,
		).join("");
		const content = `#EXTM3U\n#EXT-X-MAP:URI="${PREFIX}A/headers/init.mp4",BYTERANGE="100@0"\n${media}`;
		const closure = await edgeClosure(
			compileExpectedLiveArtefacts(live()),
			content,
		);
		expect(closure?.closed).toBe(!overrun);
		if (!overrun) {
			const angle = closure?.children?.find(
				(entry) => entry.id === "angle.m3u8",
			);
			expect(
				angle?.served.some((entry) => entry.byteRange?.length === 100),
			).toBe(true);
		}
	});

	it("does not certify ranged objects omitted by the bounded edge sample", async () => {
		const stored = [
			...files,
			...Array.from(
				{ length: 15 },
				(_, index) => `${PREFIX}A/media/segment_${index + 1}.m4s`,
			),
		];
		const media = Array.from(
			{ length: 15 },
			(_, index) =>
				`#EXTINF:6,\n#EXT-X-BYTERANGE:100@0\n${PREFIX}A/media/segment_${index + 1}.m4s\n`,
		).join("");
		const content = `#EXTM3U\n#EXT-X-MAP:URI="${PREFIX}A/headers/init.mp4"\n${media}`;
		expect(
			(await edgeClosure(compileExpectedLiveArtefacts(live()), content, stored))
				?.closed,
		).toBe(false);
	});

	it.each([
		["init_%ZZ.mp4", "init_%25ZZ.mp4", "PASS"],
		["init_%25ZZ.mp4", "init_%2525ZZ.mp4", "PASS"],
		["init_%ZZ.mp4", "init_%ZZ.mp4", "FAIL"],
		["init_%ZZ.mp4", "init_%E0%A4.mp4", "FAIL"],
		["init_%ZZ.mp4", "init_%2525ZZ.mp4", "FAIL"],
	] as const)("uses one strict URI decode in verifyArtefacts for %s referenced as %s", async (filename, uri, verdict) => {
		const plan = vod();
		const source = plan.muxings[0];
		if (source?.kind !== "FMP4") throw new Error("Missing fMP4");
		source.initSegmentName = `headers/${filename}`;
		const expected = compileExpectedArtefacts(plan);
		const manifest = expected.manifests[0];
		if (!manifest) throw new Error("Missing manifest");
		const stored = [
			...files.filter((key) => key !== `${PREFIX}A/headers/init.mp4`),
			`${PREFIX}A/headers/${filename}`,
		];
		const fetchConcatenated = vi.fn(async (_output: string, keys: string[]) =>
			keys.join("+"),
		);
		const deps: EngineDeps = {
			...originDeps(child("A").replace("init.mp4", uri), stored),
			readText: async (_output, key) =>
				key.endsWith("stream.m3u8")
					? master
					: child(key.endsWith("video_3000000.m3u8") ? "B" : "A").replace(
							"../A/headers/init.mp4",
							`../A/headers/${uri}`,
						),
			fetchObject: async (_output, key) => key,
			fetchConcatenated,
			probe: async () => ({
				videoCodec: "h264",
				durationSec: 12,
				nbFrames: 360,
			}),
			scanBoxes: async () => ({ psshSystemIds: [] }),
			parseDash: async () => {
				throw new Error("No DASH fixture");
			},
		};
		const report = await verifyArtefacts(expected, deps);
		const closure = report.checks.find((check) =>
			check.id.includes(":child:angle-m3u8:media-closure"),
		);
		expect(closure?.verdict).toBe(verdict);
		if (verdict === "PASS") {
			expect(fetchConcatenated).toHaveBeenCalledWith("origin", [
				`${PREFIX}A/headers/${filename}`,
				`${PREFIX}A/media/segment_1.m4s`,
				`${PREFIX}A/media/segment_2.m4s`,
			]);
		}
	});
	for (const template of [false, true])
		it(`preserves literal directories and ${template ? "template" : "literal"} random filename tokens`, async () => {
			const plan = live();
			const source = plan.muxings[0];
			if (source?.kind !== "FMP4") throw new Error("missing fMP4");
			source.destination = {
				outputKey: "origin",
				path: `${PREFIX}literal/%number%`,
			};
			source.initSegmentName = "headers/init_{rand_chars:8}_%number%.mp4";
			source.segmentNaming = "media/seg-{rand_chars:8}-%number%.m4s";
			if (template) source.segmentNamingTemplate = source.segmentNaming;
			const manifest = compileExpectedLiveArtefacts(plan).manifests[0];
			if (!manifest) throw new Error("missing HLS");
			const root = await parseHlsText(master);
			const literal = "seg-{rand_chars:8}-1.m4s",
				expanded = "seg-Ab12Cd34-1.m4s";
			const content = (filename: string) =>
				`#EXTM3U\n#EXT-X-MAP:URI="../literal/%25number%25/headers/init_{rand_chars:8}_%25number%25.mp4"\n#EXTINF:6,\n../literal/%25number%25/media/${encodeURIComponent(filename)}\n`;
			const stored = [
				`${PREFIX}literal/%number%/headers/init_{rand_chars:8}_%number%.mp4`,
				...[literal, expanded].map(
					(filename) => `${PREFIX}literal/%number%/media/${filename}`,
				),
			];
			const healthy = await collectHlsReferenceChecks(
				originDeps(content(template ? expanded : literal), stored),
				"test",
				manifest,
				root,
			);
			expect(healthy.filter((check) => check.verdict === "FAIL")).toEqual([]);
			const wrong = await collectHlsReferenceChecks(
				originDeps(content(template ? literal : expanded), stored),
				"test",
				manifest,
				root,
			);
			expect(
				wrong.find((check) => check.id.endsWith(":binding"))?.verdict,
			).toBe("FAIL");
		});

	it("does not borrow same-named bytes from an undeclared output", async () => {
		const manifest = compileExpectedLiveArtefacts(live()).manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const checks = await collectHlsReferenceChecks(
			originDeps(child("A")),
			"test",
			{ ...manifest, outputKey: "unrelated" },
			await parseHlsText(master),
		);
		expect(checks.find((check) => check.id.endsWith(":binding"))?.verdict).toBe(
			"FAIL",
		);
	});
	it("decodes literal percent names once and rejects malformed URI escapes at origin and edge", async () => {
		const plan = live();
		const source = plan.muxings[0];
		if (source?.kind !== "FMP4") throw new Error("missing fMP4");
		source.initSegmentName = "headers/init_%ZZ.mp4";
		const expected = compileExpectedLiveArtefacts(plan);
		const manifest = expected.manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const stored = [...files, `${PREFIX}A/headers/init_%ZZ.mp4`];
		const root = await parseHlsText(master);
		for (const [name, verdict] of [
			["init_%25ZZ.mp4", "PASS"],
			["init_%ZZ.mp4", "FAIL"],
			["init_%E0%A4.mp4", "FAIL"],
		] as const) {
			const content = child("A").replace("init.mp4", name);
			const checks = await collectHlsReferenceChecks(
				originDeps(content, stored),
				"test",
				manifest,
				root,
			);
			expect(
				checks.find((check) => check.id.endsWith(":binding"))?.verdict,
			).toBe(verdict);
			const closure = await edgeClosure(
				expected,
				content.replaceAll("../A/", `${PREFIX}A/`),
				stored,
			);
			expect(closure?.closed).toBe(verdict === "PASS");
		}
	});
	it("requires consistent positive byte sizes and preserves object-listing errors", async () => {
		const manifest = compileExpectedLiveArtefacts(live()).manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const root = await parseHlsText(master);
		const listed = files.map((key) => ({
			key,
			size: 1000 as number | undefined,
		}));
		for (const [objects, verdict] of [
			[listed, "PASS"],
			[
				[...listed, { key: `${PREFIX}A/headers/init.mp4`, size: undefined }],
				"PASS",
			],
			[[...listed, { key: `${PREFIX}A/headers/init.mp4`, size: 999 }], "FAIL"],
			[listed.map((object) => ({ ...object, size: undefined })), "SKIP"],
			[listed.map((object) => ({ ...object, size: 0 })), "FAIL"],
		] as const) {
			const checks = await collectHlsReferenceChecks(
				{ ...originDeps(child("A")), listAll: async () => [...objects] },
				"test",
				manifest,
				root,
			);
			expect(
				checks.find((check) => check.id.endsWith(":objects"))?.verdict,
			).toBe(verdict);
		}
		const checks = await collectHlsReferenceChecks(
			{
				...originDeps(child("A")),
				listAll: async () => {
					throw new Error("listing unavailable");
				},
			},
			"test",
			manifest,
			root,
		);
		expect(checks.find((check) => check.id.endsWith(":binding"))?.verdict).toBe(
			"PASS",
		);
		expect(checks.find((check) => check.id.endsWith(":objects"))?.verdict).toBe(
			"FAIL",
		);
		expect(new Set(checks.map((check) => check.id)).size).toBe(checks.length);
	});
	it("retains each distinct VIDEO child using the same muxing", async () => {
		const plan = live();
		const configured = plan.liveManifests[0];
		if (
			configured?.kind !== "HLS" ||
			configured.detailed?.additionalMedia?.[0]?.type !== "VIDEO"
		)
			throw new Error("missing VIDEO");
		configured.detailed.additionalMedia.push({
			...configured.detailed.additionalMedia[0],
			name: "Second",
			uri: "angle2.m3u8",
		});
		const manifest = compileExpectedLiveArtefacts(plan).manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const root = await parseHlsText(
			master.replace(
				"#EXT-X-STREAM-INF:BANDWIDTH=4500000",
				'#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="angles",NAME="Second",URI="angle2.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=4500000',
			),
		);
		const healthy = await collectHlsReferenceChecks(
			originDeps(child("A")),
			"test",
			manifest,
			root,
		);
		expect(healthy.filter((check) => check.verdict === "FAIL")).toEqual([]);
		const wrong = await collectHlsReferenceChecks(
			{
				...originDeps(child("A")),
				readText: async (_output, key) =>
					key.endsWith("angle2.m3u8") ? child("B") : child("A"),
			},
			"test",
			manifest,
			root,
		);
		expect(
			wrong.find(
				(check) => check.id === "test:additional-media:0:playlist:binding",
			)?.verdict,
		).toBe("PASS");
		expect(
			wrong.find(
				(check) => check.id === "test:additional-media:1:playlist:binding",
			)?.verdict,
		).toBe("FAIL");
	});

	for (const inherited of [false, true])
		it(`binds the effective encrypted destination (${inherited ? "inherited" : "explicit"} DRM selection)`, async () => {
			const plan = live();
			plan.drm = plan.muxings.map((muxing) => ({
				key: `${muxing.key}-encrypted`,
				muxingKey: muxing.key,
				kind: "FAIRPLAY",
				credentialId,
				iv: "a".repeat(32),
				uri: "skd://synthetic",
				destination: {
					outputKey: "origin",
					path: `${PREFIX}${muxing.key}/secure`,
				},
			}));
			const configured = plan.liveManifests[0];
			if (
				configured?.kind !== "HLS" ||
				configured.detailed?.additionalMedia?.[0]?.type !== "VIDEO"
			)
				throw new Error("missing VIDEO");
			if (inherited) configured.drmKind = "FAIRPLAY";
			else
				configured.detailed.additionalMedia[0] = {
					...configured.detailed.additionalMedia[0],
					drmKey: "A-encrypted",
				};
			const manifest = compileExpectedLiveArtefacts(plan).manifests[0];
			if (!manifest) throw new Error("missing HLS");
			expect(manifest.hlsAdditionalMedia?.[0]).toMatchObject({
				drmKey: "A-encrypted",
				resource: {
					drmKey: "A-encrypted",
					directory: `${PREFIX}A/secure/`,
					outputKey: "origin",
				},
			});
			const stored = [
				...files,
				...files.map((key) => key.replace(/\/(A|B)\//, "/$1/secure/")),
			];
			const root = await parseHlsText(master);
			const healthy = await collectHlsReferenceChecks(
				originDeps(child("A/secure"), stored),
				"test",
				manifest,
				root,
			);
			expect(healthy.filter((check) => check.verdict === "FAIL")).toEqual([]);
			expect(
				(
					await edgeClosure(
						compileExpectedLiveArtefacts(plan),
						child("A/secure", true),
						stored,
					)
				)?.closed,
			).toBe(true);
			for (const folder of ["B/secure", "A"]) {
				const wrong = await collectHlsReferenceChecks(
					originDeps(child(folder), stored),
					"test",
					manifest,
					root,
				);
				expect(
					wrong.find((check) => check.id.endsWith(":binding"))?.verdict,
				).toBe("FAIL");
				expect(
					(
						await edgeClosure(
							compileExpectedLiveArtefacts(plan),
							child(folder, true),
							stored,
						)
					)?.closed,
				).toBe(false);
			}
		});

	it("checks every initialization change and missing initialization bytes", async () => {
		const manifest = compileExpectedLiveArtefacts(live()).manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const root = await parseHlsText(master);
		const changed = child("A").replace(
			"#EXTINF:6,\n../A/media/segment_2",
			'#EXT-X-MAP:URI="../B/headers/init.mp4"\n#EXTINF:6,\n../A/media/segment_2',
		);
		for (const text of [changed, child("A").replace(/^#EXT-X-MAP:.*\n/m, "")]) {
			const checks = await collectHlsReferenceChecks(
				originDeps(text),
				"test",
				manifest,
				root,
			);
			expect(checks.some((check) => check.verdict === "FAIL")).toBe(true);
		}
		const missing = await collectHlsReferenceChecks(
			originDeps(
				child("A"),
				files.filter((key) => !key.endsWith("A/headers/init.mp4")),
			),
			"test",
			manifest,
			root,
		);
		expect(
			missing.find((check) => check.id.endsWith(":objects"))?.verdict,
		).toBe("FAIL");
	});

	it("requires MP4 byte ranges and checks them against the actual complete file", async () => {
		const plan = vod();
		const source = plan.muxings[0];
		if (!source) throw new Error("missing source");
		plan.muxings[0] = {
			key: "A",
			kind: "MP4",
			streamKey: source.streamKey,
			filename: "video.mp4",
			fragmentDuration: 6,
			manifestType: "HLS_BYTE_RANGES",
			destination: source.destination,
		};
		const manifest = compileExpectedArtefacts(plan).manifests[0];
		if (!manifest) throw new Error("missing HLS");
		const root = await parseHlsText(master);
		const ranged =
			'#EXTM3U\n#EXT-X-MAP:URI="../A/video.mp4",BYTERANGE="100@0"\n#EXTINF:6,\n#EXT-X-BYTERANGE:200@100\n../A/video.mp4\n#EXTINF:6,\n#EXT-X-BYTERANGE:200@300\n../A/video.mp4\n#EXT-X-ENDLIST\n';
		const stored = [`${PREFIX}A/video.mp4`, `${PREFIX}B/video.mp4`];
		const healthy = await collectHlsReferenceChecks(
			originDeps(ranged, stored),
			"test",
			manifest,
			root,
		);
		expect(healthy.filter((check) => check.verdict === "FAIL")).toEqual([]);
		for (const text of [
			ranged.replaceAll("../A/", "../B/"),
			ranged.replace(/^#EXT-X-BYTERANGE:.*\n/gm, ""),
			ranged.replace("200@300", "200@900"),
		]) {
			const checks = await collectHlsReferenceChecks(
				originDeps(text, stored),
				"test",
				manifest,
				root,
			);
			expect(checks.some((check) => check.verdict === "FAIL")).toBe(true);
		}
	});

	for (const kind of ["VOD", "Live"] as const)
		it(`${kind} rejects B's references while both A and B are present`, async () => {
			const manifest = (
				kind === "Live"
					? compileExpectedLiveArtefacts(live()).manifests
					: compileExpectedArtefacts(vod()).manifests
			)[0];
			if (!manifest) throw new Error("missing HLS");
			const root = await parseHlsText(master);
			const healthy = await collectHlsReferenceChecks(
				originDeps(child("A")),
				"manifest:test",
				manifest,
				root,
			);
			expect(healthy.filter((check) => check.verdict === "FAIL")).toEqual([]);
			const wrong = await collectHlsReferenceChecks(
				originDeps(child("B")),
				"manifest:test",
				manifest,
				root,
			);
			expect(wrong.some((check) => check.verdict === "FAIL")).toBe(true);
			const missing = await collectHlsReferenceChecks(
				originDeps(
					child("A"),
					files.filter((key) => !key.endsWith("A/media/segment_2.m4s")),
				),
				"manifest:test",
				manifest,
				root,
			);
			expect(missing.some((check) => check.verdict === "FAIL")).toBe(true);
		});

	it("enforces the same configured writer on the delivery edge", async () => {
		const expected = compileExpectedLiveArtefacts(live());
		expect((await edgeClosure(expected, child("A", true)))?.closed).toBe(true);
		expect((await edgeClosure(expected, child("B", true)))?.closed).toBe(false);
		for (const missing of ["headers/init.mp4", "media/segment_2.m4s"])
			expect(
				(
					await edgeClosure(
						expected,
						child("A", true),
						files.filter((key) => key !== `${PREFIX}A/${missing}`),
					)
				)?.closed,
			).toBe(false);
	});
});
