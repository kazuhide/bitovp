import { describe, expect, it } from "vitest";
import {
	parseEditingHlsPlaylist,
	resolveEditingHlsKey,
	selectEditingHlsVariant,
} from "./hls-source";

const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English, primary",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"
video/small.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"
video/main.m3u8
`;
const vod = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2,
a.m4s
#EXTINF:1.5,
b.m4s
#EXT-X-ENDLIST
`;
describe("bounded local-only editing HLS parser", () => {
	it("selects a deterministic video and exact default audio group without treating quoted commas as separators", () => {
		const parsed = parseEditingHlsPlaylist(master);
		expect(parsed.kind).toBe("MASTER");
		expect(selectEditingHlsVariant(parsed)).toMatchObject({
			video: { uri: "video/main.m3u8", width: 1280, height: 720 },
			audio: { uri: "audio/en.m3u8", default: true },
		});
	});
	it("parses VOD segments and an initialization object without changing durations", () => {
		expect(parseEditingHlsPlaylist(vod)).toMatchObject({
			kind: "MEDIA",
			durationSeconds: 3.5,
			initUri: "init.mp4",
			segments: [
				{ uri: "a.m4s", duration: 2 },
				{ uri: "b.m4s", duration: 1.5 },
			],
		});
	});
	it("resolves relative siblings inside a retained output root", () => {
		expect(
			resolveEditingHlsKey("out/video/v.m3u8", "../audio/a.m3u8", "out/"),
		).toBe("out/audio/a.m3u8");
		expect(resolveEditingHlsKey("out/v.m3u8", "clip%20one.ts", "out/")).toBe(
			"out/clip one.ts",
		);
	});
	it.each([
		"https://external.invalid/a.ts",
		"//external/a.ts",
		"/root.ts",
		"../../outside.ts",
		"../%2e%2e/outside.ts",
		"file:secret",
		"data:AAAA",
		"a.ts?token=secret",
		"a.ts#x",
		"a\\b.ts",
		"%2fetc%2fpasswd",
		"bad%GG.ts",
	])("rejects unsafe or external URI %s", (uri) => {
		expect(() =>
			resolveEditingHlsKey("out/video/v.m3u8", uri, "out/"),
		).toThrow();
	});
	it.each([
		vod.replace("#EXT-X-ENDLIST", ""),
		vod.replace(
			"#EXT-X-ENDLIST",
			"#EXT-X-KEY:METHOD=AES-128,URI=key.bin\n#EXT-X-ENDLIST",
		),
		vod.replace("#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY\n#EXT-X-ENDLIST"),
		vod.replace("#EXT-X-ENDLIST", "#EXT-X-BYTERANGE:4@0\n#EXT-X-ENDLIST"),
		vod.replace("#EXTINF:2,", "#EXTINF:4000,"),
		vod.replace(
			"#EXT-X-ENDLIST",
			"#EXT-X-PART:DURATION=1,URI=part.ts\n#EXT-X-ENDLIST",
		),
	])("rejects live, encrypted, unsupported or overlong content %#", (text) => {
		expect(() => parseEditingHlsPlaylist(text)).toThrow();
	});
	it("rejects ambiguous audio groups instead of guessing a voice", () => {
		const ambiguous = master.replace(
			"#EXT-X-STREAM-INF:BANDWIDTH=500000",
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="also default",DEFAULT=YES,URI="audio/other.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000',
		);
		expect(() =>
			selectEditingHlsVariant(parseEditingHlsPlaylist(ambiguous)),
		).toThrow();
	});
	it("rejects work bounds and malformed playlists", () => {
		for (const text of [
			"not HLS",
			vod + "x".repeat(1024 * 1024),
			vod.replace("#EXTINF:2,", "#EXTINF:NaN,"),
			vod.replace("#EXT-X-ENDLIST", "orphan.ts\n#EXT-X-ENDLIST"),
		])
			expect(() => parseEditingHlsPlaylist(text)).toThrow();
	});
});

it("rejects more than 4096 segment references before any partial optimum or network capture", () => {
	const long =
		"#EXTM3U\n#EXT-X-TARGETDURATION:1\n" +
		Array.from({ length: 4097 }, (_, i) => `#EXTINF:0.1,\ns${i}.ts\n`).join(
			"",
		) +
		"#EXT-X-ENDLIST\n";
	expect(() => parseEditingHlsPlaylist(long)).toThrow("HLS_LIMIT");
});

function declaredMaster(
	high: string,
	low: string = 'CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30,VIDEO-RANGE=SDR',
) {
	return `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,${high}\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,${low}\nlow.m3u8\n`;
}
describe("declared HLS editing profile selection before native admission", () => {
	it.each([
		'CODECS="av01.0.08M.08,mp4a.40.2",FRAME-RATE=30',
		'CODECS="vp09.00.41.08,mp4a.40.2",FRAME-RATE=30',
		'CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=60',
		'CODECS="hvc1.2.4.L153.B0,mp4a.40.2",FRAME-RATE=30,VIDEO-RANGE=PQ',
		'CODECS="hvc1.2.4.L153.B0,mp4a.40.2",FRAME-RATE=30,VIDEO-RANGE=HLG',
	])("chooses the supported H264 sibling instead of declared unsupported high rendition %s", (declared) => {
		const selected = selectEditingHlsVariant(
			parseEditingHlsPlaylist(declaredMaster(declared)),
		);
		expect(selected.video).toMatchObject({
			uri: "low.m3u8",
			codecs: "avc1.4d401f,mp4a.40.2",
			frameRate: "30",
			videoRange: "SDR",
		});
	});
	it("refuses all explicitly unsupported variants with the typed unsupported code", () => {
		expect(() =>
			selectEditingHlsVariant(
				parseEditingHlsPlaylist(
					declaredMaster(
						'CODECS="av01.0.08M.08",FRAME-RATE=30',
						'CODECS="vp09.00.41.08",FRAME-RATE=60',
					),
				),
			),
		).toThrow(expect.objectContaining({ code: "HLS_UNSUPPORTED" }));
	});
	it("retains absent declarations for native probing, without inventing a rate or bit depth", () => {
		const text = declaredMaster('AUDIO="unused"').replace(
			',AUDIO="unused"',
			"",
		);
		const selected = selectEditingHlsVariant(parseEditingHlsPlaylist(text));
		expect(selected.video.uri).toBe("high.m3u8");
		expect(Object.hasOwn(selected.video, "codecs")).toBe(false);
		expect(Object.hasOwn(selected.video, "frameRate")).toBe(false);
		expect(Object.hasOwn(selected.video, "videoRange")).toBe(false);
	});
	it.each([
		"24",
		"25",
		"29.970",
		"30.000",
	])("retains supported declared frame rate %s", (frameRate) => {
		const selected = selectEditingHlsVariant(
			parseEditingHlsPlaylist(
				declaredMaster(
					`CODECS="hvc1.2.4.L153.B0",FRAME-RATE=${frameRate},VIDEO-RANGE=SDR`,
				),
			),
		);
		expect(selected.video.uri).toBe("high.m3u8");
		expect(selected.video.frameRate).toBe(frameRate);
	});
	it("leaves H264/HEVC bit-depth eligibility to native probe rather than guessing from the profile token", () => {
		for (const codec of ["hvc1.2.4.L153.B0", "avc1.6E0033"]) {
			const selected = selectEditingHlsVariant(
				parseEditingHlsPlaylist(
					declaredMaster(`CODECS="${codec}",FRAME-RATE=30`),
				),
			);
			expect(selected.video.uri).toBe("high.m3u8");
		}
	});
	it("does not use profile filtering to bypass a declared encryption tag", () => {
		expect(() =>
			parseEditingHlsPlaylist(
				declaredMaster('CODECS="av01.0.08M.08"') +
					'#EXT-X-SESSION-KEY:METHOD=AES-128,URI="secret.key"\n',
			),
		).toThrow(expect.objectContaining({ code: "HLS_UNSUPPORTED" }));
	});
});
