import { describe, expect, it } from "vitest";
import {
	evaluateOriginPlaylist,
	MasterPlaylistError,
	type OriginPlaylistCursor,
	originPublishState,
	parseMediaPlaylist,
} from "./origin";

/**
 *  §7 — the parser/check table. The two named kills:
 * C1: a DVR window still GROWING (sequence pinned at 0) must NOT read
 *     stale — media-sequence is a corroborator, never primary.
 * C2: a MASTER playlist must be rejected as an evaluation target.
 */

function media(opts: {
	seq?: number;
	segments: Array<{ uri: string; pdt?: string; duration?: number }>;
	endlist?: boolean;
	targetDuration?: number;
}): string {
	const lines = [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-TARGETDURATION:${opts.targetDuration ?? 6}`,
		`#EXT-X-MEDIA-SEQUENCE:${opts.seq ?? 0}`,
	];
	for (const segment of opts.segments) {
		if (segment.pdt) {
			lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.pdt}`);
		}
		lines.push(`#EXTINF:${segment.duration ?? 6.0},`);
		lines.push(segment.uri);
	}
	if (opts.endlist) {
		lines.push("#EXT-X-ENDLIST");
	}
	return lines.join("\n");
}

const MASTER = [
	"#EXTM3U",
	"#EXT-X-STREAM-INF:BANDWIDTH=3128000,RESOLUTION=1280x720",
	"video_3000000.m3u8",
].join("\n");

describe("parseMediaPlaylist", () => {
	it("reads count, tail URI, sequence, target duration and ENDLIST", () => {
		const parsed = parseMediaPlaylist(
			media({
				seq: 7,
				segments: [
					{ uri: "segment_7.m4s" },
					{ uri: "segment_8.m4s", pdt: "2026-08-23T00:00:00.000Z" },
				],
				endlist: true,
			}),
		);
		expect(parsed).toMatchObject({
			segmentCount: 2,
			lastSegmentUri: "segment_8.m4s",
			mediaSequence: 7,
			targetDurationSeconds: 6,
			hasEndlist: true,
			newestPdt: "2026-08-23T00:00:00.000Z",
		});
		expect(parsed.totalDurationSeconds).toBeCloseTo(12);
	});

	it("REJECTS a master playlist — the C2 kill", () => {
		expect(() => parseMediaPlaylist(MASTER)).toThrow(MasterPlaylistError);
	});

	it("ONCE_PER_PLAYLIST PDT: the newest segment's time = anchor + accumulated durations (review-161-162 M1)", () => {
		// 30 × 6s segments, PDT only on the FIRST — the schema's own first
		// placement mode. Reading the anchor verbatim reported the OLDEST
		// segment's time and made a healthy channel look a whole DVR window
		// behind (10803s on a C8-sized window).
		const lines = [
			"#EXTM3U",
			"#EXT-X-VERSION:7",
			"#EXT-X-TARGETDURATION:6",
			"#EXT-X-MEDIA-SEQUENCE:0",
			"#EXT-X-PROGRAM-DATE-TIME:2026-08-23T00:00:00.000Z",
		];
		for (let i = 0; i < 30; i += 1) {
			lines.push("#EXTINF:6.0,", `segment_${i}.m4s`);
		}
		const parsed = parseMediaPlaylist(lines.join("\n"));
		// Segment 29 starts 29 × 6 = 174s after the anchor.
		expect(parsed.newestPdt).toBe("2026-08-23T00:02:54.000Z");
		// And the edge delay follows the NEWEST segment, not the anchor:
		const nowMs = Date.parse("2026-08-23T00:03:00.000Z");
		const verdict = evaluateOriginPlaylist({
			parsed,
			cursor: null,
			nowMs,
			intervalMs: 10_000,
			windowPolls: 2,
		});
		expect(verdict.edgeDelaySeconds).toBe(6);
		expect(verdict.edgeDelayApproximate).toBe(false);
	});
});

describe("evaluateOriginPlaylist", () => {
	const INTERVAL = 10_000;
	const NOW = 1_000_000;

	function cursorOf(
		over: Partial<OriginPlaylistCursor> = {},
	): OriginPlaylistCursor {
		return {
			lastSegmentUri: "segment_1.m4s",
			segmentCount: 2,
			mediaSequence: 0,
			lastProgressAtMs: NOW - 60_000,
			...over,
		};
	}

	it("first observation is progress by definition — never stale on the first look", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({ segments: [{ uri: "segment_1.m4s" }] }),
			),
			cursor: null,
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.stale).toBe(false);
	});

	it("C1 kill: a GROWING window with media-sequence pinned at 0 is progress, not staleness", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({
					seq: 0,
					segments: [
						{ uri: "segment_1.m4s" },
						{ uri: "segment_2.m4s" },
						{ uri: "segment_3.m4s" },
					],
				}),
			),
			cursor: cursorOf({ segmentCount: 2, mediaSequence: 0 }),
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.stale).toBe(false);
		expect(verdict.nextCursor.lastProgressAtMs).toBe(NOW);
	});

	it("a FULL window sliding forward progresses via the sequence corroborator", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({
					seq: 5,
					segments: [{ uri: "segment_1.m4s" }, { uri: "segment_1.m4s" }],
				}),
			),
			cursor: cursorOf({
				segmentCount: 2,
				mediaSequence: 4,
				lastSegmentUri: "segment_1.m4s",
			}),
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.stale).toBe(false);
	});

	it("frozen tail URI + frozen count + frozen sequence past windowPolls × interval = STALE", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({
					seq: 0,
					segments: [{ uri: "segment_1.m4s" }, { uri: "segment_1b.m4s" }],
				}),
			),
			cursor: cursorOf({
				lastSegmentUri: "segment_1b.m4s",
				segmentCount: 2,
				mediaSequence: 0,
				lastProgressAtMs: NOW - 25_000,
			}),
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.stale).toBe(true);
		expect(verdict.sinceProgressMs).toBe(25_000);
	});

	it("under the threshold the same frozen state only accumulates — no premature CRIT", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({ segments: [{ uri: "segment_1.m4s" }] }),
			),
			cursor: cursorOf({
				lastSegmentUri: "segment_1.m4s",
				segmentCount: 1,
				lastProgressAtMs: NOW - 15_000,
			}),
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.stale).toBe(false);
		expect(verdict.sinceProgressMs).toBe(15_000);
	});

	it("ENDLIST surfaces verbatim — the RUNNING-channel CRIT is the caller's rule", () => {
		const verdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({ segments: [{ uri: "s.m4s" }], endlist: true }),
			),
			cursor: null,
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(verdict.endlist).toBe(true);
	});

	it("edge delay is PDT-derived when present, approximate otherwise", () => {
		const pdtVerdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(
				media({
					segments: [
						{ uri: "s.m4s", pdt: new Date(NOW - 90_000).toISOString() },
					],
				}),
			),
			cursor: null,
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(pdtVerdict.edgeDelaySeconds).toBe(90);
		expect(pdtVerdict.edgeDelayApproximate).toBe(false);

		const approxVerdict = evaluateOriginPlaylist({
			parsed: parseMediaPlaylist(media({ segments: [{ uri: "s.m4s" }] })),
			cursor: cursorOf({
				lastSegmentUri: "s.m4s",
				segmentCount: 1,
				lastProgressAtMs: NOW - 30_000,
			}),
			nowMs: NOW,
			intervalMs: INTERVAL,
			windowPolls: 2,
		});
		expect(approxVerdict.edgeDelayApproximate).toBe(true);
		expect(approxVerdict.edgeDelaySeconds).toBe(36);
	});
});

describe("originPublishState (ledger #253)", () => {
	it("reads the two known states out of a run's persisted observation", () => {
		expect(originPublishState({ publish: "PUBLISHED" })).toBe("PUBLISHED");
		expect(originPublishState({ publish: "AWAITING" })).toBe("AWAITING");
	});

	it("answers null for anything that is not one of them — a missing field is not a claim", () => {
		// The refusal this feeds is on AWAITING alone, so every one of these
		// must come back null: a legacy row written before the field existed
		// (cursors, no `publish`), a run nobody has observed, an unparsed
		// column, and a value from some future writer this build cannot read.
		expect(
			originPublishState({
				lastFetchAtMs: 1,
				playlists: { "a.m3u8": { segmentCount: 12 } },
			}),
		).toBeNull();
		expect(originPublishState({})).toBeNull();
		expect(originPublishState(null)).toBeNull();
		expect(originPublishState(undefined)).toBeNull();
		expect(originPublishState("AWAITING")).toBeNull();
		expect(originPublishState({ publish: "SOMETHING_ELSE" })).toBeNull();
		expect(originPublishState({ publish: true })).toBeNull();
	});
});
