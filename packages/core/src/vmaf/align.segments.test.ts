import { describe, expect, it } from "vitest";
import {
	alignLoopedSegments,
	alignLoopedSignatures,
	DEFAULT_INCLUDE_CONFIDENCE,
	type SegmentAlignment,
} from "./align";
import { sourceMaskOf, timelineFromContainerProbe } from "./loop-timeline";

/**
 *  — the per-segment, full-period aligner. The first arm pins the
 * defect's MECHANISM: a source pushed on a 301-frame container period read
 * against its 271-frame video period cannot hold an offset for more than one
 * loop, while the same window aligned on the pushed timeline (holes masked)
 * is stable in every segment. Then: one broken segment costs one segment;
 * the offset is found anywhere in [0, F) with no anchor; a window nobody can
 * align says so; and the input contract throws.
 */
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}
function makeSource(f: number): number[] {
	const out = new Array<number>(f);
	for (let i = 0; i < f; i++) {
		out[i] =
			128 +
			40 * Math.sin((2 * Math.PI * i) / 37.0) +
			25 * Math.sin((2 * Math.PI * i) / 11.3 + 0.6) +
			15 * Math.sin((2 * Math.PI * i) / 5.7 + 1.7) +
			8 * Math.sin((2 * Math.PI * i) / 2.3 + 0.2);
	}
	return out;
}
/** `distorted[i] = ring[(i + offset) mod ring.length] + noise` */
function capture(
	ring: number[],
	offset: number,
	length: number,
	opts: { noise?: number; seed?: number } = {},
): number[] {
	const f = ring.length;
	const rng = makeRng(opts.seed ?? 12345);
	const noise = opts.noise ?? 0;
	return Array.from({ length }, (_, i) => {
		const s = ring[(((i + offset) % f) + f) % f] as number;
		return s + (noise === 0 ? 0 : (rng() - 0.5) * 2 * noise);
	});
}
const ringDistance = (a: number, b: number, f: number) =>
	Math.min((((a - b) % f) + f) % f, (((b - a) % f) + f) % f);

/** The  source: 271 video frames pushed on a 301-frame container loop, the hole holding the last frame. */
const VIDEO_FRAMES = 271;
const PUSHED_FRAMES = 301;
const video = makeSource(VIDEO_FRAMES);
const pushed = [
	...new Array<number>(PUSHED_FRAMES - VIDEO_FRAMES).fill(
		video[VIDEO_FRAMES - 1] as number,
	),
	...video,
];
const timeline = timelineFromContainerProbe(
	{
		durationSec: 10.04,
		videoStartSec: 1.0,
		videoDurationSec: VIDEO_FRAMES / 30,
	},
	30,
);

describe("alignLoopedSegments — the legacy-hole contrast (row #256)", () => {
	const window = capture(pushed, 40, 1800, { noise: 1.5 });

	it("aligned on the pushed timeline with the hole masked: every 2 s segment agrees to ±1, high confidence, no drift", () => {
		const result = alignLoopedSegments(pushed, window, {
			segmentFrames: 60,
			mask: sourceMaskOf(timeline),
		});
		expect(ringDistance(result.offset, 40, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		expect(result.segments).toHaveLength(30);
		for (const seg of result.segments) {
			expect(seg.included).toBe(true);
			expect(seg.confidence).toBeGreaterThanOrEqual(0.9);
			expect(ringDistance(seg.offset, 40, PUSHED_FRAMES)).toBeLessThanOrEqual(
				1,
			);
		}
		expect(result.drift.detected).toBe(false);
		expect(result.includedFrames).toBe(1800);
		expect(result.includedSegments).toBe(30);
		expect(result.loopMap.length).toBeGreaterThanOrEqual(6);
		expect(result.sourceIndexAt(0)).toBe(result.offset);
	});

	it("aligned on the VIDEO period (today's assumption) the offset walks ~30 frames per loop: the aligner cannot hold it", () => {
		const legacy = alignLoopedSignatures(video, window, { segmentCount: 6 });
		// Six 300-frame segments straddle six 301-frame loops; each loop shifts the
		// best 271-period offset by the 30-frame hole, so the spread across the
		// window is tens of frames — the  symptom, as a number.
		expect(legacy.drift.maxDriftFrames).toBeGreaterThanOrEqual(25);
		expect(legacy.drift.detected).toBe(true);
		// and the same walk is visible per segment through the new aligner too
		const perSegment = alignLoopedSegments(video, window, {
			segmentFrames: 300,
		});
		const offsets = perSegment.segments.map((s) => s.offset);
		const spread = Math.max(...offsets) - Math.min(...offsets);
		expect(spread).toBeGreaterThanOrEqual(25);
	});
});

describe("alignLoopedSegments — the mask is applied", () => {
	it("frames the encoder shows during the hole (black) are kept out of the score, so masked confidence beats unmasked", () => {
		// The VMAF side's ring holds the LAST frame during the hole (the fps
		// filter's duplicate); the encoder actually emitted black there.
		const black = pushed.map((v, i) =>
			i < PUSHED_FRAMES - VIDEO_FRAMES ? 16 : v,
		);
		const window = capture(black, 40, 1800, { noise: 1.5 });
		const masked = alignLoopedSegments(pushed, window, {
			segmentFrames: 60,
			mask: sourceMaskOf(timeline),
		});
		const unmasked = alignLoopedSegments(pushed, window, { segmentFrames: 60 });
		expect(ringDistance(masked.offset, 40, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		expect(masked.segments.every((s) => s.confidence >= 0.9)).toBe(true);
		const worstUnmasked = Math.min(
			...unmasked.segments.map((s) => s.confidence),
		);
		const worstMasked = Math.min(...masked.segments.map((s) => s.confidence));
		// Only the segments overlapping the hole differ, so the WORST segment
		// carries the evidence (the window median comes from clean segments).
		expect(worstMasked).toBeGreaterThan(worstUnmasked);
		expect(worstMasked - worstUnmasked).toBeGreaterThan(0.01);
	});
});

describe("alignLoopedSegments — rev427 C1: a tiny comparable remainder never wins, and the floor costs no coverage", () => {
	function holeRing(holeFrames: number) {
		const tl = timelineFromContainerProbe(
			{
				durationSec: 10.04,
				videoStartSec: holeFrames / 30,
				videoDurationSec: (301 - holeFrames) / 30,
			},
			30,
		);
		const videoPart = makeSource(301 - holeFrames);
		const ring = [...new Array<number>(holeFrames).fill(16), ...videoPart];
		return { tl, ring, mask: sourceMaskOf(tl) };
	}
	/** Frames of `[start, end)` that map outside `[0, holeFrames)` at `offset`. */
	const comparable = (
		start: number,
		end: number,
		offset: number,
		holeFrames: number,
	) => {
		let n = 0;
		for (let i = start; i < end; i++) {
			if ((i + offset) % 301 >= holeFrames) n += 1;
		}
		return n;
	};

	it("with a hole longer than a segment (3 s video start, 2 s segments), no segment is included at a wrong offset over 20 seeds", () => {
		const { tl, ring, mask } = holeRing(90);
		expect(tl.holes).toEqual([{ fromFrame: 0, toFrame: 90 }]);
		let includedWrong = 0;
		let included = 0;
		for (let seed = 1; seed <= 20; seed++) {
			const window = capture(ring, 40, 1800, { noise: 1.5, seed });
			const result = alignLoopedSegments(ring, window, {
				segmentFrames: 60,
				mask,
			});
			for (const seg of result.segments) {
				if (!seg.included) continue;
				included += 1;
				if (ringDistance(seg.offset, 40, 301) > 1) includedWrong += 1;
			}
			expect(ringDistance(result.offset, 40, 301)).toBeLessThanOrEqual(1);
			// the number that explains an exclusion is the reference share at
			// the WINDOW offset — small for a mostly-hole segment
			for (const seg of result.segments) {
				expect(seg.comparableAtWindowOffset).toBe(
					comparable(seg.frameStart, seg.frameEnd, result.offset, 90),
				);
				if (!seg.included) {
					expect(seg.comparableAtWindowOffset).toBeLessThan(30);
				}
			}
		}
		expect(includedWrong).toBe(0);
		expect(included).toBeGreaterThan(0);
	});

	it("pins comparableFrames exactly: a segment fully in the video sees all 60, a straddling one its true count", () => {
		const { ring, mask } = holeRing(30);
		const window = capture(ring, 40, 1800, { noise: 1.5, seed: 3 });
		const result = alignLoopedSegments(ring, window, {
			segmentFrames: 60,
			mask,
		});
		expect(result.segments.every((s) => s.included)).toBe(true);
		for (const seg of result.segments) {
			expect(seg.comparableFrames).toBe(
				comparable(seg.frameStart, seg.frameEnd, seg.offset, 30),
			);
		}
		const fullyInVideo = result.segments.find((s) => s.comparableFrames === 60);
		const straddling = result.segments.find((s) => s.comparableFrames < 60);
		expect(fullyInVideo).toBeDefined();
		expect(straddling).toBeDefined();
		expect(straddling?.comparableFrames).toBeGreaterThanOrEqual(30);
	});

	it("keeps full coverage for holes of 31 and 45 frames (the half-slice floor tried first dropped a fifth of the window at 31)", () => {
		for (const holeFrames of [31, 45]) {
			const { ring, mask } = holeRing(holeFrames);
			for (let seed = 1; seed <= 5; seed++) {
				const window = capture(ring, 40, 1800, { noise: 1.5, seed });
				const result = alignLoopedSegments(ring, window, {
					segmentFrames: 60,
					mask,
				});
				expect(result.includedSegments).toBe(30);
				expect(ringDistance(result.offset, 40, 301)).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("alignLoopedSegments — a tail shorter than five frames never aligns on its own (round 4)", () => {
	it("a 3- or 4-frame tail is excluded on BOTH paths; a 5-frame tail is included within ±1", () => {
		const source = makeSource(PUSHED_FRAMES);
		const tl = timelineFromContainerProbe(
			{ durationSec: 10.04, videoStartSec: 1.0, videoDurationSec: 271 / 30 },
			30,
		);
		const holeRing = [...new Array<number>(30).fill(16), ...makeSource(271)];
		const mask = sourceMaskOf(tl);
		for (const tail of [3, 4]) {
			for (const [ring, opts] of [
				[source, { segmentFrames: 60 }],
				[holeRing, { segmentFrames: 60, mask }],
			] as const) {
				const window = capture(ring, 40, 1800 + tail, { noise: 1.5, seed: 11 });
				const result = alignLoopedSegments(ring, window, opts);
				const last = result.segments[
					result.segments.length - 1
				] as SegmentAlignment;
				expect(last.frameEnd - last.frameStart).toBe(tail);
				expect(last.included).toBe(false);
				expect(last.confidence).toBe(0);
				expect(result.includedSegments).toBe(30);
			}
		}
		for (const [ring, opts] of [
			[source, { segmentFrames: 60 }],
			[holeRing, { segmentFrames: 60, mask }],
		] as const) {
			const window = capture(ring, 40, 1805, { noise: 1.5, seed: 11 });
			const result = alignLoopedSegments(ring, window, opts);
			const last = result.segments[
				result.segments.length - 1
			] as SegmentAlignment;
			expect(last.frameEnd - last.frameStart).toBe(5);
			expect(last.included).toBe(true);
			expect(ringDistance(last.offset, 40, PUSHED_FRAMES)).toBeLessThanOrEqual(
				1,
			);
		}
	});
});

describe("alignLoopedSegments — a bimodal window is not a confident window", () => {
	it("two clusters of confident segments: the confidence is halved and the drift names the spread", () => {
		const source = makeSource(PUSHED_FRAMES);
		const window: number[] = [];
		[10, 10, 160, 160].forEach((off, k) => {
			for (let j = 0; j < 300; j++) {
				const i = k * 300 + j;
				window.push(
					source[
						(((i + off) % PUSHED_FRAMES) + PUSHED_FRAMES) % PUSHED_FRAMES
					] as number,
				);
			}
		});
		const result = alignLoopedSegments(source, window, { segmentFrames: 300 });
		expect(result.includedSegments).toBe(4);
		expect(result.agreeingSegments).toBe(2);
		expect(result.confidence).toBeLessThanOrEqual(0.5);
		// no agreeing majority: the gate a caller must use (0.5 alone passes a
		// noise-free 2-vs-2 window)
		expect(result.agreeingSegments * 2).toBeLessThanOrEqual(
			result.includedSegments,
		);
		expect(result.drift.detected).toBe(true);
		expect(result.drift.maxDriftFrames).toBeGreaterThanOrEqual(140);
	});
});

describe("alignLoopedSegments — rev427 R1: the ring median does not depend on segment order", () => {
	const source = makeSource(PUSHED_FRAMES);
	/**
	 * A window whose k-th 300-frame segment shows the source at `offsets[k]` —
	 * in the aligner's convention, `distorted[i] = source[(i + offset) mod F]`
	 * with the GLOBAL frame index i, so each segment is generated in place.
	 */
	function windowWithOffsets(offsets: number[]): number[] {
		const rng = makeRng(4242);
		const out: number[] = [];
		offsets.forEach((off, k) => {
			for (let j = 0; j < 300; j++) {
				const i = k * 300 + j;
				const s = source[
					(((i + off) % PUSHED_FRAMES) + PUSHED_FRAMES) % PUSHED_FRAMES
				] as number;
				out.push(s + (rng() - 0.5) * 2);
			}
		});
		return out;
	}

	it("segments straddling the F−1 → 0 boundary yield an offset on the boundary, not the far side of the ring", () => {
		const result = alignLoopedSegments(
			source,
			windowWithOffsets([299, 300, 0, 1]),
			{
				segmentFrames: 300,
			},
		);
		expect(result.segments.map((s) => s.offset)).toEqual([299, 300, 0, 1]);
		expect(ringDistance(result.offset, 300, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		// unwrapped, so the drift is the 3-frame spread — not a ~301-frame jump
		expect(result.drift.maxDriftFrames).toBeLessThanOrEqual(3);
		expect(
			result.drift.perSegmentOffsets.every((o) => Math.abs(o - 300) <= 3),
		).toBe(true);
	});

	it("an outlier FIRST does not become the anchor: the cluster still wins", () => {
		const first = alignLoopedSegments(
			source,
			windowWithOffsets([150, 299, 300, 0, 1]),
			{
				segmentFrames: 300,
			},
		);
		const last = alignLoopedSegments(
			source,
			windowWithOffsets([299, 300, 0, 1, 150]),
			{
				segmentFrames: 300,
			},
		);
		expect(ringDistance(first.offset, 300, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		expect(ringDistance(last.offset, 300, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		expect(first.drift.detected).toBe(true);
	});
});

describe("alignLoopedSegments — isolation, full-period search, refusal", () => {
	const source = makeSource(PUSHED_FRAMES);

	it("one segment of noise is excluded alone; the window offset and the other segments are untouched", () => {
		const clean = capture(source, 123, 1800, { noise: 1 });
		const rng = makeRng(7);
		const broken = clean.map((v, i) =>
			i >= 900 && i < 1200 ? 128 + (rng() - 0.5) * 80 : v,
		);
		const result = alignLoopedSegments(source, broken, { segmentFrames: 300 });
		expect(result.segments.map((s) => s.included)).toEqual([
			true,
			true,
			true,
			false,
			true,
			true,
		]);
		expect(
			(result.segments[3] as { confidence: number }).confidence,
		).toBeLessThan(DEFAULT_INCLUDE_CONFIDENCE);
		expect(ringDistance(result.offset, 123, PUSHED_FRAMES)).toBeLessThanOrEqual(
			1,
		);
		expect(result.includedFrames).toBe(1500);
		expect(result.includedSegments).toBe(5);
		expect(result.drift.perSegmentOffsets).toHaveLength(6);
		expect(result.drift.detected).toBe(false);
	});

	it("finds an offset anywhere in [0, F) with no anchor — including the F−1 wrap boundary", () => {
		for (const truth of [0, 40, 150, PUSHED_FRAMES - 1]) {
			const result = alignLoopedSegments(source, capture(source, truth, 900), {
				segmentFrames: 90,
			});
			expect(
				ringDistance(result.offset, truth, PUSHED_FRAMES),
			).toBeLessThanOrEqual(1);
			expect(result.confidence).toBeGreaterThanOrEqual(0.9);
		}
	});

	it("a window nobody can align reports no included segment and a low confidence", () => {
		const rng = makeRng(99);
		const noise = Array.from({ length: 600 }, () => 128 + (rng() - 0.5) * 80);
		const result = alignLoopedSegments(source, noise, { segmentFrames: 100 });
		expect(result.includedSegments).toBe(0);
		expect(result.includedFrames).toBe(0);
		expect(result.confidence).toBeLessThan(DEFAULT_INCLUDE_CONFIDENCE);
		expect(result.drift.maxDriftFrames).toBe(0);
	});

	it("a partial last segment is aligned on its own frames", () => {
		const result = alignLoopedSegments(source, capture(source, 10, 650), {
			segmentFrames: 300,
		});
		expect(result.segments.map((s) => [s.frameStart, s.frameEnd])).toEqual([
			[0, 300],
			[300, 600],
			[600, 650],
		]);
		expect(result.segments.every((s) => s.included)).toBe(true);
	});

	it("throws on an empty input, a non-positive segment length, a mask of the wrong length, or an all-masked source", () => {
		expect(() => alignLoopedSegments([], [1, 2], { segmentFrames: 1 })).toThrow(
			/non-empty source/,
		);
		expect(() => alignLoopedSegments([1, 2], [], { segmentFrames: 1 })).toThrow(
			/non-empty distorted/,
		);
		expect(() =>
			alignLoopedSegments(source, [1, 2, 3], { segmentFrames: 0 }),
		).toThrow(/segmentFrames/);
		expect(() =>
			alignLoopedSegments(source, [1, 2, 3], {
				segmentFrames: 1,
				mask: [true],
			}),
		).toThrow(/mask has 1 entries/);
		expect(() =>
			alignLoopedSegments(source, [1, 2, 3], {
				segmentFrames: 1,
				mask: new Array<boolean>(PUSHED_FRAMES).fill(true),
			}),
		).toThrow(/every source frame is masked/);
	});
});
