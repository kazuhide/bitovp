import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	encodingPlanSchema,
	type ManifestRenditionTopology,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { parseDashText } from "./adapters";
import type {
	BoxFacts,
	EngineDeps,
	MediaProbe,
	ObjectEntry,
	ParsedDash,
	ParsedHls,
	VerificationReport,
} from "./engine";
import {
	bindDashTopology,
	bindHlsTopology,
	ReportBuilder,
	verifyArtefacts,
} from "./engine";

/** The golden fixture directory, for tests that need a real compiled plan. */
const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);
const compileFixture = (name: string) =>
	compileExpectedArtefacts(
		encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		),
	);

/**
 * The engine's self-test: one planted defect per assertion class, each required to
 * make its OWN check fail.
 *
 * This is the rule this repo learned the hard way, applied to the thing that will be
 * trusted most. A guard that has only ever been observed passing is not evidence — an
 * earlier guard in this codebase caught one of six planted leaks and reported green,
 * and the shape it missed was the one it existed to catch. So every check below is
 * measured twice: once on a healthy world (all PASS, zero FAIL) and once with a single
 * property broken, asserting the SPECIFIC check id flipped and that the healthy checks
 * are still THERE.
 *
 * That second clause was prose only until a review pointed out that `toContain` cannot
 * see a fault which makes checks VANISH rather than fail. Implementing it found six
 * faults doing exactly that, so each now declares what it may legitimately remove.
 *
 * No Bitmovin, no bucket, no ffmpeg: the world is a map of keys to facts, injected
 * through `EngineDeps`. That seam exists for this file.
 */

// ---------------------------------------------------------------------------
// A small, honest plan: two video rungs + one audio, fMP4, one HLS + one DASH.
// ---------------------------------------------------------------------------

/** The schema demands real UUIDs; a bare "c" fails validation, correctly. */
const CRED = "11111111-1111-4111-8111-111111111111";

const BASE_PLAN = {
	planVersion: 1,
	name: "selftest",
	bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
	generation: { timing: "JUST_IN_TIME" },
	inputs: [
		{ key: "main", kind: "S3", name: "in", bucket: "in", credentialId: CRED },
	],
	outputs: [
		{
			key: "origin",
			kind: "S3",
			name: "out",
			bucket: "out",
			credentialId: CRED,
		},
	],
	ingest: [
		{
			key: "video",
			inputKey: "main",
			inputPath: "src.mov",
			position: 0,
			selectionMode: "VIDEO_RELATIVE",
		},
		{
			key: "audio",
			inputKey: "main",
			inputPath: "src.mov",
			position: 0,
			selectionMode: "AUDIO_RELATIVE",
		},
	],
	renditions: [
		{
			key: "v720",
			codec: "H264",
			ingestKey: "video",
			height: 720,
			bitrate: 2_000_000,
			rate: 24,
		},
		{
			key: "v360",
			codec: "H264",
			ingestKey: "video",
			height: 360,
			bitrate: 600_000,
			rate: 24,
		},
		{
			key: "a128",
			codec: "AAC",
			ingestKey: "audio",
			bitrate: 128_000,
			rate: 48_000,
		},
	],
	muxings: [
		{
			key: "v720",
			kind: "FMP4",
			streamKey: "v720",
			segmentLength: 4,
			destination: { outputKey: "origin", path: "out/video/720p/" },
		},
		{
			key: "v360",
			kind: "FMP4",
			streamKey: "v360",
			segmentLength: 4,
			destination: { outputKey: "origin", path: "out/video/360p/" },
		},
		{
			key: "a128",
			kind: "FMP4",
			streamKey: "a128",
			segmentLength: 4,
			destination: { outputKey: "origin", path: "out/audio/128000/" },
		},
	],
	manifests: [
		{
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			masterVersion: "HLS_V4",
			destination: { outputKey: "origin", path: "out/" },
		},
		{
			key: "dash",
			kind: "DASH",
			manifestName: "stream.mpd",
			representationType: "TIMELINE",
			destination: { outputKey: "origin", path: "out/" },
		},
	],
} as const;

const REFERENCE = { durationSec: 12, fps: 24, nbFrames: 288 };

describe("CMAF init-name verification", () => {
	it.each([
		false,
		true,
	])("resolves the actual template name without accepting ambiguous init objects (%s)", async (ambiguous) => {
		const plan = encodingPlanSchema.parse({
			...BASE_PLAN,
			muxings: BASE_PLAN.muxings.map((m) => ({
				...m,
				kind: "CMAF",
				initSegmentNameTemplate: "init-{rand_chars:8}.mp4",
			})),
			manifests: BASE_PLAN.manifests
				.filter((m) => m.kind === "DASH")
				.map((m) => ({
					...m,
					videoMuxingKind: "CMAF",
					audioMuxingKind: "CMAF",
				})),
		});
		const expected = compileExpectedArtefacts(plan);
		const world = healthyWorld();
		world.objects = world.objects.map((key) =>
			key.replace("init.mp4", "init-Ab12Cd34.mp4"),
		);
		world.probes = Object.fromEntries(
			Object.entries(world.probes).map(([key, value]) => [
				key.replace("init.mp4", "init-Ab12Cd34.mp4"),
				value,
			]),
		);
		world.texts["out/stream.mpd"] = MPD_TIMELINE.replaceAll(
			"init.mp4",
			"init-Ab12Cd34.mp4",
		);
		if (ambiguous) world.objects.push("out/video/720p/init-Ef56Gh78.mp4");
		const report = await verifyArtefacts(expected, depsFor(world));
		expect(
			report.checks.find((check) => check.id === "muxing:v720:init")?.verdict,
		).toBe(ambiguous ? "FAIL" : "PASS");
		if (!ambiguous)
			expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
				[],
			);
	});
});

/** The healthy world: every artefact present and correct. */
type World = {
	objects: string[];
	probes: Record<string, MediaProbe>;
	texts: Record<string, string>;
	boxes?: Record<string, BoxFacts>;
	/** Per-object sizes; absent = 1024 . */
	sizes?: Record<string, number>;
	/** Keys the engine's foreign-object filter rejects (review-343 H1's foreign arm). */
	foreign?: string[];
};

/**
 * The master as the COMPILER names it (row 284): a variant's URI is
 * `video_<bitrate>.m3u8` and its AUDIO names the manifest group; the media
 * entry's URI is `audio_<bitrate>.m3u8`. Those are the values our StreamInfo /
 * AudioMedia ops carry and the master hands back verbatim, so the one-to-one
 * binding uses them as the row's identity — a hand-named master no longer
 * binds, which is the point.
 */
const HLS_MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="audio"
video_2000000.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,AUDIO="audio"
video_600000.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"
`;

/**
 * What a healthy fMP4 media playlist looks like — EXT-X-MAP for the init
 * segment, closed for VOD. The engine now WALKS every child the master
 * references ; before, the master was the only file it read.
 * The child sits beside the master (`out/video_2000000.m3u8`) and names its
 * segments by the muxing's path relative to it, as the compiler's
 * `segmentPath` does.
 */
const hlsChild = (dir: string) => `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="${dir}init.mp4"
#EXTINF:4.000,
${dir}segment_1.m4s
#EXTINF:4.000,
${dir}segment_2.m4s
#EXTINF:4.000,
${dir}segment_3.m4s
#EXT-X-ENDLIST
`;
const HLS_CHILD_720 = hlsChild("video/720p/");
const HLS_CHILD_360 = hlsChild("video/360p/");
const HLS_CHILD_AUDIO = hlsChild("audio/128000/");

const MPD_TIMELINE = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT12S"><Period>
  <AdaptationSet><Representation id="v720" height="720"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet><Representation id="v360" height="360"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet><Representation id="a128"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
</Period></MPD>
`;

function healthyWorld(): World {
	const objects: string[] = [];
	const probes: Record<string, MediaProbe> = {};
	for (const [dir, height, bitrate] of [
		["out/video/720p/", 720, 2_000_000],
		["out/video/360p/", 360, 600_000],
	] as const) {
		objects.push(`${dir}init.mp4`);
		/**
		 * An init segment reports geometry and codec — from the sample ENTRY — and no fps and
		 * no bitrate, because it has no samples. That is deliberately modelled: the engine used
		 * to probe ONLY the init segment, so `fps` and `bitrate` were structurally unverifiable
		 * for every segmented muxing, and the first real run surfaced it from the other side by
		 * reporting `fps 25 — 25000`, a track timescale read off an init segment.
		 */
		probes[`${dir}init.mp4`] = {
			height,
			videoCodec: "h264",
		};
		// 12s / 4s = 3 segments. A real segment HAS frames, so it carries fps and bitrate.
		for (let n = 1; n <= 3; n++) {
			objects.push(`${dir}segment_${n}.m4s`);
			probes[`${dir}segment_${n}.m4s`] = {
				// FRAMES only: geometry and codec live in the init's `moov`, and a segment
				// that restated them would MASK a planted wrong height, since the engine
				// probes `init + segment` as one file. Four fault tests caught exactly that.
				fps: 24,
				bitrateBps: bitrate,
			};
		}
	}
	objects.push("out/audio/128000/init.mp4");
	probes["out/audio/128000/init.mp4"] = {
		audioCodec: "aac",
		audioSampleRate: 48_000,
	};
	for (let n = 1; n <= 3; n++) {
		objects.push(`out/audio/128000/segment_${n}.m4s`);
		probes[`out/audio/128000/segment_${n}.m4s`] = {};
	}
	objects.push(
		"out/stream.m3u8",
		"out/stream.mpd",
		"out/video_2000000.m3u8",
		"out/video_600000.m3u8",
		"out/audio_128000.m3u8",
	);
	return {
		objects,
		probes,
		texts: {
			"out/stream.m3u8": HLS_MASTER,
			"out/stream.mpd": MPD_TIMELINE,
			"out/video_2000000.m3u8": HLS_CHILD_720,
			"out/video_600000.m3u8": HLS_CHILD_360,
			"out/audio_128000.m3u8": HLS_CHILD_AUDIO,
		},
	};
}

/** Deps over a `World`; the parsers are the real shape, hand-rolled for the test. */
function depsFor(world: World): EngineDeps {
	return {
		...(world.foreign
			? {
					foreignKeyFilter: (key: string) =>
						world.foreign?.includes(key) === true,
				}
			: {}),
		listAll: async (
			_outputKey: string,
			prefix: string,
		): Promise<ObjectEntry[]> =>
			world.objects
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({ key: k, size: world.sizes?.[k] ?? 1024 })),
		fetchObject: async (_outputKey: string, key: string) => key,
		/**
		 * Faithful to the format: the path is the whole assembly, joined.
		 *
		 * `probe` below then refuses a bare `.m4s`, exactly as ffprobe does, so a regression to
		 * probing a media segment without its init FAILS here instead of on a real corpus.
		 */
		fetchConcatenated: async (_outputKey: string, keys: string[]) =>
			keys.length > 1 ? keys.join("+") : (keys[0] ?? ""),
		probe: async (path: string) => {
			/**
			 * A bare fMP4 media segment is not parseable, and this fake says so.
			 *
			 * `moof`+`mdat` with no `moov`: real ffprobe answers `Invalid data found when
			 * processing input`. The previous fake returned `world.probes[key] ?? {}` for any
			 * path at all, so it happily "probed" a bare segment — and 19 scenarios FAILed on
			 * the first real corpus run for a reason no test could see.
			 */
			if (/\.m4s$/.test(path) && !path.includes("+")) {
				throw new Error(
					`${path}: Invalid data found when processing input (a bare fMP4 segment needs its init segment prepended)`,
				);
			}
			const declared = world.probes[path];
			if (declared !== undefined) {
				return declared;
			}
			/**
			 * An assembled path answers with the union of its parts, later winning.
			 *
			 * This is the truth about fMP4, not a convenience: `height`, the codec and the
			 * sample rate live in the init segment's `moov`, while frame count, fps and bitrate
			 * come from the media segment's frames. ffprobe on `init + segment` reports both,
			 * so a fake that returned only the segment's facts would make a planted wrong
			 * height in an init invisible — which is precisely what four fault-injection tests
			 * caught when this fake first ignored the init half.
			 */
			const parts = path.split("+");
			let merged: MediaProbe = {};
			for (const part of parts) {
				merged = { ...merged, ...(world.probes[part] ?? {}) };
			}
			return merged;
		},
		scanBoxes: async (path: string) =>
			world.boxes?.[path] ?? { psshSystemIds: [] },
		readText: async (_outputKey: string, key: string) => {
			const text = world.texts[key];
			if (text === undefined) {
				throw new Error(`no such object: ${key}`);
			}
			return text;
		},
		parseHls: async (text: string): Promise<ParsedHls> => {
			// Mirrors the real adapter's fields the topology binding reads (row
			// 272): RESOLUTION/CODECS/BANDWIDTH on variants, GROUP-ID/NAME on media.
			const variants = [
				...text.matchAll(/#EXT-X-STREAM-INF:([^\n]*)\n([^\n]+)/g),
			].map((m) => {
				const attrs = m[1] as string;
				const bw = /BANDWIDTH=(\d+)/.exec(attrs);
				const res = /RESOLUTION=(\d+x\d+)/.exec(attrs);
				const codecs = /CODECS="([^"]+)"/.exec(attrs);
				// AUDIO is the row's identity beside its URI (row 284), as the real
				// adapter reads it — an empty AUDIO="" is still a declared value.
				const audio = /(?:^|,)AUDIO="([^"]*)"/.exec(attrs);
				return {
					uri: (m[2] as string).trim(),
					...(bw ? { bandwidth: Number(bw[1]) } : {}),
					...(res ? { resolution: res[1] as string } : {}),
					...(codecs ? { codecs: codecs[1] as string } : {}),
					...(audio ? { audio: audio[1] as string } : {}),
				};
			});
			const media = [...text.matchAll(/#EXT-X-MEDIA:([^\n]*)/g)].map((m) => {
				const attrs = m[1] as string;
				const type = /TYPE=(\w+)/.exec(attrs);
				const groupId = /GROUP-ID="([^"]+)"/.exec(attrs);
				const name = /NAME="([^"]+)"/.exec(attrs);
				const uri = /URI="([^"]+)"/.exec(attrs);
				return {
					type: (type?.[1] ?? "") as string,
					...(groupId ? { groupId: groupId[1] as string } : {}),
					...(name ? { name: name[1] as string } : {}),
					...(uri ? { uri: uri[1] as string } : {}),
				};
			});
			const v = /#EXT-X-VERSION:(\d+)/.exec(text);
			const segments = (text.match(/#EXTINF:/g) ?? []).length;
			// Mirrors the real adapter : the URIs a media playlist
			// names, in order, and its EXT-X-MAP.
			const segmentUris = [...text.matchAll(/#EXTINF:[^\n]*\n([^\n#]+)/g)].map(
				(m) => (m[1] as string).trim(),
			);
			const mapUri = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
			return {
				variants,
				media,
				segments,
				...(segments > 0 ? { segmentUris, ...(mapUri ? { mapUri } : {}) } : {}),
				...(v ? { version: Number(v[1]) } : {}),
			};
		},
		parseDash: async (text: string): Promise<ParsedDash> => {
			const representations = [
				...text.matchAll(/<Representation\b[^>]*>/g),
			].map((m, i) => {
				const after = text.slice(
					(m.index as number) + m[0].length,
					(m.index as number) + m[0].length + 400,
				);
				const addressing = /<SegmentTimeline/.test(after)
					? ("TIMELINE" as const)
					: /<SegmentTemplate/.test(after)
						? ("TEMPLATE" as const)
						: /<SegmentBase|<BaseURL/.test(after)
							? ("BASE" as const)
							: ("UNKNOWN" as const);
				// The real adapter classifies by contentType/mimeType/geometry;
				// this fake's MPDs carry only `height`, so geometry is the rule.
				const kind = /unclassified="1"/.test(m[0])
					? ("unknown" as const)
					: /height="/.test(m[0])
						? ("video" as const)
						: ("audio" as const);
				// height/bandwidth/codecs bind a representation to its rendition (row 272).
				const h = /height="(\d+)"/.exec(m[0]);
				const bw = /bandwidth="(\d+)"/.exec(m[0]);
				const codecs = /codecs="([^"]+)"/.exec(m[0]);
				return {
					id: String(i),
					addressing,
					kind,
					...(h ? { height: Number(h[1]) } : {}),
					...(bw ? { bandwidth: Number(bw[1]) } : {}),
					...(codecs ? { codecs: codecs[1] as string } : {}),
				};
			});
			// AdaptationSet codec topology (row 272): the codecs each set declares.
			const adaptationSets = [
				...text.matchAll(
					/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g,
				),
			].map((m) => {
				const attrs = m[1] ?? "";
				const body = m[2] ?? "";
				const ct = /contentType="(video|audio|text)"/.exec(attrs);
				const kind = ct
					? (ct[1] as "video" | "audio" | "text")
					: /height="/.test(attrs + body)
						? ("video" as const)
						: ("audio" as const);
				const codecs = [
					...new Set(
						[...(attrs + body).matchAll(/codecs="([^"]+)"/g)].map(
							(c) => c[1] as string,
						),
					),
				].sort();
				return { kind, codecs };
			});
			return {
				representations,
				periods: (text.match(/<Period\b/g) ?? []).length,
				...(adaptationSets.length > 0 ? { adaptationSets } : {}),
			};
		},
		reference: REFERENCE,
	};
}

// Parsed, not cast: `encodingPlanSchema` applies the `.default([])`s (drm, thumbnails,
// sprites…) that a bare object literal lacks, so the compiler sees exactly the shape
// production hands it. Casting instead threw `plan.drm is not iterable`.
const expected = compileExpectedArtefacts(encodingPlanSchema.parse(BASE_PLAN));

const failedIds = (report: VerificationReport): string[] =>
	report.checks.filter((c) => c.verdict === "FAIL").map((c) => c.id);

describe("verification engine — the healthy control", () => {
	it("finds zero faults when every artefact is right", async () => {
		const report = await verifyArtefacts(expected, depsFor(healthyWorld()));
		// The control matters as much as the faults: a scan that fails on a correct
		// world is not usable, and one that passes everything proves nothing.
		expect(failedIds(report)).toEqual([]);
		expect(report.counts.PASS).toBeGreaterThan(10);
	});

	it("actually asserted the things it claims to", async () => {
		const report = await verifyArtefacts(expected, depsFor(healthyWorld()));
		const ids = report.checks.map((c) => c.id);
		// If the id set silently shrinks, checks were dropped while the suite stayed
		// green — the failure mode that makes a verifier worthless.
		for (const needed of [
			"muxing:v720:init",
			"muxing:v720:segments",
			"muxing:v720:segment-count",
			"rendition:v720:height",
			"rendition:v720:codec",
			"rendition:v720:fps",
			"rendition:a128:audio-present",
			"rendition:a128:audio-rate",
			"manifest:hls:parse",
			"manifest:hls:variants",
			"manifest:hls:version",
			"manifest:dash:parse",
			"manifest:dash:representations",
			"manifest:dash:addressing",
		]) {
			expect(ids, `missing check: ${needed}`).toContain(needed);
		}
	});
});

/**
 * Each case names the check that MUST flip, so a defect caught by the wrong check
 * (or by a blanket failure) does not count as coverage.
 */
const FAULTS: {
	name: string;
	expectFail: string;
	break: (w: World) => void;
	/**
	 * Check-id prefixes this fault may legitimately remove, because they are downstream
	 * of what it breaks (no init segment ⇒ nothing to probe). Declared, never inferred:
	 * an UNDECLARED disappearance is exactly what `toContain` cannot see, and six faults
	 * were doing it.
	 */
	mayVanish?: string[];
}[] = [
	{
		name: "a rendition encoded at the wrong height",
		expectFail: "rendition:v720:height",
		break: (w) => {
			(w.probes["out/video/720p/init.mp4"] as MediaProbe).height = 540;
		},
	},
	{
		name: "a rendition encoded with the wrong codec",
		expectFail: "rendition:v720:codec",
		break: (w) => {
			(w.probes["out/video/720p/init.mp4"] as MediaProbe).videoCodec = "hevc";
		},
	},
	{
		name: "a rendition at the wrong frame rate",
		expectFail: "rendition:v360:fps",
		break: (w) => {
			// The SEGMENT, not the init: an init segment has no frames, so fps is read from a
			// segment now. Planting it on the init would break nothing, which is what the
			// first real run's `fps 25 — 25000` was telling us from the other direction.
			(w.probes["out/video/360p/segment_1.m4s"] as MediaProbe).fps = 30;
		},
	},
	{
		name: "a missing init segment",
		expectFail: "muxing:v360:init",
		// no init segment means nothing to probe, so the three rendition checks for that leg cannot run.
		mayVanish: ["rendition:v360:"],
		break: (w) => {
			w.objects = w.objects.filter((k) => k !== "out/video/360p/init.mp4");
		},
	},
	{
		name: "a truncated ladder — one segment short",
		expectFail: "muxing:v720:segment-count",
		break: (w) => {
			w.objects = w.objects.filter((k) => k !== "out/video/720p/segment_3.m4s");
		},
	},
	{
		// The other side of the asymmetric band: one EXTRA trailing segment is normal
		// (a flushed short fragment) and must NOT be reported as a defect.
		name: "one extra trailing segment is tolerated, not failed",
		expectFail: "",
		break: (w) => {
			w.objects.push("out/video/720p/segment_4.m4s");
		},
	},
	{
		name: "no segments at all for one rung",
		expectFail: "muxing:v360:segments",
		// counting segments against a duration is meaningless when there are none.
		// A prefix with no segments has no bytes to weigh either.
		mayVanish: [
			"muxing:v360:segment-count",
			"muxing:v360:segment-bytes",
			// No segment to probe means no frame-level facts to read from one.
			"rendition:v360:bitrate",
			"rendition:v360:fps",
		],
		break: (w) => {
			w.objects = w.objects.filter(
				(k) => !/out\/video\/360p\/segment_/.test(k),
			);
		},
	},
	{
		name: "the audio rung lost its audio stream",
		expectFail: "rendition:a128:audio-present",
		// there is no sample rate to check on a stream that is not there.
		mayVanish: ["rendition:a128:audio-rate"],
		break: (w) => {
			w.probes["out/audio/128000/init.mp4"] = { videoAbsent: true };
		},
	},
	{
		name: "audio resampled away from the plan's rate",
		expectFail: "rendition:a128:audio-rate",
		break: (w) => {
			(w.probes["out/audio/128000/init.mp4"] as MediaProbe).audioSampleRate =
				44_100;
		},
	},
	{
		name: "the HLS master lost a variant",
		expectFail: "manifest:hls:variants",
		// The lost variant's child is no longer referenced, so its walk checks
		// legitimately vanish — declared, so any OTHER disappearance still fires.
		mayVanish: ["manifest:hls:child:video_600000-m3u8"],
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				/#EXT-X-STREAM-INF:BANDWIDTH=600000[^\n]*\n[^\n]*\n/,
				"",
			);
		},
	},
	/*
	 * every one of these shapes was
	 * observed on a REAL master or MPD and passed the verifier as it stood.
	 */
	{
		name: "the master references no readable child at all (every URI absolute — review-325)",
		expectFail: "manifest:hls:children-referenced",
		// Every child check vanishes with the children — declared.
		mayVanish: ["manifest:hls:child:"],
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				/^(video|audio)_/gm,
				"https://cdn.example/$1_",
			).replace(/URI="audio_/g, 'URI="https://cdn.example/audio_');
		},
	},
	{
		name: "two EXT-X-MEDIA entries share a NAME in one group (VOD case 1, Live A/B/E, MSL4 M2)",
		expectFail: "manifest:hls:media-names-unique",
		// The parser keys renditions by NAME, so the parsed media count also
		// stays 1 while the raw-line count reads 2 — both checks fire.
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"`,
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_64000.m3u8"`,
			);
			w.texts["out/audio_64000.m3u8"] = hlsChild("audio/64000/");
		},
	},
	{
		name: "the audio media COUNT is wrong even though the parser collapsed the duplicate",
		expectFail: "manifest:hls:audio-media-count",
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"`,
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_64000.m3u8"`,
			);
			w.texts["out/audio_64000.m3u8"] = hlsChild("audio/64000/");
		},
	},
	{
		name: 'a variant carries AUDIO="" (VOD cases 3/4)',
		expectFail: "manifest:hls:variant-audio-groups",
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="audio"',
				'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO=""',
			);
		},
	},
	{
		name: "a variant names an audio group that no EXT-X-MEDIA declares",
		expectFail: "manifest:hls:variant-audio-groups",
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="audio"',
				'#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="ghost"',
			);
		},
	},
	{
		name: "an EXT-X-MEDIA entry has no NAME at all",
		expectFail: "manifest:hls:media-named",
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				',NAME="HLS Audio Media"',
				"",
			);
		},
	},
	{
		name: "a referenced child playlist does not exist (MSL4 M2/M3: master advanced, children 404)",
		expectFail: "manifest:hls:child:video_600000-m3u8",
		mayVanish: ["manifest:hls:child:video_600000-m3u8:"],
		break: (w) => {
			delete w.texts["out/video_600000.m3u8"];
		},
	},
	{
		name: "a child playlist never closes",
		expectFail: "manifest:hls:child:video_600000-m3u8:endlist",
		break: (w) => {
			w.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
				"#EXT-X-ENDLIST\n",
				"",
			);
		},
	},
	{
		name: "a child playlist lists no segments",
		expectFail: "manifest:hls:child:video_600000-m3u8:segments",
		break: (w) => {
			w.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
				/#EXTINF:[^\n]*\n[^\n]*\n/g,
				"",
			);
		},
	},
	{
		name: "an fMP4 child playlist has no EXT-X-MAP",
		expectFail: "manifest:hls:child:video_600000-m3u8:map",
		break: (w) => {
			w.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
				'#EXT-X-MAP:URI="video/360p/init.mp4"\n',
				"",
			);
		},
	},
	{
		name: "the MPD is audio-only beside expected video (VOD case 8)",
		expectFail: "manifest:dash:video-representations",
		break: (w) => {
			w.texts["out/stream.mpd"] = MPD_TIMELINE.replace(
				/<AdaptationSet><Representation id="v720"[\s\S]*?<\/AdaptationSet>\n\s*<AdaptationSet><Representation id="v360"[\s\S]*?<\/AdaptationSet>\n/,
				"",
			);
		},
	},
	{
		name: "the MPD carries an extra audio representation — the total-only check would have passed the wrong mix",
		expectFail: "manifest:dash:audio-representations",
		// One video set removed, one audio set added: the TOTAL is unchanged.
		break: (w) => {
			w.texts["out/stream.mpd"] = MPD_TIMELINE.replace(
				/<AdaptationSet><Representation id="v360"[\s\S]*?<\/AdaptationSet>\n/,
				`<AdaptationSet><Representation id="a64"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>\n`,
			);
		},
	},
	{
		name: "the HLS version is not the one the plan pinned",
		expectFail: "manifest:hls:version",
		break: (w) => {
			w.texts["out/stream.m3u8"] = HLS_MASTER.replace(
				"#EXT-X-VERSION:4",
				"#EXT-X-VERSION:6",
			);
		},
	},
	{
		name: "a real HLS parser rejects the master",
		expectFail: "manifest:hls:parse",
		// an unparseable master yields no variants and no version to compare.
		mayVanish: ["manifest:hls:"],
		break: (w) => {
			w.texts["out/stream.m3u8"] = "not a playlist at all";
		},
	},
	{
		name: "TIMELINE addressing silently became TEMPLATE",
		expectFail: "manifest:dash:addressing",
		break: (w) => {
			w.texts["out/stream.mpd"] = MPD_TIMELINE.replace(
				/<SegmentTimeline><S d="4" r="2"\/><\/SegmentTimeline>/g,
				"",
			);
		},
	},
	{
		name: "the MPD lost a representation",
		expectFail: "manifest:dash:representations",
		break: (w) => {
			w.texts["out/stream.mpd"] = MPD_TIMELINE.replace(
				/<AdaptationSet><Representation id="a128">[\s\S]*?<\/AdaptationSet>/,
				"",
			);
		},
	},
	{
		name: "a manifest the plan promised is simply absent",
		expectFail: "manifest:dash",
		// An absent file cannot be read, parsed or counted; the single `manifest:dash`
		// FAIL replaces the four checks it would otherwise have produced.
		mayVanish: ["manifest:dash:"],
		break: (w) => {
			delete w.texts["out/stream.mpd"];
			w.objects = w.objects.filter((k) => k !== "out/stream.mpd");
		},
	},
	{
		name: "a whole muxing prefix is empty",
		expectFail: "muxing:a128",
		// An empty prefix is one FAIL for the whole leg — every downstream check for that
		// muxing and its rendition necessarily goes with it.
		mayVanish: ["muxing:a128:", "rendition:a128:"],
		break: (w) => {
			w.objects = w.objects.filter((k) => !k.startsWith("out/audio/"));
		},
	},
];

const CLOSURE_FAULTS: typeof FAULTS = [
	{
		name: "a child playlist references a segment the bucket does not hold (re-audit BLOCKER-4)",
		expectFail: "manifest:hls:child:video_600000-m3u8:media-closure",
		mayVanish: ["manifest:hls:child:video_600000-m3u8:media-decodes"],
		break: (w) => {
			w.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
				"segment_3.m4s",
				"segment_4.m4s",
			);
		},
	},
	{
		name: "a referenced segment exists but is EMPTY",
		expectFail: "manifest:hls:child:video_600000-m3u8:media-closure",
		mayVanish: ["manifest:hls:child:video_600000-m3u8:media-decodes"],
		break: (w) => {
			w.sizes = { "out/video/360p/segment_2.m4s": 0 };
		},
	},
	{
		name: "the referenced init is missing while the segments exist",
		expectFail: "manifest:hls:child:video_600000-m3u8:media-closure",
		mayVanish: [
			"manifest:hls:child:video_600000-m3u8:media-decodes",
			"rendition:v360",
			"muxing:m360",
		],
		break: (w) => {
			w.objects = w.objects.filter((k) => k !== "out/video/360p/init.mp4");
		},
	},
	{
		name: "the ordered assembly of a child's references does not decode",
		expectFail: "manifest:hls:child:video_600000-m3u8:media-decodes",
		mayVanish: ["rendition:v360"],
		break: (w) => {
			for (let n = 1; n <= 3; n++) {
				w.probes[`out/video/360p/segment_${n}.m4s`] = {};
			}
		},
	},
	{
		name: "a referenced segment is FOREIGN — listed and non-empty, but older than the job / outside the declared population (review-343 H1)",
		expectFail: "manifest:hls:child:video_600000-m3u8:media-closure",
		mayVanish: [
			"manifest:hls:child:video_600000-m3u8:media-decodes",
			"rendition:v360",
			"muxing:m360",
		],
		break: (w) => {
			w.foreign = ["out/video/360p/segment_2.m4s"];
		},
	},
];

describe("verification engine — every check is observed failing", () => {
	for (const fault of [...FAULTS, ...CLOSURE_FAULTS]) {
		it(`catches: ${fault.name}`, async () => {
			const world = healthyWorld();
			fault.break(world);
			const report = await verifyArtefacts(expected, depsFor(world));
			const failed = failedIds(report);
			if (fault.expectFail === "") {
				// A tolerated deviation: the point is that it does NOT fail.
				expect(
					failed,
					`"${fault.name}" must stay green; failures were [${failed.join(", ")}]`,
				).toEqual([]);
				return;
			}
			expect(
				failed,
				`planting "${fault.name}" must fail ${fault.expectFail}; failures were [${failed.join(", ")}]`,
			).toContain(fault.expectFail);

			// The second half of the claim, which used to be prose only: the healthy checks
			// must still be THERE. `toContain` cannot see a fault that makes checks VANISH —
			// an early return, or a missing init segment silently dropping the three
			// `rendition:*` checks — so a fault could satisfy the assertion above while
			// quietly deleting half the report (review catch).
			//
			// A fault legitimately removes what is DOWNSTREAM of what it broke, so the
			// allowance is declared per fault rather than inferred; an undeclared
			// disappearance is the thing being caught.
			const control = await verifyArtefacts(expected, depsFor(healthyWorld()));
			const present = new Set(report.checks.map((c) => c.id));
			const vanished = control.checks
				.filter((c) => c.verdict === "PASS")
				.map((c) => c.id)
				.filter((id) => !present.has(id));
			const allowed = (fault as { mayVanish?: string[] }).mayVanish ?? [];
			expect(
				vanished.filter((id) => !allowed.some((p) => id.startsWith(p))),
				`planting "${fault.name}" made undeclared checks disappear: [${vanished.join(", ")}]`,
			).toEqual([]);
		});
	}

	it("plants nothing and stays green — the same code path, so the faults mean something", async () => {
		const report = await verifyArtefacts(expected, depsFor(healthyWorld()));
		expect(failedIds(report)).toEqual([]);
	});
});

describe("verification engine — DRM box assertions", () => {
	/** A CENC plan whose muxing writes through the DRM row's own destination. */
	const drmPlan = {
		...BASE_PLAN,
		renditions: [BASE_PLAN.renditions[0]],
		muxings: [
			{
				key: "v720",
				kind: "FMP4",
				streamKey: "v720",
				segmentLength: 4,
			},
		],
		manifests: [],
		drm: [
			{
				key: "v720-cenc",
				kind: "CENC",
				muxingKey: "v720",
				credentialId: CRED,
				kid: "43214321432143214321432143214321",
				encryptionMode: "CTR",
				destination: { outputKey: "origin", path: "out/video/720p/" },
			},
		],
	};
	const drmExpected = compileExpectedArtefacts(
		encodingPlanSchema.parse(drmPlan),
	);

	function drmWorld(): World {
		return {
			// 12s reference / 4s segments = 3 segments. The first version of this world
			// had one, and the control failed on segment-count — the world's fault, not
			// the engine's, but exactly the kind of thing a green-only test hides.
			objects: [
				"out/video/720p/init.mp4",
				"out/video/720p/segment_1.m4s",
				"out/video/720p/segment_2.m4s",
				"out/video/720p/segment_3.m4s",
			],
			probes: {
				// The init segment carries geometry and codec, never fps — see `healthyWorld`.
				"out/video/720p/init.mp4": { height: 720, videoCodec: "h264" },
				"out/video/720p/segment_1.m4s": {
					height: 720,
					videoCodec: "h264",
					fps: 24,
					bitrateBps: 2_000_000,
				},
			},
			texts: {},
			boxes: {
				"out/video/720p/init.mp4": {
					psshSystemIds: ["edef8ba979d64acea3c827dcd51d21ed"],
					schemeType: "cenc",
					ivSizeBytes: 8,
					defaultKid: "43214321432143214321432143214321",
				},
			},
		};
	}

	it("passes on a correctly encrypted init segment", async () => {
		const report = await verifyArtefacts(drmExpected, depsFor(drmWorld()));
		expect(failedIds(report)).toEqual([]);
	});

	/** The init segment's boxes, or a loud failure — strict mode, no `!`. */
	const boxesOf = (w: World): BoxFacts => {
		const boxes = w.boxes?.["out/video/720p/init.mp4"];
		if (!boxes) {
			throw new Error("the DRM world must define boxes for the init segment");
		}
		return boxes;
	};

	const DRM_FAULTS: {
		name: string;
		expectFail: string;
		break: (w: World) => void;
	}[] = [
		{
			name: "pssh stripped from the init segment",
			expectFail: "drm:v720-cenc:pssh",
			break: (w) => {
				boxesOf(w).psshSystemIds = [];
			},
		},
		{
			name: "C9 violated — CTR with a 16-byte IV",
			expectFail: "drm:v720-cenc:iv",
			break: (w) => {
				boxesOf(w).ivSizeBytes = 16;
			},
		},
		{
			name: "the scheme is cbcs where the plan said CTR/cenc",
			expectFail: "drm:v720-cenc:schm",
			break: (w) => {
				boxesOf(w).schemeType = "cbcs";
			},
		},
		{
			name: "a different key id than the plan's",
			expectFail: "drm:v720-cenc:kid",
			break: (w) => {
				boxesOf(w).defaultKid = "00000000000000000000000000000000";
			},
		},
		{
			name: "the encrypted init segment is missing entirely",
			expectFail: "drm:v720-cenc:init",
			break: (w) => {
				w.objects = w.objects.filter((k) => !k.endsWith("init.mp4"));
			},
		},
	];

	for (const fault of DRM_FAULTS) {
		it(`catches: ${fault.name}`, async () => {
			const world = drmWorld();
			fault.break(world);
			const report = await verifyArtefacts(drmExpected, depsFor(world));
			expect(failedIds(report), fault.name).toContain(fault.expectFail);
		});
	}
});

describe("verification engine — cross-scenario safety", () => {
	it("fails when one scenario's artefacts are checked against another's expectations", async () => {
		// The bluntest possible sanity check on the whole design: expectations and
		// artefacts must be coupled. If this passes, the engine is not really looking.
		const otherPlan = {
			...BASE_PLAN,
			name: "other",
			muxings: [
				{
					key: "v1080",
					kind: "FMP4",
					streamKey: "v720",
					segmentLength: 4,
					destination: { outputKey: "origin", path: "somewhere/else/1080p/" },
				},
			],
			manifests: [],
		};
		const report = await verifyArtefacts(
			compileExpectedArtefacts(encodingPlanSchema.parse(otherPlan)),
			depsFor(healthyWorld()),
		);
		expect(report.failed).toBeGreaterThan(0);
	});
});

describe("child playlist versions (ledger #207)", () => {
	it("a pinned media version is checked on every CHILD, not the master", async () => {
		// Paid cases 1/5: the master said what the plan pinned while the media
		// playlists said EXT-X-VERSION:4 beside EXT-X-MAP. The old engine read
		// only the master.
		const plan = structuredClone(BASE_PLAN) as Record<string, unknown>;
		const manifests = plan.manifests as Record<string, unknown>[];
		const hls = manifests.find((m) => m.kind === "HLS");
		if (!hls) {
			throw new Error("BASE_PLAN has no HLS manifest");
		}
		hls.mediaVersion = "HLS_V6";
		const pinned = compileExpectedArtefacts(encodingPlanSchema.parse(plan));
		const world = healthyWorld();
		world.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
			"#EXT-X-VERSION:6",
			"#EXT-X-VERSION:4",
		);
		const report = await verifyArtefacts(pinned, depsFor(world));
		expect(failedIds(report)).toContain(
			"manifest:hls:child:video_600000-m3u8:version",
		);
	});

	it("EXT-X-MAP below version 6 is a WARN even with no pin — the vendor's own default", async () => {
		const world = healthyWorld();
		world.texts["out/video_600000.m3u8"] = HLS_CHILD_360.replace(
			"#EXT-X-VERSION:6",
			"#EXT-X-VERSION:4",
		);
		const report = await verifyArtefacts(expected, depsFor(world));
		const warn = report.checks.find(
			(c) => c.id === "manifest:hls:child:video_600000-m3u8:map-version",
		);
		expect(warn?.verdict).toBe("WARN");
		expect(failedIds(report)).toEqual([]);
	});
});

describe("DASH representations the adapter cannot classify (review-325)", () => {
	it("WARN, by name — never folded into video or audio", async () => {
		const world = healthyWorld();
		world.texts["out/stream.mpd"] = MPD_TIMELINE.replace(
			"</Period>",
			`<AdaptationSet><Representation id="x" unclassified="1"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>\n</Period>`,
		);
		const report = await verifyArtefacts(expected, depsFor(world));
		const warn = report.checks.find(
			(c) => c.id === "manifest:dash:unclassified-representations",
		);
		expect(warn?.verdict).toBe("WARN");
		expect(warn?.detail).toMatch(/^1 representation/);
	});
});

describe("DASH media-byte closure over the parser's resolved playlists (re-audit BLOCKER-4, ledger #229)", () => {
	const withPlaylists = (
		world: World,
		playlists: NonNullable<ParsedDash["playlists"]>,
	): EngineDeps => {
		const base = depsFor(world);
		return {
			...base,
			parseDash: async (text: string) => ({
				...(await base.parseDash(text)),
				playlists,
			}),
		};
	};
	const v720 = {
		kind: "video" as const,
		id: "v720",
		mapUri: "video/720p/init.mp4",
		segmentUris: [1, 2, 3].map((n) => `video/720p/segment_${n}.m4s`),
	};
	it("passes when every referenced object exists with bytes and the assembly decodes", async () => {
		const report = await verifyArtefacts(
			expected,
			withPlaylists(healthyWorld(), [v720]),
		);
		const ids = report.checks.map((c) => `${c.id}=${c.verdict}`);
		expect(ids).toContain("manifest:dash:playlist:v720:media-closure=PASS");
		expect(ids).toContain("manifest:dash:playlist:v720:media-decodes=PASS");
	});
	it("fails closure when a resolved segment is not in the bucket, and names it", async () => {
		const report = await verifyArtefacts(
			expected,
			withPlaylists(healthyWorld(), [
				{
					...v720,
					segmentUris: [...v720.segmentUris, "video/720p/segment_9.m4s"],
				},
			]),
		);
		const check = report.checks.find(
			(c) => c.id === "manifest:dash:playlist:v720:media-closure",
		);
		expect(check?.verdict).toBe("FAIL");
		expect(check?.detail).toMatch(
			/1 missing \(first out\/video\/720p\/segment_9\.m4s\)/,
		);
	});
	it("SKIPs, by name, when the parser exposes no resolved playlists — never a silent pass", async () => {
		const report = await verifyArtefacts(expected, depsFor(healthyWorld()));
		const check = report.checks.find(
			(c) => c.id === "manifest:dash:media-closure",
		);
		expect(check?.verdict).toBe("SKIP");
	});
	it("closure stays exhaustive above MAX_FULL_ASSEMBLY while the decode samples and says so (review-343 L1)", async () => {
		const world = healthyWorld();
		const many = Array.from(
			{ length: 250 },
			(_, i) => `video/720p/segment_${i + 1}.m4s`,
		);
		for (const uri of many) {
			const key = `out/${uri}`;
			if (!world.objects.includes(key)) {
				world.objects.push(key);
			}
		}
		const healthy = await verifyArtefacts(
			expected,
			withPlaylists(world, [{ ...v720, segmentUris: many }]),
		);
		const decode = healthy.checks.find(
			(c) => c.id === "manifest:dash:playlist:v720:media-decodes",
		);
		expect(decode?.verdict).toBe("PASS");
		expect(decode?.detail).toMatch(/sampled/);
		// A miss OUTSIDE the sample trio (first / middle / last) still fails
		// closure — sampling is the decode's economy, never the closure's.
		const missing = world.objects.filter(
			(k) => k !== "out/video/720p/segment_200.m4s",
		);
		const broken = await verifyArtefacts(
			expected,
			withPlaylists({ ...world, objects: missing }, [
				{ ...v720, segmentUris: many },
			]),
		);
		const closure = broken.checks.find(
			(c) => c.id === "manifest:dash:playlist:v720:media-closure",
		);
		expect(closure?.verdict).toBe("FAIL");
		expect(closure?.detail).toMatch(/segment_200\.m4s/);
		expect(
			broken.checks.find(
				(c) => c.id === "manifest:dash:playlist:v720:media-decodes",
			)?.verdict,
		).toBe("SKIP");
	});
});

describe("media closure — the FOREIGN clause (re-audit BLOCKER-4, review-343 H1)", () => {
	it("a referenced object the foreign filter rejects fails closure by name, with the count", async () => {
		// The hygiene sweep (hygiene:foreign-objects) scans every listed object;
		// this clause is about a REFERENCED one — a same-path leftover from an
		// earlier job that a child playlist still names. The mutant disabling it
		// survived the whole suite before this arm existed.
		const world = healthyWorld();
		world.foreign = ["out/video/360p/segment_2.m4s"];
		const report = await verifyArtefacts(expected, depsFor(world));
		const check = report.checks.find(
			(c) => c.id === "manifest:hls:child:video_600000-m3u8:media-closure",
		);
		expect(check?.verdict).toBe("FAIL");
		expect(check?.detail).toMatch(/foreign/);
		expect(check?.detail).toMatch(/segment_2\.m4s/);
	});
});

// ---------------------------------------------------------------------------
// Exact audio / mux topology.
//
// The count-and-name checks passed a 128k rendition delivered at 64k, a wrong
// codec, a stereo track in another layout, and two children swapped, because
// nothing tied an observed child to the rendition it was supposed to be. Each
// binding below is measured twice, the discipline this file already holds every
// other assertion to: once on a matching world (no FAIL) and once with ONE
// attribute diverged, which must flip its OWN check to FAIL.
//
// Enriched over the base manifests: RESOLUTION + BANDWIDTH + CODECS per variant,
// GROUP-ID + NAME on the audio media, per-representation height/bandwidth/codecs
// and per-set codecs — the fields a real Bitmovin master/MPD carries.
// ---------------------------------------------------------------------------

const TOPO_HLS_MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"
video_2000000.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio"
video_600000.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="HLS Audio Media",URI="audio_128000.m3u8"
`;

const TOPO_MPD = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT12S"><Period>
  <AdaptationSet contentType="video"><Representation id="v720" height="720" bandwidth="2000000" codecs="avc1.640028"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet contentType="video"><Representation id="v360" height="360" bandwidth="600000" codecs="avc1.4d401e"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  <AdaptationSet contentType="audio"><Representation id="a128" bandwidth="128000" codecs="mp4a.40.2"><SegmentTemplate><SegmentTimeline><S d="4" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
</Period></MPD>
`;

/** The a128 audio muxing's probe (init + first segment assemble to this). */
function audioProbe(w: World): MediaProbe {
	const probe = w.probes["out/audio/128000/init.mp4"];
	if (!probe) {
		throw new Error("topoWorld must define the a128 init probe");
	}
	return probe;
}

/** A manifest text the world must carry, or a loud failure — strict, no `!`. */
function textOf(w: World, key: string): string {
	const text = w.texts[key];
	if (text === undefined) {
		throw new Error(`topoWorld must define ${key}`);
	}
	return text;
}

/**
 * healthyWorld + enriched manifests + matching audio facts on the a128 probe, so
 * every topology binding has something to bind AND the control is all-PASS.
 */
function topoWorld(): World {
	const w = healthyWorld();
	w.texts["out/stream.m3u8"] = TOPO_HLS_MASTER;
	w.texts["out/stream.mpd"] = TOPO_MPD;
	const audio = audioProbe(w);
	audio.audioCodec = "aac";
	audio.audioChannels = 2;
	audio.audioBitrateBps = 128_000;
	return w;
}

const verdictOf = (
	report: { checks: readonly { id: string; verdict: string }[] },
	id: string,
) => report.checks.find((c) => c.id === id)?.verdict;

describe("verification engine — exact audio/mux topology (row 272)", () => {
	it("the enriched control has zero faults", async () => {
		const report = await verifyArtefacts(expected, depsFor(topoWorld()));
		expect(failedIds(report)).toEqual([]);
		// The bindings actually ran (not vacuously green): a representative id from
		// each family is present and PASSing.
		for (const id of [
			"rendition:a128:audio-codec",
			"rendition:a128:audio-bitrate",
			"rendition:a128:audio-channels",
			"manifest:hls:variant:v360:present",
			"manifest:hls:variant:v360:resolution",
			"manifest:hls:variant:v360:bandwidth",
			"manifest:hls:variant:v360:codec",
			"manifest:hls:variants-duplicate",
			"manifest:hls:variants-unexpected",
			"manifest:hls:media:a128:present",
			"manifest:hls:media:a128:uri",
			"manifest:hls:media-unexpected",
			"manifest:dash:rep:v360:present",
			"manifest:dash:rep:v360:bandwidth",
			"manifest:dash:rep:a128:present",
			"manifest:dash:rep:a128:bandwidth",
			"manifest:dash:representations-duplicate",
			"manifest:dash:representations-unexpected",
			"manifest:dash:adaptationset-codecs",
		]) {
			expect(verdictOf(report, id), id).toBe("PASS");
		}
	});

	const TOPO_FAULTS: {
		name: string;
		id: string;
		break: (w: World) => void;
	}[] = [
		{
			name: "audio delivered in the wrong codec (ac3, plan AAC)",
			id: "rendition:a128:audio-codec",
			break: (w) => {
				audioProbe(w).audioCodec = "ac3";
			},
		},
		{
			name: "128k audio delivered at 64k",
			id: "rendition:a128:audio-bitrate",
			break: (w) => {
				audioProbe(w).audioBitrateBps = 64_000;
			},
		},
		{
			name: "stereo delivered as 5.1 (2 vs 6 channels)",
			id: "rendition:a128:audio-channels",
			break: (w) => {
				audioProbe(w).audioChannels = 6;
			},
		},
		{
			// The row IS present (its URI and AUDIO are the compiler's), so the
			// binding holds it and the RESOLUTION check names the defect (row 284).
			name: "a variant's RESOLUTION matches no rendition height",
			id: "manifest:hls:variant:v360:resolution",
			break: (w) => {
				w.texts["out/stream.m3u8"] = textOf(w, "out/stream.m3u8").replace(
					"RESOLUTION=640x360",
					"RESOLUTION=640x480",
				);
			},
		},
		{
			name: "a variant's BANDWIDTH is far below its rendition's bitrate",
			id: "manifest:hls:variant:v360:bandwidth",
			break: (w) => {
				w.texts["out/stream.m3u8"] = textOf(w, "out/stream.m3u8").replace(
					"BANDWIDTH=600000,RESOLUTION=640x360",
					"BANDWIDTH=100000,RESOLUTION=640x360",
				);
			},
		},
		{
			name: "a variant's CODECS names a codec the rendition did not plan",
			id: "manifest:hls:variant:v360:codec",
			break: (w) => {
				w.texts["out/stream.m3u8"] = textOf(w, "out/stream.m3u8").replace(
					'CODECS="avc1.4d401e,mp4a.40.2"',
					'CODECS="hev1.1.6.L93.B0,mp4a.40.2"',
				);
			},
		},
		{
			// (GROUP-ID, NAME) is the entry's identity (row 284): in the wrong
			// group there is no entry for a128 to bind, and `:present` says so.
			name: "the audio media sits in the wrong GROUP-ID",
			id: "manifest:hls:media:a128:present",
			break: (w) => {
				w.texts["out/stream.m3u8"] = textOf(w, "out/stream.m3u8").replace(
					'GROUP-ID="audio"',
					'GROUP-ID="not-the-plan"',
				);
			},
		},
		{
			name: "the audio media is renamed away from the plan",
			id: "manifest:hls:media:a128:present",
			break: (w) => {
				w.texts["out/stream.m3u8"] = textOf(w, "out/stream.m3u8").replace(
					'NAME="HLS Audio Media"',
					'NAME="Something Else"',
				);
			},
		},
		{
			name: "a video representation's height matches no rendition",
			id: "manifest:dash:rep:v360:present",
			break: (w) => {
				w.texts["out/stream.mpd"] = textOf(w, "out/stream.mpd").replace(
					'height="360"',
					'height="480"',
				);
			},
		},
		{
			name: "a video representation's bandwidth is far off its rendition",
			id: "manifest:dash:rep:v360:bandwidth",
			break: (w) => {
				w.texts["out/stream.mpd"] = textOf(w, "out/stream.mpd").replace(
					'bandwidth="600000"',
					'bandwidth="5000000"',
				);
			},
		},
	];

	for (const fault of TOPO_FAULTS) {
		it(`catches: ${fault.name}`, async () => {
			const world = topoWorld();
			fault.break(world);
			const report = await verifyArtefacts(expected, depsFor(world));
			expect(verdictOf(report, fault.id), fault.name).toBe("FAIL");
		});
	}
});

// ---------------------------------------------------------------------------
// DASH codec↔AdaptationSet + per-representation codec, isolated (row 272).
//
// In a single-codec plan a wrong representation codec trips BOTH `:rep:*:codec`
// and `:adaptationset-codecs` (the set derives from its reps), so neither can be
// mutation-proven alone there. A TWO-codec ladder decouples them: mutate one
// rep's codec to the OTHER planned family and only `:rep:*:codec` fires (the set
// stays single-family); mix the families into one set and only
// `:adaptationset-codecs` fires (each rep stays right for its rendition). The
// call site is pinned by the DASH faults in the block above.
// ---------------------------------------------------------------------------

describe("verification engine — DASH codec topology, isolated (row 272)", () => {
	const topology: ManifestRenditionTopology = {
		video: [
			{ renditionKey: "v720", height: 720, bitrate: 2_000_000, codec: "H264" },
			{ renditionKey: "v360", height: 360, bitrate: 600_000, codec: "H265" },
		],
		audio: [{ renditionKey: "a128", codec: "AAC", bitrate: 128_000 }],
		declaredVideoCodecFamilies: ["H264", "H265"],
	};
	// One builder, its two mutable seams named — the v360 rep's codecs and the
	// AdaptationSet list — so each test diverges exactly one of them.
	const parsed = (over?: {
		v360Codecs?: string;
		adaptationSets?: NonNullable<ParsedDash["adaptationSets"]>;
	}): ParsedDash => ({
		representations: [
			{
				kind: "video",
				height: 720,
				bandwidth: 2_000_000,
				codecs: "avc1.640028",
				addressing: "TEMPLATE",
			},
			{
				kind: "video",
				height: 360,
				bandwidth: 600_000,
				codecs: over?.v360Codecs ?? "hev1.1.6.L93.B0",
				addressing: "TEMPLATE",
			},
			{
				kind: "audio",
				bandwidth: 128_000,
				codecs: "mp4a.40.2",
				addressing: "TEMPLATE",
			},
		],
		periods: 1,
		adaptationSets: over?.adaptationSets ?? [
			{ kind: "video", codecs: ["avc1.640028"] },
			{ kind: "video", codecs: ["hev1.1.6.L93.B0"] },
			{ kind: "audio", codecs: ["mp4a.40.2"] },
		],
	});
	const run = (p: ParsedDash) => {
		const report = new ReportBuilder();
		bindDashTopology(report, "manifest:dash", topology, p, { perTitle: false });
		return report;
	};

	it("a matching MPD passes codec and topology", () => {
		const report = run(parsed());
		expect(report.checks.filter((c) => c.verdict === "FAIL")).toEqual([]);
		expect(verdictOf(report, "manifest:dash:rep:v360:codec")).toBe("PASS");
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"PASS",
		);
	});

	it("catches a representation carrying the wrong planned codec (H264 where H265)", () => {
		const report = run(parsed({ v360Codecs: "avc1.640028" }));
		expect(verdictOf(report, "manifest:dash:rep:v360:codec")).toBe("FAIL");
		// Isolated: the set topology, unchanged, still passes.
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"PASS",
		);
	});

	it("catches two codec families packed into one AdaptationSet (case F)", () => {
		const report = run(
			parsed({
				adaptationSets: [
					{ kind: "video", codecs: ["avc1.640028", "hev1.1.6.L93.B0"] },
					{ kind: "audio", codecs: ["mp4a.40.2"] },
				],
			}),
		);
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"FAIL",
		);
		// Isolated: each representation is still right for its rendition.
		expect(verdictOf(report, "manifest:dash:rep:v360:codec")).toBe("PASS");
	});
});

// ---------------------------------------------------------------------------
// C1 (review of row 272): the audio GROUP-ID is PER RENDITION, not the manifest
// default. A Dolby variantsPerAudioGroup ladder fans its audio across "atmos"
// and "aac" groups; the topology used to stamp the flat manifest.audioGroupId
// ("audio") on every entry, so bindHlsTopology asserted "audio" against a
// CORRECT master carrying "atmos"/"aac" and FAILed it. topoWorld carries one
// group, which is why the rest of this suite never saw it.
// ---------------------------------------------------------------------------

describe("verification engine — per-rendition audio GROUP-ID (row 272 / C1)", () => {
	it("binds a Dolby variantsPerAudioGroup master by its real groups, not the default", () => {
		const dolby = compileFixture("dolby-dv-hdr10-sdr-2ladder-profile81");
		const hls = dolby.manifests.find(
			(m) => m.kind === "HLS" && m.manifestRenditions !== undefined,
		);
		const topology = hls?.manifestRenditions;
		if (topology === undefined) {
			throw new Error("the Dolby fixture must compile an HLS topology");
		}
		// The compiler must expose the PER-RENDITION groups — not the flat
		// manifest default. This alone goes red on the pre-fix flat stamp.
		expect(topology.audio.map((a) => a.groupId).sort()).toEqual([
			"aac",
			"atmos",
		]);
		// And a real master carrying exactly those groups must bind clean. The
		// binding is exercised on the audio leg alone (this fixture's video ladder
		// is per-title/multi-encoding and not the subject here).
		const audioOnly: ManifestRenditionTopology = {
			video: [],
			audio: topology.audio,
			declaredVideoCodecFamilies: [],
		};
		const parsed: ParsedHls = {
			variants: [],
			media: [
				{ type: "AUDIO", groupId: "atmos", name: "English Atmos" },
				{ type: "AUDIO", groupId: "aac", name: "English AAC" },
			],
		};
		const report = new ReportBuilder();
		bindHlsTopology(report, "manifest:hls", audioOnly, parsed, {
			perTitle: false,
		});
		expect(report.checks.filter((c) => c.verdict === "FAIL")).toEqual([]);
		// (GROUP-ID, NAME) is the identity (row 284): bound in its real group.
		expect(verdictOf(report, "manifest:hls:media:atmos448:present")).toBe(
			"PASS",
		);
		expect(verdictOf(report, "manifest:hls:media:aac128:present")).toBe("PASS");
	});
});

// ---------------------------------------------------------------------------
// I1 (review of row 272): an attribute the plan declares but the manifest/probe
// OMITS on a PRESENT child must SKIP with a reason, never silently PASS — the
// exact silent-pass class this PR exists to kill. engine-no-silence compares
// check-id SETS (a SKIP and a PASS are identical to it, and its RICH probe has
// no audio bitrate so the assert branch never runs there), so these pin the
// VERDICT: turning any of these SKIP branches into a PASS goes red here.
// ---------------------------------------------------------------------------

describe("verification engine — absent attribute SKIPs, never PASSes (row 272 / I1)", () => {
	const oneVideo: ManifestRenditionTopology = {
		video: [
			{ renditionKey: "v360", height: 360, bitrate: 600_000, codec: "H264" },
		],
		audio: [],
		declaredVideoCodecFamilies: ["H264"],
		// The HLS node: self-contained (no AUDIO), named as the master names it.
		hlsVariants: [
			{
				key: "v360",
				renditionKey: "v360",
				kind: "video",
				codec: "H264",
				height: 360,
				bitrate: 600_000,
				uri: "v.m3u8",
			},
		],
	};

	it("a variant present but declaring no CODECS SKIPs its codec check", () => {
		const report = new ReportBuilder();
		bindHlsTopology(
			report,
			"manifest:hls",
			oneVideo,
			{
				variants: [
					{ uri: "v.m3u8", resolution: "640x360", bandwidth: 600_000 },
				],
				media: [],
			},
			{ perTitle: false },
		);
		expect(verdictOf(report, "manifest:hls:variant:v360:codec")).toBe("SKIP");
		// present is PASS — the child WAS observed, the attribute just wasn't.
		expect(verdictOf(report, "manifest:hls:variant:v360:present")).toBe("PASS");
	});

	it("a representation present but declaring no bandwidth SKIPs its bandwidth check", () => {
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			oneVideo,
			{
				representations: [
					{
						kind: "video",
						height: 360,
						codecs: "avc1.4d401e",
						addressing: "TEMPLATE",
					},
				],
				periods: 1,
			},
			{ perTitle: false },
		);
		expect(verdictOf(report, "manifest:dash:rep:v360:bandwidth")).toBe("SKIP");
		expect(verdictOf(report, "manifest:dash:rep:v360:present")).toBe("PASS");
	});

	it("an audio track present but with no measured bitrate SKIPs its bitrate check", async () => {
		const w = topoWorld();
		audioProbe(w).audioBitrateBps = undefined;
		const report = await verifyArtefacts(expected, depsFor(w));
		expect(verdictOf(report, "rendition:a128:audio-bitrate")).toBe("SKIP");
		// The other audio bindings still ran (codec present) — the track WAS observed.
		expect(verdictOf(report, "rendition:a128:audio-codec")).toBe("PASS");
	});
});

describe("single-file IMSC delivery", () => {
	const validTtml =
		'<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s">字幕 &amp; caption</p></div></body></tt>';
	function imscWorld(size = 1024, text = validTtml) {
		const plan = encodingPlanSchema.parse({
			...BASE_PLAN,
			manifests: [],
			fileStreams: [
				{
					key: "ttml",
					inputKey: "main",
					inputPath: "captions.ttml",
					fileType: "TTML",
				},
			],
			renditions: [
				...BASE_PLAN.renditions,
				{ key: "imsc", codec: "IMSC", ingestKey: "ttml" },
			],
			muxings: [
				...BASE_PLAN.muxings,
				{
					key: "imsc-text",
					kind: "TEXT",
					streamKey: "imsc",
					filename: "english.ttml",
					destination: { outputKey: "origin", path: "out/subtitles/" },
				},
			],
		});
		const artefacts = compileExpectedArtefacts(plan);
		const world = healthyWorld();
		world.objects.push("out/subtitles/english.ttml");
		world.sizes = { "out/subtitles/english.ttml": size };
		world.texts["out/subtitles/english.ttml"] = text;
		return { artefacts, world };
	}
	it.each([
		0, 1024,
	] as const)("checks Text output bytes (%s) and XML without an AV probe", async (size) => {
		const { artefacts, world } = imscWorld(size, size === 0 ? "" : validTtml);
		const report = await verifyArtefacts(artefacts, depsFor(world));
		expect(verdictOf(report, "muxing:imsc-text:file")).toBe("PASS");
		expect(verdictOf(report, "muxing:imsc-text:file-bytes")).toBe(
			size > 0 ? "PASS" : "FAIL",
		);
		expect(verdictOf(report, "muxing:imsc-text:file-xml")).toBe(
			size > 0 ? "PASS" : "FAIL",
		);
	});
	it.each([
		'<tt xmlns="http://www.w3.org/ns/ttml"><body><p end="00:00:03.000"style="s1">IMSC 最初の字幕</p></body></tt>',
		'<tt xmlns="http://www.w3.org/ns/ttml"><body></tt>',
		"<html/>",
	])("fails nonempty malformed or non-TTML output without aborting other checks", async (text) => {
		const { artefacts, world } = imscWorld(Buffer.byteLength(text), text);
		const report = await verifyArtefacts(artefacts, depsFor(world));
		expect(verdictOf(report, "muxing:imsc-text:file-bytes")).toBe("PASS");
		expect(verdictOf(report, "muxing:imsc-text:file-xml")).toBe("FAIL");
		expect(verdictOf(report, "rendition:a128:audio-codec")).toBe("PASS");
	});
	it("reports a failed subtitle read and completes the verification report", async () => {
		const { artefacts, world } = imscWorld();
		delete world.texts["out/subtitles/english.ttml"];
		const report = await verifyArtefacts(artefacts, depsFor(world));
		expect(verdictOf(report, "muxing:imsc-text:file-xml")).toBe("FAIL");
		expect(verdictOf(report, "rendition:a128:audio-codec")).toBe("PASS");
	});
	it("fails an oversized listed subtitle before reading its contents", async () => {
		const { artefacts, world } = imscWorld(9 * 1024 * 1024);
		let reads = 0;
		const report = await verifyArtefacts(artefacts, {
			...depsFor(world),
			readText: async () => {
				reads++;
				throw new Error("Oversized subtitle must not be read");
			},
		});
		expect(reads).toBe(0);
		expect(verdictOf(report, "muxing:imsc-text:file-xml")).toBe("FAIL");
	});
});

describe("DASH IMSC representation verification through the real MPD parser", () => {
	const textSet = `<AdaptationSet contentType="text" mimeType="application/ttml+xml"><Representation id="imsc" bandwidth="100"><BaseURL>subtitles/english.ttml</BaseURL></Representation></AdaptationSet>`;
	function imscWorld(addressing: "TEMPLATE" | "TIMELINE" = "TEMPLATE") {
		const plan = encodingPlanSchema.parse({
			...BASE_PLAN,
			manifests: BASE_PLAN.manifests
				.filter((m) => m.kind === "DASH")
				.map((m) => ({ ...m, representationType: addressing })),
			fileStreams: [
				{
					key: "ttml",
					inputKey: "main",
					inputPath: "captions.ttml",
					fileType: "TTML",
				},
			],
			renditions: [
				...BASE_PLAN.renditions,
				{ key: "imsc", codec: "IMSC", ingestKey: "ttml" },
			],
			muxings: [
				...BASE_PLAN.muxings,
				{
					key: "imsc-text",
					kind: "TEXT",
					streamKey: "imsc",
					filename: "english.ttml",
					destination: { outputKey: "origin", path: "out/subtitles/" },
				},
			],
		});
		const segmentTemplate = (dir: string) =>
			`<SegmentTemplate media="${dir}segment_$Number$.m4s" initialization="${dir}init.mp4" startNumber="1" ${addressing === "TEMPLATE" ? 'duration="4"' : ""}>${addressing === "TIMELINE" ? '<SegmentTimeline><S t="0" d="4" r="2"/></SegmentTimeline>' : ""}</SegmentTemplate>`;
		const videoSets = [
			["v720", 720, 2000000],
			["v360", 360, 600000],
		]
			.map(
				([id, height, bandwidth]) =>
					`<AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="${id}" codecs="avc1.640028" height="${height}" bandwidth="${bandwidth}">${segmentTemplate(`video/${height}p/`)}</Representation></AdaptationSet>`,
			)
			.join("");
		const audioSet = `<AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a128" codecs="mp4a.40.2" bandwidth="128000" audioSamplingRate="48000">${segmentTemplate("audio/128000/")}</Representation></AdaptationSet>`;
		const world = healthyWorld();
		world.objects.push("out/subtitles/english.ttml");
		world.texts["out/subtitles/english.ttml"] =
			'<tt xmlns="http://www.w3.org/ns/ttml"/>';
		world.texts["out/stream.mpd"] =
			`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT4S"><Period duration="PT12S">${videoSets}${audioSet}${textSet}</Period></MPD>`;
		return { artefacts: compileExpectedArtefacts(plan), world };
	}
	const run = (value: ReturnType<typeof imscWorld>) =>
		verifyArtefacts(value.artefacts, {
			...depsFor(value.world),
			parseDash: parseDashText,
		});
	it.each([
		"TEMPLATE",
		"TIMELINE",
	] as const)("accepts %s AV plus single-file IMSC and counts all four representations", async (addressing) => {
		const value = imscWorld(addressing);
		const parsed = await parseDashText(
			value.world.texts["out/stream.mpd"] ?? "",
		);
		expect(parsed.representations.find((r) => r.id === "imsc")).toMatchObject({
			kind: "text",
			addressing: "BASE",
		});
		const report = await run(value);
		expect(failedIds(report)).toEqual([]);
		for (const check of [
			"representations",
			"video-representations",
			"audio-representations",
			"text-representations",
			"addressing",
		])
			expect(verdictOf(report, `manifest:dash:${check}`)).toBe("PASS");
	});
	it("fails missing IMSC instead of reporting only the AV count as complete", async () => {
		const value = imscWorld();
		value.world.texts["out/stream.mpd"] =
			value.world.texts["out/stream.mpd"]?.replace(textSet, "") ?? "";
		const report = await run(value);
		expect(verdictOf(report, "manifest:dash:text-representations")).toBe(
			"FAIL",
		);
		expect(verdictOf(report, "manifest:dash:representations")).toBe("FAIL");
	});
	it.each([
		"video",
		"audio",
	] as const)("does not let extra text replace a missing %s representation", async (kind) => {
		const value = imscWorld();
		value.world.texts["out/stream.mpd"] =
			value.world.texts["out/stream.mpd"]?.replace(
				new RegExp(
					`<AdaptationSet contentType="${kind}"[^>]*>[\\s\\S]*?</AdaptationSet>`,
				),
				textSet.replace('id="imsc"', 'id="extra-text"'),
			) ?? "";
		const report = await run(value);
		expect(verdictOf(report, "manifest:dash:representations")).toBe("PASS");
		expect(verdictOf(report, `manifest:dash:${kind}-representations`)).toBe(
			"FAIL",
		);
		expect(verdictOf(report, "manifest:dash:text-representations")).toBe(
			"FAIL",
		);
	});
	it("still rejects BASE addressing on an AV representation", async () => {
		const value = imscWorld();
		value.world.texts["out/stream.mpd"] =
			value.world.texts["out/stream.mpd"]?.replace(
				/<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/,
				"<BaseURL>video/720p/init.mp4</BaseURL>",
			) ?? "";
		expect(verdictOf(await run(value), "manifest:dash:addressing")).toBe(
			"FAIL",
		);
	});
	it("still checks segmented subtitle addressing", async () => {
		const value = imscWorld();
		value.world.texts["out/stream.mpd"] =
			value.world.texts["out/stream.mpd"]?.replace(
				"<BaseURL>subtitles/english.ttml</BaseURL>",
				'<SegmentTemplate media="subtitles/segment_$Number$.vtt"><SegmentTimeline><S t="0" d="4" r="2"/></SegmentTimeline></SegmentTemplate>',
			) ?? "";
		expect(verdictOf(await run(value), "manifest:dash:addressing")).toBe(
			"FAIL",
		);
	});
});
