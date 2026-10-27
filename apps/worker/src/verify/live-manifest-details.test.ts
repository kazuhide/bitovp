import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { closureProbe } from "./edge-resolver";
import { verifyLiveChannel } from "./engine-live";
import {
	collectEdgeClosures,
	collectManifestFiles,
	type LiveRunnerDeps,
} from "./runner-live";

const REMOTE = "https://media.example.test/subs.vtt";
const ROOT = "https://edge.example.test/cmaf/live/1/ev/";
const PREFIX = "runs/one/";
const HLS =
	'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",URI="audio_128000.m3u8"\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="angles",NAME="Alternate",URI="angle.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="ja",URI="subs.m3u8"\n#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="Captions",INSTREAM-ID="CC1"\n#EXT-X-STREAM-INF:BANDWIDTH=4500000\nvideo_4500000.m3u8\n';
const CHILD = `#EXTM3U\n#EXT-X-MAP:URI="${PREFIX}video/init.mp4"\n#EXTINF:6,\n${PREFIX}video/segment_1.m4s\n`;
const VTT = `#EXTM3U\n#EXTINF:12,\n${REMOTE}\n`;
const DASH = `<MPD type="static" mediaPresentationDuration="PT12S"><Period><AdaptationSet contentType="video" codecs="avc1.640028"><Representation id="v" bandwidth="4500000"><SegmentTemplate media="${PREFIX}video/segment_$Number$.m4s" initialization="${PREFIX}video/init.mp4" duration="6"/></Representation></AdaptationSet><AdaptationSet contentType="audio" codecs="mp4a.40.2"><Representation id="a" bandwidth="128000"><SegmentTemplate media="${PREFIX}audio/segment_$Number$.m4s" initialization="${PREFIX}audio/init.mp4" duration="6"/></Representation></AdaptationSet><AdaptationSet contentType="text" mimeType="text/vtt" lang="ja"><Representation id="sub"><BaseURL>${REMOTE}</BaseURL></Representation></AdaptationSet></Period></MPD>`;

function expected(kind?: "HLS" | "DASH") {
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
	plan.muxings = plan.muxings
		.filter((muxing) => ["v1080", "a128"].includes(muxing.key))
		.map((muxing) => ({
			...muxing,
			destination: {
				outputKey: "origin",
				path: `${PREFIX}${muxing.streamKey === "v1080" ? "video" : "audio"}`,
			},
		}));
	plan.outputs.push({
		key: "mirror",
		kind: "AKAMAI_MSL",
		credentialId: "00000000-0000-4000-8000-000000000004",
		name: "Mirror",
		streamFormat: "CMAF",
		mslVersion: "MSL4",
	});
	plan.deliveryMirrors = [{ outputKey: "mirror" }];
	plan.renditions = plan.renditions.filter((rendition) =>
		["v1080", "a128"].includes(rendition.key),
	);
	for (const manifest of plan.liveManifests) {
		manifest.destination.path = "";
		if (manifest.kind === "HLS")
			manifest.detailed = {
				additionalMedia: [
					{
						type: "VIDEO",
						groupId: "angles",
						name: "Alternate",
						uri: "angle.m3u8",
						muxingKey: "v1080",
					},
					{
						type: "VTT",
						groupId: "subs",
						name: "Japanese",
						language: "ja",
						uri: "subs.m3u8",
						vttUrl: REMOTE,
					},
					{
						type: "CLOSED_CAPTIONS",
						groupId: "cc",
						name: "Captions",
						instreamId: "CC1",
						muxingKey: "v1080",
					},
				],
			};
		else
			manifest.detailed = {
				additionalRepresentations: [
					{ type: "VTT", lang: "ja", vttUrl: REMOTE },
				],
			};
	}
	const result = compileExpectedLiveArtefacts(plan);
	if (kind)
		result.manifests = result.manifests.filter(
			(manifest) => manifest.kind === kind,
		);
	result.mslEdgeOutputs = [{ outputKey: "mirror", role: "MIRROR" }];
	return result;
}

function deps(overrides: Record<string, string | undefined> = {}) {
	const texts: Record<string, string | undefined> = {
		"stream.m3u8": HLS,
		"stream.mpd": DASH,
		"subs.m3u8": VTT,
		"video_4500000.m3u8": CHILD,
		"audio_128000.m3u8": CHILD,
		"angle.m3u8": CHILD,
		...overrides,
	};
	const urls: string[] = [];
	const readText = async (_output: string, key: string) => {
		const text = texts[key];
		if (text === undefined) throw new Error("NoSuchKey");
		return text;
	};
	const result: LiveRunnerDeps = {
		api: async () => ({ status: 200, json: null }),
		readText,
		listAll: async (_output, prefix) =>
			[
				"video/init.mp4",
				"video/segment_1.m4s",
				"audio/init.mp4",
				"audio/segment_1.m4s",
			]
				.map((key) => ({ key: `${PREFIX}${key}`, size: 1000 }))
				.filter((object) => object.key.startsWith(prefix)),
		sleep: async () => {},
		now: () => 0,
		readEdge: async (url) => {
			urls.push(url);
			const key = url.slice(ROOT.length);
			const text = texts[key];
			if (text !== undefined) return { status: 200, bytes: text.length, text };
			if (key.startsWith(PREFIX))
				return { status: 200, bytes: 100, text: "media" };
			return { status: 404, bytes: 0, text: "" };
		},
	};
	return { deps: result, urls };
}

const bindings = [
	{
		outputKey: "mirror",
		credentialId: "credential",
		streamId: 1,
		eventName: "ev",
		streamFormat: "CMAF" as const,
		mslVersion: "MSL4",
		eventRoot: ROOT,
	},
];

describe("Live advanced manifest observations", () => {
	it("enforces the configured audio-group selection at both origin and edge", async () => {
		const exp = expected("HLS");
		const manifest = exp.manifests[0];
		if (!manifest) throw new Error("missing HLS");
		manifest.hlsAudioGroups = {
			droppingMode: "AUDIO",
			groups: [{ name: "audio", priority: 10 }],
		};
		const validMaster = HLS.replace(
			"BANDWIDTH=4500000",
			'BANDWIDTH=4500000,AUDIO="audio"',
		);
		const world = deps({ "stream.m3u8": validMaster });
		const files = await collectManifestFiles(world.deps, exp);
		const report = await verifyLiveChannel(exp, {
			fed: false,
			samples: [],
			coordinates: {},
			manifestFiles: files,
		});
		expect(
			report.checks.find(
				(check) => check.id === "live:manifest:hls:audio-group-selection",
			)?.verdict,
		).toBe("PASS");
		expect(
			(
				await collectEdgeClosures(
					world.deps,
					exp,
					bindings,
					{ mirror: "provider-output" },
					PREFIX,
				)
			)[0]?.closed,
		).toBe(true);
		const wrongWorld = deps({
			"stream.m3u8": validMaster.replace('AUDIO="audio"', 'AUDIO="wrong"'),
		});
		const wrongFiles = await collectManifestFiles(wrongWorld.deps, exp);
		const wrongReport = await verifyLiveChannel(exp, {
			fed: false,
			samples: [],
			coordinates: {},
			manifestFiles: wrongFiles,
		});
		expect(
			wrongReport.checks.find(
				(check) => check.id === "live:manifest:hls:audio-group-selection",
			)?.verdict,
		).toBe("FAIL");
		expect(
			(
				await collectEdgeClosures(
					wrongWorld.deps,
					exp,
					bindings,
					{ mirror: "provider-output" },
					PREFIX,
				)
			)[0]?.closed,
		).toBe(false);
	});
	it("accepts configured HLS media and DASH external text at the origin", async () => {
		const exp = expected();
		const files = await collectManifestFiles(deps().deps, exp);
		const report = await verifyLiveChannel(exp, {
			fed: false,
			samples: [],
			coordinates: {},
			manifestFiles: files,
		});
		expect(
			report.checks.filter(
				(check) =>
					check.id.startsWith("live:manifest:") && check.verdict === "FAIL",
			),
		).toEqual([]);
		expect(
			report.checks
				.filter((check) => check.id.endsWith(":external-subtitle:0:content"))
				.map((check) => check.verdict),
		).toEqual(["SKIP", "SKIP"]);
	});
	it("rejects missing HLS subtitle playlist, wrong URL/language, and wrong DASH text URL", async () => {
		for (const override of [
			{ "subs.m3u8": undefined },
			{
				"subs.m3u8": VTT.replace(
					REMOTE,
					"https://media.example.test/wrong.vtt",
				),
			},
			{ "stream.m3u8": HLS.replace('LANGUAGE="ja"', 'LANGUAGE="en"') },
			{
				"stream.mpd": DASH.replace(
					REMOTE,
					"https://media.example.test/wrong.vtt",
				),
			},
		]) {
			const exp = expected();
			const files = await collectManifestFiles(deps(override).deps, exp);
			const report = await verifyLiveChannel(exp, {
				fed: false,
				samples: [],
				coordinates: {},
				manifestFiles: files,
			});
			expect(
				report.checks.some(
					(check) =>
						check.id.startsWith("live:manifest:") && check.verdict === "FAIL",
				),
			).toBe(true);
		}
	});
	it("requires the additional video playlist and its initialization reference at the origin", async () => {
		for (const child of [undefined, CHILD.replace(/^#EXT-X-MAP:.*\n/m, "")]) {
			const exp = expected("HLS");
			const files = await collectManifestFiles(
				deps({ "angle.m3u8": child }).deps,
				exp,
			);
			const report = await verifyLiveChannel(exp, {
				fed: false,
				samples: [],
				coordinates: {},
				manifestFiles: files,
			});
			expect(
				report.checks.find(
					(check) =>
						check.id === "live:manifest:hls:additional-media:0:playlist",
				)?.verdict,
			).toBe("FAIL");
		}
	});
	it("walks every generated HLS child, excluding caption entries without a URI, without fetching remote text", async () => {
		const world = deps();
		const closures = await collectEdgeClosures(
			world.deps,
			expected("HLS"),
			bindings,
			{ mirror: "provider-output" },
			PREFIX,
		);
		expect(closures[0]?.closed).toBe(true);
		expect(closures[0]?.childCount).toBe(4);
		expect(
			closures[0]?.children?.find((child) => child.id === "subs.m3u8"),
		).toMatchObject({ externalContent: "UNVERIFIED", served: [], missing: [] });
		expect(world.urls).not.toContain(REMOTE);
		const closure = closures[0];
		if (!closure) throw new Error("missing edge closure");
		expect(
			closureProbe(closure).children.map((child) => child.id),
		).not.toContain("subs.m3u8");
		for (const override of [
			{ "subs.m3u8": undefined },
			{
				"subs.m3u8": VTT.replace(
					REMOTE,
					"https://media.example.test/wrong.vtt",
				),
			},
			{ "stream.m3u8": HLS.replace('LANGUAGE="ja"', 'LANGUAGE="en"') },
		]) {
			const broken = await collectEdgeClosures(
				deps(override).deps,
				expected("HLS"),
				bindings,
				{ mirror: "provider-output" },
				PREFIX,
			);
			expect(broken[0]?.closed).toBe(false);
		}
	});
	it("binds an external DASH representation separately from local AV closure", async () => {
		const world = deps();
		const closures = await collectEdgeClosures(
			world.deps,
			expected("DASH"),
			bindings,
			{ mirror: "provider-output" },
			PREFIX,
		);
		expect(closures[0]?.closed).toBe(true);
		expect(closures[0]?.childCount).toBe(3);
		expect(
			closures[0]?.children?.some(
				(child) => child.externalContent === "UNVERIFIED",
			),
		).toBe(true);
		expect(world.urls).not.toContain(REMOTE);
		const wrong = await collectEdgeClosures(
			deps({
				"stream.mpd": DASH.replace(
					REMOTE,
					"https://media.example.test/wrong.vtt",
				),
			}).deps,
			expected("DASH"),
			bindings,
			{ mirror: "provider-output" },
			PREFIX,
		);
		expect(wrong[0]?.closed).toBe(false);
		const duplicates = expected("DASH");
		const subtitles = duplicates.manifests[0]?.dashExternalSubtitles;
		if (!subtitles) throw new Error("missing external subtitles");
		subtitles.push({
			url: REMOTE,
			language: "ja",
		});
		const secondText =
			'<AdaptationSet contentType="text" mimeType="text/vtt" lang="ja"><Representation id="sub2"><BaseURL>https://media.example.test/wrong.vtt</BaseURL></Representation></AdaptationSet>';
		const duplicate = await collectEdgeClosures(
			deps({
				"stream.mpd": DASH.replace("</Period>", `${secondText}</Period>`),
			}).deps,
			duplicates,
			bindings,
			{ mirror: "provider-output" },
			PREFIX,
		);
		expect(duplicate[0]?.closed).toBe(false);
	});
});
