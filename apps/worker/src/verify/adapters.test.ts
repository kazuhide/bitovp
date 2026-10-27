import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	makeEngineDeps,
	parseDashText,
	parseHlsText,
	scanMp4Boxes,
} from "./adapters";

/**
 * The adapters against the REAL parsers and a real byte-level MP4 walker.
 *
 * The engine's self-test uses stubs, deliberately — it is testing assertion logic. This
 * file tests the other half: that `m3u8-parser` and `mpd-parser` behave the way the
 * declarations in `parsers.d.ts` claim, and that the box scanner finds `pssh`/`schm`/
 * `tenc` in bytes rather than in a mock's imagination. Two mocks agreeing proves
 * nothing; this is where the outside world gets to disagree with us.
 */

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "verify-adapters-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("parseHlsText — the real m3u8-parser", () => {
	it("reads variants, audio groups and the version from a master playlist", async () => {
		const parsed = await parseHlsText(`#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="en",DEFAULT=YES,URI="audio/128000/stream.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio"
video/720p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="audio"
video/360p/stream.m3u8
`);
		expect(parsed.variants).toHaveLength(2);
		expect(parsed.variants[0]?.bandwidth).toBe(2_200_000);
		expect(parsed.variants[0]?.uri).toBe("video/720p/stream.m3u8");
		expect(parsed.version).toBe(4);
		// The audio rendition group must survive the mediaGroups flattening.
		expect(parsed.media.map((m) => m.type)).toContain("AUDIO");
		expect(parsed.media[0]?.groupId).toBe("audio");
		// row 272: RESOLUTION and CODECS on variants, NAME on media — the fields
		// the topology binding keys on and asserts against the plan.
		expect(parsed.variants[0]?.resolution).toBe("1280x720");
		expect(parsed.variants[0]?.codecs).toBe("avc1.4d401f,mp4a.40.2");
		expect(parsed.media[0]?.name).toBe("en");
		// row 284: AUDIO is the variant's identity beside its URI — the group it
		// points at, which a `variantsPerAudioGroup` master needs to tell two rows
		// of one video muxing apart.
		expect(parsed.variants[0]?.audio).toBe("audio");
		expect(parsed.variants[1]?.audio).toBe("audio");
	});

	it("leaves `audio` absent on a self-contained variant (no AUDIO attribute)", async () => {
		const parsed = await parseHlsText(`#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
video_2200000.m3u8
`);
		expect(parsed.variants).toHaveLength(1);
		expect(parsed.variants[0]?.audio).toBeUndefined();
		expect("audio" in (parsed.variants[0] ?? {})).toBe(false);
	});

	it("reports segments for a MEDIA playlist, which has no variants", async () => {
		const parsed = await parseHlsText(`#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
segment_1.m4s
#EXTINF:4.0,
segment_2.m4s
#EXT-X-ENDLIST
`);
		expect(parsed.variants).toHaveLength(0);
		expect(parsed.segments).toBe(2);
	});

	it("does NOT throw on garbage — it returns nothing, which is why the engine checks content", async () => {
		// This is the exact behaviour that made the engine's first parse check useless.
		// Pinning it here means a future parser upgrade that DOES throw is noticed.
		const parsed = await parseHlsText("not a playlist at all");
		expect(parsed.variants).toHaveLength(0);
		expect(parsed.media).toHaveLength(0);
		expect(parsed.segments ?? 0).toBe(0);
	});
});

describe("parseDashText — the real mpd-parser, plus addressing from the document", () => {
	const MPD = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT4S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>${inner}</Period>
</MPD>`;

	it("accepts a SegmentTemplate MPD and reports TEMPLATE addressing", async () => {
		const parsed = await parseDashText(
			MPD(`
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate media="$RepresentationID$/segment_$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" startNumber="1"/>
      <Representation id="v720" bandwidth="2200000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="v360" bandwidth="700000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>`),
		);
		expect(parsed.representations).toHaveLength(2);
		expect(parsed.representations.map((r) => r.addressing)).toEqual([
			"TEMPLATE",
			"TEMPLATE",
		]);
		expect(parsed.representations[0]?.height).toBe(720);
		expect(parsed.periods).toBe(1);
		// row 272: the codec string on the representation, and the AdaptationSet's
		// codec set — the two the topology binding compares to the plan family.
		expect(parsed.representations[0]?.codecs).toBe("avc1.4d401f");
		expect(
			parsed.adaptationSets?.some(
				(s) => s.kind === "video" && s.codecs.includes("avc1.4d401f"),
			),
		).toBe(true);
	});

	it("distinguishes TIMELINE from TEMPLATE — the dash-segment-timeline contract", async () => {
		const parsed = await parseDashText(
			MPD(`
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate media="$RepresentationID$/segment_$Number$.m4s" initialization="$RepresentationID$/init.mp4">
        <SegmentTimeline><S t="0" d="96000" r="2"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v720" bandwidth="2200000" height="720"/>
    </AdaptationSet>`),
		);
		// mpd-parser normalises both into the same playlist shape — that is its job as a
		// player parser, and precisely why addressing is read from the document.
		expect(parsed.representations[0]?.addressing).toBe("TIMELINE");
	});

	it("reports BASE for an ON_DEMAND (SegmentBase) representation", async () => {
		const parsed = await parseDashText(
			MPD(`
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v720" bandwidth="2200000" height="720">
        <BaseURL>video_720p.mp4</BaseURL>
        <SegmentBase indexRange="0-1000"><Initialization range="0-800"/></SegmentBase>
      </Representation>
    </AdaptationSet>`),
		);
		expect(parsed.representations[0]?.addressing).toBe("BASE");
	});
	it("keeps repeated SegmentBase IDs bound to each period's file", async () => {
		const period = (file: string, index: number) =>
			`<Period start="PT${index * 6}S" duration="PT6S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="video" bandwidth="2000000" height="720"><BaseURL>${file}</BaseURL><SegmentBase indexRange="100-200"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet></Period>`;
		const parsed = await parseDashText(
			`<MPD type="static" mediaPresentationDuration="PT12S">${period("first.mp4", 0)}${period("second.mp4", 1)}</MPD>`,
		);
		expect(
			parsed.playlists?.map((entry) => ({
				id: entry.id,
				periodIndex: entry.periodIndex,
				baseUrl: entry.baseUrl,
				segmentUris: entry.segmentUris,
			})),
		).toEqual([
			{
				id: "video",
				periodIndex: 0,
				baseUrl: "first.mp4",
				segmentUris: ["first.mp4"],
			},
			{
				id: "video",
				periodIndex: 1,
				baseUrl: "second.mp4",
				segmentUris: ["second.mp4"],
			},
		]);
	});

	it("rejects a document with no representations — mpd-parser is stricter than m3u8-parser", async () => {
		// The asymmetry is worth pinning, because it is why the engine needs a CONTENT
		// check for HLS but gets rejection for free on DASH: mpd-parser throws
		// `INVALID_NUMBER_OF_PERIOD` on `<MPD></MPD>` before our own guard is reached,
		// while m3u8-parser happily returns an empty playlist for any text at all.
		await expect(parseDashText("<MPD></MPD>")).rejects.toThrow();
	});

	it("still guards the empty-but-valid case our own check exists for", async () => {
		// A well-formed Period with nothing in it: mpd-parser does not object, so the
		// adapter's own "no playlists" guard is the thing that catches it.
		await expect(
			parseDashText(
				'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0S"><Period></Period></MPD>',
			),
		).rejects.toThrow(/no playlists/i);
	});
});

describe("scanMp4Boxes — a real byte walker", () => {
	/** Build a box: 4-byte big-endian size, 4-byte type, then the body. */
	function box(type: string, body: Buffer): Buffer {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(8 + body.length, 0);
		head.write(type, 4, "latin1");
		return Buffer.concat([head, body]);
	}

	const WIDEVINE = "edef8ba979d64acea3c827dcd51d21ed";
	const KID = "43214321432143214321432143214321";

	/** `pssh`: version+flags, then the 16-byte system id, then data. */
	const pssh = (systemIdHex: string) =>
		box(
			"pssh",
			Buffer.concat([
				Buffer.from([0, 0, 0, 0]),
				Buffer.from(systemIdHex, "hex"),
				Buffer.from([0, 0, 0, 0]),
			]),
		);

	/** `schm`: version+flags, 4-byte scheme type, 4-byte version. */
	const schm = (scheme: string) =>
		box(
			"schm",
			Buffer.concat([
				Buffer.from([0, 0, 0, 0]),
				Buffer.from(scheme, "latin1"),
				Buffer.from([0, 1, 0, 0]),
			]),
		);

	/** `tenc`: version+flags, reserved, reserved, isProtected, IV size, 16-byte KID. */
	const tenc = (ivSize: number, kidHex: string) =>
		box(
			"tenc",
			Buffer.concat([
				Buffer.from([0, 0, 0, 0, 0, 0, 1, ivSize]),
				Buffer.from(kidHex, "hex"),
			]),
		);

	async function write(name: string, buf: Buffer): Promise<string> {
		const path = join(dir, name);
		await writeFile(path, buf);
		return path;
	}

	it("finds pssh, schm and tenc nested the way a real init segment nests them", async () => {
		// moov > trak > mdia > minf > stbl > stsd(+8) > encv(+78) > sinf > schm/schi > tenc
		const inner = box(
			"moov",
			Buffer.concat([
				pssh(WIDEVINE),
				box(
					"trak",
					box(
						"mdia",
						box(
							"minf",
							box(
								"stbl",
								box(
									"stsd",
									Buffer.concat([
										Buffer.alloc(8), // stsd preamble: version/flags + entry count
										box(
											"encv",
											Buffer.concat([
												Buffer.alloc(78), // VisualSampleEntry preamble
												box(
													"sinf",
													Buffer.concat([
														schm("cenc"),
														box("schi", tenc(8, KID)),
													]),
												),
											]),
										),
									]),
								),
							),
						),
					),
				),
			]),
		);
		const path = await write("init-cenc.mp4", inner);
		const facts = await scanMp4Boxes(path);
		expect(facts.psshSystemIds).toEqual([WIDEVINE]);
		expect(facts.schemeType).toBe("cenc");
		expect(facts.ivSizeBytes).toBe(8);
		expect(facts.defaultKid).toBe(KID);
	});

	it("reads a cbcs / 16-byte-IV segment, so the C9 pairing can be checked either way", async () => {
		const path = await write(
			"init-cbcs.mp4",
			box("moov", Buffer.concat([schm("cbcs"), tenc(16, KID)])),
		);
		const facts = await scanMp4Boxes(path);
		expect(facts.schemeType).toBe("cbcs");
		expect(facts.ivSizeBytes).toBe(16);
	});

	it("finds every pssh when several DRM systems are present", async () => {
		const PLAYREADY = "9a04f07998404286ab92e65be0885f95";
		const path = await write(
			"init-multi.mp4",
			box("moov", Buffer.concat([pssh(WIDEVINE), pssh(PLAYREADY)])),
		);
		const facts = await scanMp4Boxes(path);
		expect(facts.psshSystemIds).toEqual([WIDEVINE, PLAYREADY]);
	});

	it("reports nothing for an unencrypted segment instead of inventing boxes", async () => {
		const path = await write(
			"init-clear.mp4",
			box("moov", box("trak", box("mdia", Buffer.alloc(16)))),
		);
		const facts = await scanMp4Boxes(path);
		expect(facts.psshSystemIds).toEqual([]);
		expect(facts.schemeType).toBeUndefined();
		expect(facts.ivSizeBytes).toBeUndefined();
	});

	it("survives a 64-bit extended box size", async () => {
		// size === 1 means "the real size is the next 8 bytes". A walker that ignores
		// this reads the type as garbage and silently stops.
		const body = Buffer.concat([pssh(WIDEVINE)]);
		const head = Buffer.alloc(16);
		head.writeUInt32BE(1, 0);
		head.write("moov", 4, "latin1");
		head.writeBigUInt64BE(BigInt(16 + body.length), 8);
		const path = await write("init-64bit.mp4", Buffer.concat([head, body]));
		const facts = await scanMp4Boxes(path);
		expect(facts.psshSystemIds).toEqual([WIDEVINE]);
	});

	it("stops instead of looping when a box declares a size past the end", async () => {
		// A truncated download must not hang the verifier.
		const buf = Buffer.alloc(16);
		buf.writeUInt32BE(9_999_999, 0);
		buf.write("moov", 4, "latin1");
		const path = await write("init-truncated.mp4", buf);
		await expect(scanMp4Boxes(path)).resolves.toEqual({ psshSystemIds: [] });
	});
});

describe("what the parsers hand the media-byte closure (re-audit BLOCKER-4, ledger #229; sets for #228)", () => {
	it("an fMP4 media playlist yields its EXT-X-MAP and every segment URI in order", async () => {
		const parsed = await parseHlsText(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:6",
				"#EXT-X-TARGETDURATION:4",
				'#EXT-X-MAP:URI="init.mp4"',
				"#EXTINF:4.0,",
				"segment_0.m4s",
				"#EXTINF:4.0,",
				"segment_1.m4s",
				"#EXTINF:2.0,",
				"segment_2.m4s",
				"#EXT-X-ENDLIST",
			].join("\n"),
		);
		expect(parsed.segments).toBe(3);
		expect(parsed.segmentUris).toEqual([
			"segment_0.m4s",
			"segment_1.m4s",
			"segment_2.m4s",
		]);
		expect(parsed.mapUri).toBe("init.mp4");
	});
	it("a TS media playlist has segment URIs and no map; a master has neither", async () => {
		const ts = await parseHlsText(
			[
				"#EXTM3U",
				"#EXT-X-TARGETDURATION:4",
				"#EXTINF:4.0,",
				"seg0.ts",
				"#EXT-X-ENDLIST",
			].join("\n"),
		);
		expect(ts.segmentUris).toEqual(["seg0.ts"]);
		expect(ts.mapUri).toBeUndefined();
		const master = await parseHlsText(
			[
				"#EXTM3U",
				"#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360",
				"video_360.m3u8",
			].join("\n"),
		);
		expect(master.segmentUris).toBeUndefined();
	});
	const MPD = (sets: string) => `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-live:2011" mediaPresentationDuration="PT10S" minBufferTime="PT2S">
  <Period>
${sets}
  </Period>
</MPD>`;
	const videoSet = (
		id: string,
		codecs: string,
		reps: { id: string; bw: number; h: number }[],
	) => `    <AdaptationSet id="${id}" contentType="video" mimeType="video/mp4" segmentAlignment="true">
${reps
	.map(
		(
			r,
		) => `      <Representation id="${r.id}" bandwidth="${r.bw}" width="${Math.round((r.h * 16) / 9)}" height="${r.h}" codecs="${codecs}">
        <SegmentTemplate media="video/${r.id}/seg-$Number$.m4s" initialization="video/${r.id}/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>`,
	)
	.join("\n")}
    </AdaptationSet>`;
	const audioSet = `    <AdaptationSet id="a" contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a128" bandwidth="128000" audioSamplingRate="48000" codecs="mp4a.40.2">
        <SegmentTemplate media="audio/a128/seg-$Number$.m4s" initialization="audio/a128/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>`;
	it("resolves every segment of every representation, with the init, for video AND audio", async () => {
		const parsed = await parseDashText(
			MPD(
				`${videoSet("v", "avc1.640028", [
					{ id: "v1080", bw: 4500000, h: 1080 },
					{ id: "v720", bw: 2500000, h: 720 },
				])}\n${audioSet}`,
			),
		);
		const byId = new Map((parsed.playlists ?? []).map((p) => [p.id, p]));
		expect([...byId.keys()].sort()).toEqual(["a128", "v1080", "v720"]);
		expect(byId.get("v1080")?.kind).toBe("video");
		expect(byId.get("a128")?.kind).toBe("audio");
		expect(byId.get("v1080")?.mapUri).toBe("video/v1080/init.mp4");
		expect(byId.get("v1080")?.segmentUris).toEqual(
			[1, 2, 3, 4, 5].map((n) => `video/v1080/seg-${n}.m4s`),
		);
		expect(byId.get("a128")?.segmentUris).toHaveLength(5);
		expect(byId.get("a128")?.mapUri).toBe("audio/a128/init.mp4");
	});
	it("reports the codecs per AdaptationSet — one codec per set is the contract, two in one is paid case F", async () => {
		const clean = await parseDashText(
			MPD(
				`${videoSet("v264", "avc1.640028", [{ id: "h264", bw: 4500000, h: 1080 }])}\n${videoSet("v265", "hvc1.1.6.L153.90", [{ id: "h265", bw: 3000000, h: 1080 }])}\n${audioSet}`,
			),
		);
		expect(clean.adaptationSets).toEqual([
			{ kind: "video", codecs: ["avc1.640028"] },
			{ kind: "video", codecs: ["hvc1.1.6.L153.90"] },
			{ kind: "audio", codecs: ["mp4a.40.2"] },
		]);
		const caseF = await parseDashText(
			MPD(`    <AdaptationSet id="v" contentType="video" mimeType="video/mp4">
      <Representation id="h264" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028">
        <SegmentTemplate media="v/h264/seg-$Number$.m4s" initialization="v/h264/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>
      <Representation id="h265" bandwidth="3000000" width="1920" height="1080" codecs="hvc1.1.6.L153.90">
        <SegmentTemplate media="v/h265/seg-$Number$.m4s" initialization="v/h265/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>`),
		);
		expect(caseF.adaptationSets).toEqual([
			{ kind: "video", codecs: ["avc1.640028", "hvc1.1.6.L153.90"] },
		]);
	});
});

/**
 * The listing's `lastModified` must survive the trip to the foreign-key filter.
 *
 * `--strict-prefix`'s WHEN arm is the half a name test cannot replace, and it
 * reads a field the ENGINE passes as the filter's second argument. `AdapterConfig`
 * declared that filter as `(key: string) => boolean` — lossier than the value it
 * forwards — so a tidying pass that made the adapter agree with its own type would
 * have deleted the arm with nothing red. This walks the real wiring instead of the
 * declaration.
 */
describe("makeEngineDeps forwards the object entry, not just its key", () => {
	it("hands the filter the lastModified the driver reported", async () => {
		const seen: { key: string; lastModified?: string }[] = [];
		const deps = makeEngineDeps({
			outputFor: () => ({
				bucket: "b",
				browser: {
					listObjects: async () => ({
						objects: [
							{
								key: "out/seg_1.ts",
								size: 10,
								lastModified: "2026-06-21T10:00:00.000Z",
							},
						],
					}),
				} as never,
			}),
			scratchDir: "/tmp",
			ffprobePath: "ffprobe",
			foreignKeyFilter: (key, entry) => {
				seen.push({
					key,
					...(entry?.lastModified !== undefined
						? { lastModified: entry.lastModified }
						: {}),
				});
				return false;
			},
		});
		const listed = await deps.listAll("origin", "out/");
		expect(listed[0]?.lastModified).toBe("2026-06-21T10:00:00.000Z");
		// The engine is what calls the filter; call it exactly as the engine does.
		for (const o of listed) {
			deps.foreignKeyFilter?.(o.key, o);
		}
		expect(seen).toEqual([
			{ key: "out/seg_1.ts", lastModified: "2026-06-21T10:00:00.000Z" },
		]);
	});
});
