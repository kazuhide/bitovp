import { createHash } from "node:crypto";
import {
	type ExpectedLiveManifest,
	edgeUrlPolicy,
	liveEvidenceProgression,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	closureProbe,
	type EdgeRead,
	MAX_EDGE_MEDIA_PER_CHILD,
	observeEdgeLeg,
	spread,
} from "./edge-resolver";

/**
 * The delivery-edge resolver (audit 5c3d97ca BLOCKER-4, §14.4 EV-02 #3/#4).
 *
 * Every negative the audit lists must leave the leg NOT closed and name why:
 * empty / master-only, a disallowed scheme or origin, a root escape, zero
 * segments, an MPD with Representations only, a missing init, a missing child,
 * an old run's prefix, and — through `closureProbe` — two identical snapshots.
 * The positives are the resolver rules (same-origin absolute and relative
 * references) and the four delivery topologies the MSL4 audit
 * exercised: HLS/TS separated audio, HLS/TS muxed audio, HLS/fMP4, DASH/fMP4.
 */

const sha = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

const BASE = "https://edge.akamaized.net/hls/live/2126636/event/";
const CURRENT_RUN_PREFIX = "verify/RUN1/live-akamai-msl-storage/";
const PREFIX = "verify/RUN1/live-akamai-msl-storage/output/";
const ROOT = `${BASE}${PREFIX}`;
const policy = edgeUrlPolicy(BASE);

function manifest(kind: "HLS" | "DASH", file: string): ExpectedLiveManifest {
	return {
		manifestKey: kind.toLowerCase(),
		kind,
		outputKey: "mirror-1",
		dir: { pattern: PREFIX, prefix: PREFIX, templated: false },
		files: [file],
		mediaPlaylists: [],
	};
}

type Served =
	| string
	| Uint8Array
	| {
			status: number;
			body?: string;
			redirected?: boolean;
			finalUrl?: string;
			/** The `Last-Modified` header this object is served with (WP-C6b). */
			lastModified?: string;
	  };

/** A fake edge keyed by FULL URL (query included): unknown → 404. */
function edge(objects: Record<string, Served>) {
	const urls: string[] = [];
	const readEdge = async (url: string): Promise<EdgeRead> => {
		urls.push(url);
		const hit = objects[url];
		if (hit === undefined) {
			return { status: 404, bytes: 0, text: "" };
		}
		if (typeof hit === "string") {
			return { status: 200, bytes: Buffer.byteLength(hit), text: hit };
		}
		if (hit instanceof Uint8Array) {
			return {
				status: 200,
				bytes: hit.byteLength,
				text: Buffer.from(hit).toString("utf8"),
				body: hit,
			};
		}
		const body = hit.body ?? "";
		return {
			status: hit.status,
			bytes: body.length,
			text: body,
			...(hit.redirected !== undefined ? { redirected: hit.redirected } : {}),
			...(hit.finalUrl !== undefined ? { finalUrl: hit.finalUrl } : {}),
			...(hit.lastModified !== undefined
				? { lastModified: hit.lastModified }
				: {}),
		};
	};
	return { urls, readEdge };
}

const TS_BYTES = new Uint8Array([0x47, 0x40, 0x11, 0x10, 0x00, 0x42, 0xf0]);
const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

const mediaPlaylist = (
	seq: number,
	segments: string[],
	opts: { map?: string; ts?: boolean } = {},
) =>
	[
		"#EXTM3U",
		"#EXT-X-VERSION:6",
		"#EXT-X-TARGETDURATION:6",
		`#EXT-X-MEDIA-SEQUENCE:${seq}`,
		...(opts.map ? [`#EXT-X-MAP:URI="${opts.map}"`] : []),
		...segments.flatMap((s) => ["#EXTINF:6.0,", s]),
	].join("\n");

/** HLS/TS with SEPARATED audio (M2): video-only variants + an EXT-X-MEDIA audio rendition. */
function tsSeparated(seq = 10): Record<string, Served> {
	const segs = (name: string) => [`${name}-${seq}.ts`, `${name}-${seq + 1}.ts`];
	return {
		[`${ROOT}stream.m3u8`]: [
			"#EXTM3U",
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="en",DEFAULT=YES,URI="audio_128000.m3u8"',
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="audio"',
			"video_4500000.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e",AUDIO="audio"',
			"video_800000.m3u8",
		].join("\n"),
		[`${ROOT}video_4500000.m3u8`]: mediaPlaylist(seq, segs("v1080")),
		[`${ROOT}video_800000.m3u8`]: mediaPlaylist(seq, segs("v360")),
		[`${ROOT}audio_128000.m3u8`]: mediaPlaylist(seq, segs("a128")),
		...Object.fromEntries(
			["v1080", "v360", "a128"].flatMap((name) =>
				segs(name).map((s) => [`${ROOT}${s}`, TS_BYTES]),
			),
		),
	};
}

/** HLS/TS with MUXED audio (M3/M4): variants only, TS segments carry both. */
function tsMuxed(seq = 4): Record<string, Served> {
	return {
		[`${ROOT}stream.m3u8`]: [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
			"video_4500000.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
			"video_3000000.m3u8",
		].join("\n"),
		[`${ROOT}video_4500000.m3u8`]: mediaPlaylist(seq, [`m1080-${seq}.ts`]),
		[`${ROOT}video_3000000.m3u8`]: mediaPlaylist(seq, [`m720-${seq}.ts`]),
		[`${ROOT}m1080-${seq}.ts`]: TS_BYTES,
		[`${ROOT}m720-${seq}.ts`]: TS_BYTES,
	};
}

/** HLS/fMP4: EXT-X-MAP init + .m4s media, segments in per-rendition folders. */
function fmp4Hls(seq = 20): Record<string, Served> {
	return {
		[`${ROOT}stream.m3u8`]: [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
			"video_4500000.m3u8",
		].join("\n"),
		[`${ROOT}video_4500000.m3u8`]: mediaPlaylist(
			seq,
			[`video/1080p/seg-${seq}.m4s`, `video/1080p/seg-${seq + 1}.m4s`],
			{ map: "video/1080p/init.mp4" },
		),
		[`${ROOT}video/1080p/init.mp4`]: MP4_BYTES,
		[`${ROOT}video/1080p/seg-${seq}.m4s`]: MP4_BYTES,
		[`${ROOT}video/1080p/seg-${seq + 1}.m4s`]: MP4_BYTES,
	};
}

const AST = "2026-08-30T10:00:00Z";
/** NOW: 60 s after availabilityStartTime → 10 six-second segments addressable. */
const NOW = Date.parse("2026-08-30T10:01:00Z");

/** DASH/fMP4: a dynamic template MPD, two video + one audio representation. */
function dynamicMpd(opts: { withSegments?: boolean; baseUrl?: string } = {}) {
	const seg = opts.withSegments !== false;
	return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011"
  availabilityStartTime="${AST}" publishTime="2026-08-30T10:00:54Z" minimumUpdatePeriod="PT6S"
  timeShiftBufferDepth="PT2H" suggestedPresentationDelay="PT12S" minBufferTime="PT6S" maxSegmentDuration="PT6S">
  ${opts.baseUrl ? `<BaseURL>${opts.baseUrl}</BaseURL>` : ""}
  <Period id="0" start="PT0S">
    <AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      ${seg ? '<SegmentTemplate timescale="90000" duration="540000" startNumber="1" media="video/$RepresentationID$/seg-$Number$.m4s" initialization="video/$RepresentationID$/init.mp4"/>' : ""}
      <Representation id="1080p" bandwidth="4500000" codecs="avc1.640028" width="1920" height="1080"/>
      <Representation id="720p" bandwidth="3000000" codecs="avc1.64001f" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" lang="en">
      ${seg ? '<SegmentTemplate timescale="48000" duration="288000" startNumber="1" media="audio/$RepresentationID$/seg-$Number$.m4s" initialization="audio/$RepresentationID$/init.mp4"/>' : ""}
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function segmentTimelineMpd() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
  mediaPresentationDuration="PT18S" minBufferTime="PT1S">
  <Period id="0" duration="PT18S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1" media="timeline/$RepresentationID$/seg-$Time$.m4s" initialization="timeline/$RepresentationID$/init.mp4">
        <SegmentTimeline><S t="0" d="6" r="2"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="timeline-v1" bandwidth="800000" codecs="avc1.42c01e" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function segmentListMpd() {
	return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
  mediaPresentationDuration="PT12S" minBufferTime="PT1S">
  <Period id="0" duration="PT12S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="list-v1" bandwidth="800000" codecs="avc1.42c01e" width="640" height="360">
        <SegmentList timescale="1" duration="6">
          <Initialization sourceURL="list/list-v1/init.mp4"/>
          <SegmentURL media="list/list-v1/seg-1.m4s"/>
          <SegmentURL media="list/list-v1/seg-2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

/** Every init + the first ten media segments of each representation, served. */
function dashObjects(
	opts: { dropInit?: string; upTo?: number } = {},
): Record<string, Served> {
	const out: Record<string, Served> = { [`${ROOT}stream.mpd`]: dynamicMpd() };
	for (const [folder, id] of [
		["video", "1080p"],
		["video", "720p"],
		["audio", "a128"],
	] as const) {
		if (opts.dropInit !== id) {
			out[`${ROOT}${folder}/${id}/init.mp4`] = MP4_BYTES;
		}
		for (let n = 1; n <= (opts.upTo ?? 10); n++) {
			out[`${ROOT}${folder}/${id}/seg-${n}.m4s`] = MP4_BYTES;
		}
	}
	return out;
}

const HLS = manifest("HLS", "stream.m3u8");
const DASH = manifest("DASH", "stream.mpd");
const DIRECT_HLS = {
	...HLS,
	dir: { pattern: "", prefix: "", templated: false },
};
const DIRECT_DASH = {
	...DASH,
	dir: { pattern: "", prefix: "", templated: false },
};

describe("observeEdgeLeg — direct MSL master root keeps every media request in the current run", () => {
	it("closes the observed MSL4 shape: master + four children at event root, 52 listed media and every init/media object under this run", async () => {
		const childIds = [
			"video_4500000.m3u8",
			"video_3000000.m3u8",
			"audio_128000.m3u8",
			"audio_64000.m3u8",
		];
		const objects: Record<string, Served> = {
			[`${BASE}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio128",NAME="128k",URI="audio_128000.m3u8"',
				'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio64",NAME="64k",URI="audio_64000.m3u8"',
				'#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="audio128"',
				"video_4500000.m3u8",
				'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f",AUDIO="audio64"',
				"video_3000000.m3u8",
			].join("\n"),
		};
		for (const [index, id] of childIds.entries()) {
			const folder = id.replace(".m3u8", "");
			const segmentRefs = Array.from(
				{ length: 13 },
				(_, n) => `${CURRENT_RUN_PREFIX}${folder}/seg-${n + 1}.m4s`,
			);
			objects[`${BASE}${id}`] = mediaPlaylist(100 + index, segmentRefs, {
				map: `${CURRENT_RUN_PREFIX}${folder}/init.mp4`,
			});
			objects[`${BASE}${CURRENT_RUN_PREFIX}${folder}/init.mp4`] = MP4_BYTES;
			for (const ref of segmentRefs) {
				objects[`${BASE}${ref}`] = MP4_BYTES;
			}
		}
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{
				expectedChildCount: 4,
				expectedChildIds: childIds,
				requireInitChildIds: childIds,
				currentRunPrefix: CURRENT_RUN_PREFIX,
			},
		);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(urls[0]).toBe(`${BASE}stream.m3u8`);
		expect(leg.childCount).toBe(4);
		expect(
			leg.children?.reduce((total, child) => total + child.listed, 0),
		).toBe(52);
		for (const child of leg.children ?? []) {
			expect(child.url.path).toBe(`/hls/live/2126636/event/${child.id}`);
			expect(child.served.some((served) => served.init)).toBe(true);
			expect(child.served.filter((served) => !served.init)).toHaveLength(
				MAX_EDGE_MEDIA_PER_CHILD,
			);
			expect(
				child.served.every((served) =>
					served.url.path.startsWith(
						`/hls/live/2126636/event/${CURRENT_RUN_PREFIX}`,
					),
				),
			).toBe(true);
		}
	});

	it("allows a DASH MPD at the event root while every representation init and media URL stays under the current run prefix", async () => {
		const objects = dashObjects();
		delete objects[`${ROOT}stream.mpd`];
		objects[`${BASE}stream.mpd`] = dynamicMpd({ baseUrl: PREFIX });
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_DASH,
			"mirror-1",
			NOW,
			{ expectedChildCount: 3, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(urls[0]).toBe(`${BASE}stream.mpd`);
		expect(
			urls
				.slice(1)
				.every((url) => url.startsWith(`${BASE}${CURRENT_RUN_PREFIX}`)),
		).toBe(true);
	});

	it("refuses an advancing old-prefix HLS tree without fetching any old child or media", async () => {
		const oldPrefix = "verify/RUN0/live-akamai-msl-storage/output/";
		const oldRoot = `${BASE}${oldPrefix}`;
		const oldObjects = Object.fromEntries(
			Object.entries(tsMuxed(4)).map(([url, value]) => [
				url.replace(ROOT, oldRoot),
				typeof value === "string" ? value.replaceAll(ROOT, oldRoot) : value,
			]),
		);
		oldObjects[`${BASE}stream.m3u8`] = (
			oldObjects[`${oldRoot}stream.m3u8`] as string
		)
			.replace("video_4500000.m3u8", `${oldPrefix}video_4500000.m3u8`)
			.replace("video_3000000.m3u8", `${oldPrefix}video_3000000.m3u8`);
		delete oldObjects[`${oldRoot}stream.m3u8`];
		const { urls, readEdge } = edge(oldObjects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{ expectedChildCount: 2, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.join("\n")).toMatch(/direct MSL event root/i);
		expect(urls).toEqual([`${BASE}stream.m3u8`]);
	});

	it.each([
		["the current-run prefix", `${CURRENT_RUN_PREFIX}video_4500000.m3u8`],
		[
			"another MSL event root",
			"https://edge.akamaized.net/hls/live/2126636/other-event/video_4500000.m3u8",
		],
		["a query-bearing URL", "video_4500000.m3u8?hdnts=exp%3D1~hmac%3Dsecret"],
	])("refuses an HLS child under %s without fetching it", async (_label, ref) => {
		const objects: Record<string, Served> = {
			[`${BASE}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
				ref,
			].join("\n"),
		};
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{ expectedChildCount: 1, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.join("\n")).toMatch(
			/direct MSL event root|outside the edge root|query/i,
		);
		expect(urls).toEqual([`${BASE}stream.m3u8`]);
		expect(JSON.stringify(leg)).not.toContain("secret");
	});

	it("refuses a query-bearing media URL even when its child playlist is exactly at event root", async () => {
		const objects: Record<string, Served> = {
			[`${BASE}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
				"video_4500000.m3u8",
			].join("\n"),
			[`${BASE}video_4500000.m3u8`]: mediaPlaylist(1, [
				`${CURRENT_RUN_PREFIX}seg-1.ts?token=secret`,
			]),
		};
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{ expectedChildCount: 1, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.join("\n")).toMatch(/query/i);
		expect(urls).toEqual([`${BASE}stream.m3u8`, `${BASE}video_4500000.m3u8`]);
		expect(JSON.stringify(leg)).not.toContain("secret");
	});

	it("does not follow an HTTP redirect returned for an event-root child playlist", async () => {
		const objects: Record<string, Served> = {
			[`${BASE}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
				"video_4500000.m3u8",
			].join("\n"),
			[`${BASE}video_4500000.m3u8`]: { status: 302 },
		};
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{ expectedChildCount: 1, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/HTTP 302/);
		expect(urls).toEqual([`${BASE}stream.m3u8`, `${BASE}video_4500000.m3u8`]);
	});

	it("fails closed if an injected edge reader reports that it auto-followed a redirect", async () => {
		const objects: Record<string, Served> = {
			[`${BASE}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
				"video_4500000.m3u8",
			].join("\n"),
			[`${BASE}video_4500000.m3u8`]: {
				status: 200,
				body: mediaPlaylist(1, [`${CURRENT_RUN_PREFIX}seg-1.ts`]),
				redirected: true,
				finalUrl: "https://evil.example/redirected.m3u8",
			},
		};
		const leg = await observeEdgeLeg(
			edge(objects).readEdge,
			policy,
			DIRECT_HLS,
			"mirror-1",
			NOW,
			{ expectedChildCount: 1, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/followed a redirect/i);
		expect(JSON.stringify(leg)).not.toContain("evil.example");
	});

	it.each([
		["the current run prefix", CURRENT_RUN_PREFIX],
		["an old run prefix", "verify/RUN0/live-akamai-msl-storage/"],
	])("refuses a master under %s before any edge fetch", async (_label, prefix) => {
		const { urls, readEdge } = edge({});
		const leg = await observeEdgeLeg(
			readEdge,
			policy,
			{
				...HLS,
				dir: {
					pattern: prefix,
					prefix,
					templated: false,
				},
			},
			"mirror-1",
			NOW,
			{ expectedChildCount: 1, currentRunPrefix: CURRENT_RUN_PREFIX },
		);
		expect(leg.closed).toBe(false);
		expect(leg.error).toMatch(/master.*directly at the MSL event root/i);
		expect(urls).toEqual([]);
	});
});

describe("observeEdgeLeg — raw-brace references and object age (WP-C6b, measured 2026-09-02)", () => {
	/**
	 * The playlist the edge served on channel 0645c2f1 named
	 * `seg-{rand_chars:8}-<n>.ts` literally. Akamai answers the RFC 3986 form
	 * (`%7B`/`%7D`) and 404s a raw `{`; the 08-21 runner's curl without `-g`
	 * mangled the braces and reported every segment 404 while they were 200
	 * (Part 6). The resolver must fetch the encoded form, keep the raw reference
	 * in evidence, and carry each object's Last-Modified.
	 */
	const braced = (n: number) => `seg-{rand_chars:8}-${n}.ts`;
	function bracedObjects(): Record<string, Served> {
		const encoded = (n: number) => `${ROOT}seg-%7Brand_chars:8%7D-${n}.ts`;
		return {
			[`${ROOT}stream.m3u8`]: [
				"#EXTM3U",
				'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
				"video_3000000.m3u8",
			].join("\n"),
			[`${ROOT}video_3000000.m3u8`]: mediaPlaylist(904, [
				braced(904),
				braced(905),
			]),
			[encoded(904)]: {
				status: 200,
				body: "ts-bytes-904",
				lastModified: "Wed, 02 Sep 2026 08:19:55 GMT",
			},
			[encoded(905)]: {
				status: 200,
				body: "ts-bytes-905",
				lastModified: "Wed, 02 Sep 2026 08:19:57 GMT",
			},
		};
	}

	it("fetches a raw-brace reference percent-encoded, keeps the raw reference in evidence, and records Last-Modified as ISO-8601", async () => {
		const { urls, readEdge } = edge(bracedObjects());
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW, {
			expectedChildCount: 1,
			runningSince: "2026-09-02T13:25:15.048Z",
		});
		expect(leg.error, leg.error).toBeUndefined();
		expect(leg.closed, JSON.stringify(leg.missing ?? leg.rejected)).toBe(true);
		// The GETs went out encoded — never with a raw `{`.
		expect(urls).toContain(`${ROOT}seg-%7Brand_chars:8%7D-904.ts`);
		expect(urls.some((u) => u.includes("{"))).toBe(false);
		const served = leg.children?.[0]?.served ?? [];
		expect(served.map((s) => s.reference)).toEqual([
			"seg-{rand_chars:8}-904.ts",
			"seg-{rand_chars:8}-905.ts",
		]);
		expect(served.map((s) => s.key)).toEqual([
			"seg-%7Brand_chars:8%7D-904.ts",
			"seg-%7Brand_chars:8%7D-905.ts",
		]);
		expect(served.map((s) => s.lastModified)).toEqual([
			"2026-09-02T08:19:55.000Z",
			"2026-09-02T08:19:57.000Z",
		]);
		// The airing's start rides on the closure for the engine's verdict.
		expect(leg.runningSince).toBe("2026-09-02T13:25:15.048Z");
	});

	it("leaves lastModified ABSENT when the edge sent none or sent garbage — never a fabricated timestamp", async () => {
		const objects = bracedObjects();
		const encoded = (n: number) => `${ROOT}seg-%7Brand_chars:8%7D-${n}.ts`;
		objects[encoded(904)] = { status: 200, body: "ts-bytes-904" };
		objects[encoded(905)] = {
			status: 200,
			body: "ts-bytes-905",
			lastModified: "not a date",
		};
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		const served = leg.children?.[0]?.served ?? [];
		expect(served).toHaveLength(2);
		expect(served.every((s) => s.lastModified === undefined)).toBe(true);
		expect(leg.runningSince).toBeUndefined();
	});
});

describe("observeEdgeLeg — the four MSL delivery topologies close (non-regression)", () => {
	it("HLS/TS separated audio (M2): master → 2 video-only + 1 audio child → every TS segment, hashed", async () => {
		const { urls, readEdge } = edge(tsSeparated());
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.error, leg.error).toBeUndefined();
		expect(leg.closed, JSON.stringify(leg.missing ?? leg.rejected)).toBe(true);
		expect(leg.childCount).toBe(3);
		expect(leg.segmentCount).toBe(6);
		expect(leg.master?.sha256).toBe(
			sha(tsSeparated()[`${ROOT}stream.m3u8`] as string),
		);
		const audio = leg.children?.find((c) => c.id === "audio_128000.m3u8");
		expect(audio?.mediaSequence).toBe(10);
		expect(audio?.served.map((s) => s.sha256)).toEqual([
			sha(TS_BYTES),
			sha(TS_BYTES),
		]);
		expect(audio?.served.every((s) => s.bytes === TS_BYTES.byteLength)).toBe(
			true,
		);
		expect(urls.every((u) => u.startsWith(ROOT))).toBe(true);
	});

	it("HLS/TS muxed audio (M3/M4): master → 2 muxed children → their TS segments", async () => {
		const { readEdge } = edge(tsMuxed());
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(leg.childCount).toBe(2);
		expect(leg.segmentCount).toBe(2);
	});

	it("HLS/fMP4: EXT-X-MAP init AND media are fetched; init is witnessed but not counted as media", async () => {
		const { urls, readEdge } = edge(fmp4Hls());
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(urls).toContain(`${ROOT}video/1080p/init.mp4`);
		const child = leg.children?.[0];
		expect(child?.served.filter((s) => s.init)).toHaveLength(1);
		expect(child?.served.filter((s) => !s.init)).toHaveLength(2);
		expect(leg.segmentCount).toBe(2);
	});

	it("DASH/fMP4: BaseURL + SegmentTemplate resolved with the MPD's own URL and the harness clock; init + media per representation", async () => {
		const { urls, readEdge } = edge(dashObjects());
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW);
		expect(
			leg.closed,
			JSON.stringify(leg.missing ?? leg.rejected ?? leg.error),
		).toBe(true);
		expect(leg.childCount).toBe(3);
		for (const id of ["1080p", "720p", "a128"]) {
			const child = leg.children?.find((c) => c.id === id);
			expect(child, id).toBeDefined();
			expect(child?.served.some((s) => s.init)).toBe(true);
			expect(child?.served.filter((s) => !s.init).length).toBeGreaterThan(0);
			// The template addressed 10 segments at NOW; the fetch is a bounded spread.
			expect(child?.listed).toBe(10);
		}
		expect(urls).toContain(`${ROOT}video/1080p/init.mp4`);
		expect(urls).toContain(`${ROOT}audio/a128/seg-1.m4s`);
		expect(urls.every((u) => u.startsWith(ROOT))).toBe(true);
	});

	it("DASH/fMP4 SegmentTimeline: fetches init and every addressed media segment", async () => {
		const objects: Record<string, Served> = {
			[`${ROOT}stream.mpd`]: segmentTimelineMpd(),
			[`${ROOT}timeline/timeline-v1/init.mp4`]: MP4_BYTES,
			[`${ROOT}timeline/timeline-v1/seg-0.m4s`]: MP4_BYTES,
			[`${ROOT}timeline/timeline-v1/seg-6.m4s`]: MP4_BYTES,
			[`${ROOT}timeline/timeline-v1/seg-12.m4s`]: MP4_BYTES,
		};
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW, {
			expectedChildCount: 1,
		});
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(leg.children?.[0]?.served.filter((s) => s.init)).toHaveLength(1);
		expect(leg.children?.[0]?.served.filter((s) => !s.init)).toHaveLength(3);
		expect(urls).toContain(`${ROOT}timeline/timeline-v1/seg-12.m4s`);
	});

	it("DASH/fMP4 SegmentList: fetches the declared init and media URLs", async () => {
		const objects: Record<string, Served> = {
			[`${ROOT}stream.mpd`]: segmentListMpd(),
			[`${ROOT}list/list-v1/init.mp4`]: MP4_BYTES,
			[`${ROOT}list/list-v1/seg-1.m4s`]: MP4_BYTES,
			[`${ROOT}list/list-v1/seg-2.m4s`]: MP4_BYTES,
		};
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW, {
			expectedChildCount: 1,
		});
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(leg.children?.[0]?.served.filter((s) => s.init)).toHaveLength(1);
		expect(leg.children?.[0]?.served.filter((s) => !s.init)).toHaveLength(2);
		expect(urls).toContain(`${ROOT}list/list-v1/init.mp4`);
		expect(urls).toContain(`${ROOT}list/list-v1/seg-2.m4s`);
	});
});

describe("observeEdgeLeg — the resolver rules (positive)", () => {
	it("follows a same-origin absolute child and a relative child", async () => {
		const objects = tsMuxed();
		const master = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
			`${ROOT}video_4500000.m3u8`,
			'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
			"video_3000000.m3u8",
		].join("\n");
		objects[`${ROOT}stream.m3u8`] = master;
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		expect(leg.childCount).toBe(2);
		expect(urls).toContain(`${ROOT}video_4500000.m3u8`);
		expect(urls).toContain(`${ROOT}video_3000000.m3u8`);
	});

	it("follows a child on another origin when that origin is an explicitly allowed root", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2"',
			"https://cdn.example/root/video_4500000.m3u8",
		].join("\n");
		objects["https://cdn.example/root/video_4500000.m3u8"] = mediaPlaylist(4, [
			"m1080-4.ts",
		]);
		objects["https://cdn.example/root/m1080-4.ts"] = TS_BYTES;
		const { readEdge } = edge(objects);
		const allowing = edgeUrlPolicy(BASE, ["https://cdn.example/root/"]);
		const leg = await observeEdgeLeg(readEdge, allowing, HLS, "mirror-1", NOW);
		expect(leg.closed, JSON.stringify(leg)).toBe(true);
		// …and NOT without the allowlist.
		const refused = await observeEdgeLeg(
			readEdge,
			policy,
			HLS,
			"mirror-1",
			NOW,
		);
		expect(refused.closed).toBe(false);
		expect(refused.rejected?.[0]).toMatch(/origin/);
	});
});

describe("observeEdgeLeg — every audit negative leaves the leg NOT closed, and names why", () => {
	it("an EMPTY master (no child playlist) is not a closure", async () => {
		const { readEdge } = edge({
			[`${ROOT}stream.m3u8`]: "#EXTM3U\n#EXT-X-VERSION:6\n",
		});
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.childCount).toBe(0);
		expect(leg.error).toMatch(/references no child playlist/);
	});

	it("a master that is served but whose children all 404 is not a closure (master 200 is not delivery)", async () => {
		const { readEdge } = edge({
			[`${ROOT}stream.m3u8`]: tsMuxed()[`${ROOT}stream.m3u8`] as string,
		});
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.childCount).toBe(2);
		expect(leg.segmentCount).toBe(0);
		expect(leg.missing?.[0]).toMatch(/HTTP 404/);
	});

	it("a plain-http child is REFUSED (scheme), not silently dropped — the audited defect", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2"',
			"http://edge.akamaized.net/hls/live/2126636/event/verify/RUN1/live-akamai-msl-storage/output/video_4500000.m3u8",
		].join("\n");
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.[0]).toMatch(/scheme http:/);
		// The audited shape: an absolute child used to be filtered OUT, which
		// walked zero children and closed. Now it counts as a child that is
		// missing, and it is never fetched.
		expect(leg.childCount).toBe(1);
		expect(urls.some((u) => u.startsWith("http://"))).toBe(false);
	});

	it("a child on a foreign origin is REFUSED (origin) and never fetched", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2"',
			"https://evil.example/steal/video_4500000.m3u8",
		].join("\n");
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.[0]).toMatch(/origin/);
		expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
	});

	it("persists no credentials from a refused manifest reference", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
			"https://viewer:password-secret@edge.akamaized.net/hls/live/2126636/event/verify/RUN1/live-akamai-msl-storage/output/video.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42c01e"',
			"https://evil.example/steal/audio.m3u8?token=query-secret",
		].join("\n");
		const leg = await observeEdgeLeg(
			edge(objects).readEdge,
			policy,
			HLS,
			"mirror-1",
			NOW,
		);
		const persisted = JSON.stringify(leg);
		expect(leg.closed).toBe(false);
		expect(persisted).not.toContain("viewer");
		expect(persisted).not.toContain("password-secret");
		expect(persisted).not.toContain("query-secret");
		expect(persisted).not.toContain("token=");
	});

	it("a ../ root escape is REFUSED (root-escape)", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2"',
			"../../../../../other-event/video_4500000.m3u8",
		].join("\n");
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.[0]).toMatch(/outside the edge root/);
	});

	it("a reference into an OLD run's prefix is a root escape — the leg's root is this run's manifest directory", async () => {
		const objects = tsMuxed();
		const old = `${BASE}verify/RUN0/live-akamai-msl-storage/output/`;
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2"',
			`${old}video_4500000.m3u8`,
		].join("\n");
		objects[`${old}video_4500000.m3u8`] = mediaPlaylist(4, ["m1080-4.ts"]);
		objects[`${old}m1080-4.ts`] = TS_BYTES;
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.[0]).toMatch(/outside the edge root/);
		expect(urls.some((u) => u.includes("RUN0"))).toBe(false);
	});

	it("a child listing ZERO segments is not a closure", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}video_3000000.m3u8`] = mediaPlaylist(4, []);
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/lists no media segment/);
	});

	it("a media segment served with ZERO bytes is not delivery", async () => {
		const objects = tsMuxed();
		objects[`${ROOT}m720-4.ts`] = { status: 200, body: "" };
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/m720-4\.ts \(HTTP 200, 0 bytes\)/);
	});

	it("ONE child missing among several fails the whole leg", async () => {
		const objects = tsSeparated();
		delete objects[`${ROOT}audio_128000.m3u8`];
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.childCount).toBe(3);
		expect(leg.missing?.join("\n")).toMatch(/audio_128000\.m3u8/);
		// The other two children still delivered — the leg is honest about which.
		const video = leg.children?.find((c) => c.id === "video_4500000.m3u8");
		expect(video?.missing).toEqual([]);
	});

	it("a child OMITTED by the master fails the submitted-plan topology even though every listed child serves media", async () => {
		const objects = tsSeparated();
		objects[`${ROOT}stream.m3u8`] = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028"',
			"video_4500000.m3u8",
			'#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42c01e"',
			"video_800000.m3u8",
		].join("\n");
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW, {
			expectedChildCount: 3,
			expectedChildIds: [
				"video_4500000.m3u8",
				"video_800000.m3u8",
				"audio_128000.m3u8",
			],
		});
		expect(leg.closed).toBe(false);
		expect(leg.childCount).toBe(2);
		expect(leg.missing?.join("\n")).toContain(
			"required child audio_128000.m3u8 was omitted by the master",
		);
	});

	it("a missing fMP4 init (EXT-X-MAP 404) is not a closure even when the media are served", async () => {
		const objects = fmp4Hls();
		delete objects[`${ROOT}video/1080p/init.mp4`];
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/init\.mp4 \(HTTP 404/);
	});

	it("an fMP4 child that OMITS EXT-X-MAP cannot lower its own init requirement", async () => {
		const objects = fmp4Hls();
		objects[`${ROOT}video_4500000.m3u8`] = mediaPlaylist(20, [
			"video/1080p/seg-20.m4s",
		]);
		const { readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW, {
			expectedChildCount: 1,
			expectedChildIds: ["video_4500000.m3u8"],
			requireInitChildIds: ["video_4500000.m3u8"],
		});
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(
			/required init reference is absent/,
		);
	});

	it("an MPD with Representations but NO segment addressing is not a closure (the audited DASH shape)", async () => {
		const { readEdge } = edge({
			[`${ROOT}stream.mpd`]: dynamicMpd({ withSegments: false }),
		});
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.segmentCount ?? 0).toBe(0);
	});

	it("a DASH representation whose init 404s is not a closure", async () => {
		const { readEdge } = edge(dashObjects({ dropInit: "720p" }));
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.missing?.join("\n")).toMatch(/720p: init\.mp4 \(HTTP 404/);
	});

	it("a DASH BaseURL on a foreign origin is REFUSED (origin) — nothing is fetched there", async () => {
		const objects = dashObjects();
		objects[`${ROOT}stream.mpd`] = dynamicMpd({
			baseUrl: "https://cdn.other.example/root/",
		});
		const { urls, readEdge } = edge(objects);
		const leg = await observeEdgeLeg(readEdge, policy, DASH, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.rejected?.[0]).toMatch(/origin/);
		expect(urls.some((u) => u.includes("cdn.other.example"))).toBe(false);
	});

	it("a master that 404s is not a closure", async () => {
		const { readEdge } = edge({});
		const leg = await observeEdgeLeg(readEdge, policy, HLS, "mirror-1", NOW);
		expect(leg.closed).toBe(false);
		expect(leg.error).toMatch(/master not served/);
	});
});

describe("closureProbe + liveEvidenceProgression — two snapshots must show media ADVANCING", () => {
	it("HLS: a later media sequence / newly served segment is progression; identical snapshots are not", async () => {
		const first = await observeEdgeLeg(
			edge(tsMuxed(4)).readEdge,
			policy,
			HLS,
			"mirror-1",
			NOW,
		);
		const same = await observeEdgeLeg(
			edge(tsMuxed(4)).readEdge,
			policy,
			HLS,
			"mirror-1",
			NOW + 12_000,
		);
		const later = await observeEdgeLeg(
			edge(tsMuxed(6)).readEdge,
			policy,
			HLS,
			"mirror-1",
			NOW + 12_000,
		);
		expect(first.closed && same.closed && later.closed).toBe(true);
		expect(
			liveEvidenceProgression(closureProbe(first), closureProbe(same)).observed,
		).toBe(false);
		expect(
			liveEvidenceProgression(closureProbe(first), closureProbe(later)),
		).toMatchObject({
			observed: true,
		});
		// Identity is by SERVED media, credential-free.
		expect(closureProbe(first).children[0]?.served[0]).toBe(
			`${ROOT}m1080-4.ts`,
		);
		expect(closureProbe(first).at).toBe(new Date(NOW).toISOString());
	});

	it("DASH: the template addresses more segments as the clock moves, but only SERVED media is progression", async () => {
		// Ten segments served at NOW. Twenty seconds later the template addresses
		// up to seg-13 — but the edge still serves only seg-1..10, so nothing NEW
		// was served: NOT progression. (An origin that died keeps a growing
		// template; the media are what advance.)
		const first = await observeEdgeLeg(
			edge(dashObjects()).readEdge,
			policy,
			DASH,
			"mirror-1",
			NOW,
		);
		const stalled = await observeEdgeLeg(
			edge(dashObjects()).readEdge,
			policy,
			DASH,
			"mirror-1",
			NOW + 20_000,
		);
		// The stalled snapshot did not even close: the spread reaches the newest
		// addressed segment, which the edge does not serve.
		expect(stalled.closed).toBe(false);
		const advanced = await observeEdgeLeg(
			edge(dashObjects({ upTo: 13 })).readEdge,
			policy,
			DASH,
			"mirror-1",
			NOW + 20_000,
		);
		expect(advanced.closed, JSON.stringify(advanced.missing)).toBe(true);
		expect(
			liveEvidenceProgression(closureProbe(first), closureProbe(advanced)),
		).toMatchObject({
			observed: true,
		});
		expect(
			liveEvidenceProgression(closureProbe(first), closureProbe(first))
				.observed,
		).toBe(false);
	});
});

describe("spread — bounded, deterministic, keeps first / middle / last", () => {
	it("returns everything under the bound and a first/middle/last-bearing sample over it", () => {
		expect(spread([1, 2, 3], 5)).toEqual([1, 2, 3]);
		const many = Array.from({ length: 100 }, (_, i) => i);
		const picked = spread(many, MAX_EDGE_MEDIA_PER_CHILD);
		expect(picked).toHaveLength(MAX_EDGE_MEDIA_PER_CHILD);
		expect(picked).toContain(0);
		expect(picked).toContain(49);
		expect(picked).toContain(99);
	});
});
