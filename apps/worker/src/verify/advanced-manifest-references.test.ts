import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { parseDashText, parseHlsText } from "./adapters";
import { type EngineDeps, verifyArtefacts } from "./engine";
import {
	hlsAudioGroupChecks,
	selectedHlsAudioGroups,
} from "./manifest-reference-checks";

const URL = "https://media.example.test/subs.vtt";
const master =
	'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="ja",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f",RESOLUTION=1280x720,SUBTITLES="subs"\nvideo.m3u8\n';
const video =
	'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:12,\nvideo.m4s\n#EXT-X-ENDLIST\n';
const subtitles = `#EXTM3U\n#EXTINF:12,\n${URL}\n#EXT-X-ENDLIST\n`;

function fixture() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		),
	);
	return plan;
}

function deps(texts: Record<string, string>, objects: string[]): EngineDeps {
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
		probe: async () => ({ durationSec: 12 }),
		scanBoxes: async () => ({ psshSystemIds: [] }),
		parseHls: parseHlsText,
		parseDash: parseDashText,
	};
}

describe("external HLS subtitle references", () => {
	async function run(
		playlist: string | undefined,
		root = master,
		sourceUrl = URL,
	) {
		const plan = fixture();
		plan.qc = undefined;
		const hls = plan.manifests.find((manifest) => manifest.kind === "HLS");
		if (hls?.kind !== "HLS") throw new Error("missing HLS");
		hls.destination.path = "out/";
		delete hls.masterVersion;
		delete hls.mediaVersion;
		hls.detailed = {
			additionalMedia: [
				{
					type: "VTT",
					groupId: "subs",
					name: "Japanese",
					language: "ja",
					uri: "subs.m3u8",
					vttUrl: sourceUrl,
				},
			],
		};
		const expected = compileExpectedArtefacts(plan);
		expected.muxings = [];
		const manifest = expected.manifests.find((row) => row.kind === "HLS");
		if (!manifest) throw new Error("missing expected HLS");
		manifest.videoEntries = 1;
		manifest.audioEntries = 0;
		delete manifest.manifestRenditions;
		return verifyArtefacts(
			expected,
			deps(
				{
					[`out/${hls.manifestName}`]: root,
					"out/video.m3u8": video,
					...(playlist === undefined ? {} : { "out/subs.m3u8": playlist }),
				},
				[
					"out/init.mp4",
					"out/video.m4s",
					"out/video.m3u8",
					...(playlist === undefined ? [] : ["out/subs.m3u8"]),
				],
			),
		);
	}
	it("verifies the generated playlist and URL binding without fetching remote subtitle bytes", async () => {
		const report = await run(subtitles);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			report.checks.some(
				(check) =>
					check.id.endsWith(":external-subtitle:0:content") &&
					check.verdict === "SKIP",
			),
		).toBe(true);
		const uppercase = URL.replace("https:", "HTTPS:");
		const caseInsensitiveScheme = await run(
			subtitles.replace(URL, uppercase),
			master,
			uppercase,
		);
		expect(
			caseInsensitiveScheme.checks.filter((check) => check.verdict === "FAIL"),
		).toEqual([]);
	});
	it("rejects a wrong remote URL, wrong language, and missing generated playlist", async () => {
		for (const report of [
			await run(subtitles.replace(URL, "https://media.example.test/wrong.vtt")),
			await run(subtitles, master.replace('LANGUAGE="ja"', 'LANGUAGE="en"')),
			await run(undefined),
		]) {
			expect(report.checks.some((check) => check.verdict === "FAIL")).toBe(
				true,
			);
		}
	});
});

describe("HLS audio-group priority selection", () => {
	it("accepts only available highest-priority choices, including ties and explicit dropping modes", () => {
		const config = {
			droppingMode: "AUDIO" as const,
			groups: [
				{ name: "fallback", priority: 1 },
				{ name: "preferred", priority: 10 },
				{ name: "tied", priority: 10 },
			],
		};
		const parsed = {
			variants: [{ uri: "video.m3u8", audio: "preferred" }],
			media: ["fallback", "preferred", "tied", "unconfigured"].map(
				(groupId) => ({ type: "AUDIO", groupId }),
			),
		};
		expect(selectedHlsAudioGroups(config, parsed)).toEqual({
			groups: ["preferred"],
			dropStream: false,
		});
		for (const audio of ["preferred"])
			expect(
				hlsAudioGroupChecks("test", config, {
					...parsed,
					variants: [{ uri: "video.m3u8", audio }],
				})[0]?.verdict,
			).toBe("PASS");
		for (const audio of ["tied", "fallback", "unconfigured"])
			expect(
				hlsAudioGroupChecks("test", config, {
					...parsed,
					variants: [{ uri: "video.m3u8", audio }],
				})[0]?.verdict,
			).toBe("FAIL");
		const fallback = {
			...parsed,
			media: [{ type: "AUDIO", groupId: "fallback" }],
			variants: [{ uri: "video.m3u8", audio: "fallback" }],
		};
		expect(hlsAudioGroupChecks("test", config, fallback)[0]?.verdict).toBe(
			"PASS",
		);
		expect(
			hlsAudioGroupChecks("test", config, {
				media: [],
				variants: [{ uri: "video.m3u8" }],
			})[0]?.verdict,
		).toBe("PASS");
		expect(
			hlsAudioGroupChecks(
				"test",
				{ ...config, droppingMode: "STREAM" },
				{ media: [], variants: [] },
			)[0]?.verdict,
		).toBe("PASS");
		expect(
			hlsAudioGroupChecks(
				"test",
				{ ...config, droppingMode: "STREAM" },
				{ media: [], variants: [{ uri: "video.m3u8" }] },
			)[0]?.verdict,
		).toBe("FAIL");
	});
	it("binds the configured alternate audio group and rejects the legacy default", async () => {
		const plan = fixture();
		plan.qc = undefined;
		const rendition = plan.renditions.find((row) => row.codec === "H264");
		const audio = plan.renditions.find((row) => row.codec === "AAC");
		const hls = plan.manifests.find((row) => row.kind === "HLS");
		if (!rendition || !audio || hls?.kind !== "HLS")
			throw new Error("missing fixture tracks");
		plan.renditions = [rendition, audio];
		plan.muxings = plan.muxings.filter((muxing) =>
			[rendition.key, audio.key].includes(muxing.streamKey),
		);
		audio.hlsMedia = {
			groupId: "alternate",
			name: "Alternate",
			uri: "audio.m3u8",
		};
		hls.destination.path = "out/";
		hls.audioGroupId = "legacy";
		delete hls.masterVersion;
		delete hls.mediaVersion;
		hls.detailed = {
			streams: {
				audioGroups: {
					droppingMode: "AUDIO",
					groups: [{ name: "alternate", priority: 10 }],
				},
			},
		};
		const expected = compileExpectedArtefacts(plan);
		expected.muxings = [];
		const manifest = expected.manifests[0];
		const variant = manifest?.manifestRenditions?.hlsVariants?.[0];
		if (!manifest || !variant) throw new Error("missing expected variant");
		const content = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="alternate",NAME="Alternate",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=${variant.bitrate},CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x${variant.height},AUDIO="alternate"\n${variant.uri}\n`;
		const run = (root: string) =>
			verifyArtefacts(
				expected,
				deps(
					{
						[`out/${hls.manifestName}`]: root,
						[`out/${variant.uri}`]: video,
						"out/audio.m3u8": video,
					},
					["out/init.mp4", "out/video.m4s"],
				),
			);
		const healthy = await run(content);
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		const wrong = await run(
			content.replace('AUDIO="alternate"', 'AUDIO="legacy"'),
		);
		expect(
			wrong.checks.some(
				(check) => check.id.endsWith(":present") && check.verdict === "FAIL",
			),
		).toBe(true);
	});
});
