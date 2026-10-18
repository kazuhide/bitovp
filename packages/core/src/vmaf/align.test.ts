import { describe, expect, it } from "vitest";
import {
	alignLoopedSignatures,
	DEFAULT_SEARCH_RADIUS,
	DEFAULT_SEGMENT_COUNT,
} from "./align";

/**
 * Synthetic proof of the pseudo-live alignment math. Everything here is
 * DETERMINISTIC — no Math.random at runtime (the workflow forbids it): the
 * source signal is a fixed sum of sines and all noise comes from a seeded LCG.
 *
 * What this proves: given per-frame signatures, the engine recovers the
 * unknown loop offset to ±1 frame, scores its confidence (high for a real
 * match, low for noise), detects a gradual drift, and emits a correct
 * source-loop wrap map. What it does NOT prove: that REAL average-luma
 * signatures extracted from REAL captured frames are this discriminative, or
 * that B-frame reorder / encoder latency stay within the ±1-frame caveat —
 * that is the integration PR (PR6b), which feeds real signatures into this
 * same function.
 */

/** Seeded LCG (Numerical Recipes constants) → deterministic [0,1) noise. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * A discriminative, non-trivially-periodic-within-F source signal: a sum of
 * sines whose frequencies are mutually incommensurate over the period, so no
 * two distinct offsets in [0,F) produce a near-identical slice (the alignment
 * peak is sharp). Values land in a luma-like positive range so the test data
 * resembles the real signature domain, but the math zero-means anyway.
 */
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

/**
 * Build a captured window of `length` output frames from a looping source at a
 * KNOWN constant offset, with small seeded additive noise (amplitude `noise`).
 * `distorted[i] = source[(i+offset) mod F] + (gain·) + level + noise`. The
 * optional `level`/`gain` inject a DC and contrast shift to prove the
 * zero-mean / normalized-correlation robustness.
 */
function makeDistorted(
	source: number[],
	offset: number,
	length: number,
	opts: { noise?: number; level?: number; gain?: number; seed?: number } = {},
): number[] {
	const f = source.length;
	const noise = opts.noise ?? 0;
	const level = opts.level ?? 0;
	const gain = opts.gain ?? 1;
	const rng = makeRng(opts.seed ?? 12345);
	const out = new Array<number>(length);
	for (let i = 0; i < length; i++) {
		const s = source[(((i + offset) % f) + f) % f] as number;
		const jitter = noise === 0 ? 0 : (rng() - 0.5) * 2 * noise;
		out[i] = gain * s + level + jitter;
	}
	return out;
}

/**
 * Build a captured window whose offset RAMPS over the window (drift): the
 * effective offset starts at `startOffset` and increases by `+ramp` every
 * `1/segments` of the window — i.e. a piecewise-constant ramp of total
 * `ramp·(segments−1)` frames end-to-end.
 */
function makeDrifting(
	source: number[],
	startOffset: number,
	length: number,
	segments: number,
	ramp: number,
	opts: { noise?: number; seed?: number } = {},
): number[] {
	const f = source.length;
	const noise = opts.noise ?? 0;
	const rng = makeRng(opts.seed ?? 999);
	const out = new Array<number>(length);
	for (let i = 0; i < length; i++) {
		const seg = Math.min(segments - 1, Math.floor((i * segments) / length));
		const eff = startOffset + ramp * seg;
		const s = source[(((i + eff) % f) + f) % f] as number;
		const jitter = noise === 0 ? 0 : (rng() - 0.5) * 2 * noise;
		out[i] = s + jitter;
	}
	return out;
}

describe("alignLoopedSignatures — known-offset recovery (≥3 loops)", () => {
	const F = 150;
	const KNOWN = 57;
	const LOOPS = 3.5; // 3 full loops + a partial → ≥3 wrap entries
	const source = makeSource(F);
	const W = Math.round(F * LOOPS);

	it("recovers the known offset to ±1, high confidence, no drift, ≥3 loop entries", () => {
		const distorted = makeDistorted(source, KNOWN, W, {
			noise: 3,
			seed: 7,
		});
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: KNOWN + 20, // anchor a bit off; radius must still find it
			searchRadius: DEFAULT_SEARCH_RADIUS,
		});

		expect(Math.abs(r.offset - KNOWN)).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.85);
		expect(r.drift.detected).toBe(false);
		expect(r.drift.maxDriftFrames).toBeLessThanOrEqual(1);

		// ≥3 loop-map entries with incrementing loopIndex and correct wraps.
		expect(r.loopMap.length).toBeGreaterThanOrEqual(3);
		r.loopMap.forEach((e, idx) => {
			expect(e.loopIndex).toBe(idx);
		});
		// First entry: partial loop in progress at capture start.
		expect(r.loopMap[0]).toEqual({
			outputFrameStart: 0,
			sourceFrameStart: r.offset % F,
			loopIndex: 0,
		});
		// Every later entry begins a fresh source loop at source frame 0, exactly
		// where (i+offset) mod F returns to 0.
		for (let k = 1; k < r.loopMap.length; k++) {
			const e = r.loopMap[k];
			if (!e) {
				throw new Error("missing loop entry");
			}
			expect(e.sourceFrameStart).toBe(0);
			expect(r.sourceIndexAt(e.outputFrameStart)).toBe(0);
			// The frame just before the wrap is the last source frame F−1.
			expect(r.sourceIndexAt(e.outputFrameStart - 1)).toBe(F - 1);
		}
	});

	it("is robust to a DC level + contrast (gain) shift between source and encode", () => {
		const distorted = makeDistorted(source, KNOWN, W, {
			noise: 2,
			level: 35, // brightness offset
			gain: 0.8, // contrast change
			seed: 11,
		});
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: KNOWN,
			searchRadius: 40,
		});
		expect(Math.abs(r.offset - KNOWN)).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.85);
	});

	it("recovers with NO coarse anchor (full [0,F) search)", () => {
		const distorted = makeDistorted(source, KNOWN, W, {
			noise: 3,
			seed: 3,
		});
		const r = alignLoopedSignatures(source, distorted); // no options at all
		expect(Math.abs(r.offset - KNOWN)).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.85);
		expect(r.drift.detected).toBe(false);
		expect(r.loopMap.length).toBeGreaterThanOrEqual(3);
	});

	it("recovers offset 0 (anchor exact, no shift)", () => {
		const distorted = makeDistorted(source, 0, W, { noise: 1, seed: 5 });
		const r = alignLoopedSignatures(source, distorted, { coarseOffset: 0 });
		expect(Math.abs(r.offset - 0)).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.85);
	});
});

describe("alignLoopedSignatures — drift detection", () => {
	const F = 150;
	const source = makeSource(F);

	it("flags a gradual +1-frame-per-quarter ramp", () => {
		const segments = DEFAULT_SEGMENT_COUNT; // 4 quarters
		const ramp = 1; // +1 frame each quarter → +3 frames end to end
		const W = F * 4;
		const distorted = makeDrifting(source, 40, W, segments, ramp, {
			noise: 1.5,
			seed: 21,
		});
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: 40,
			segmentCount: segments,
		});
		expect(r.drift.detected).toBe(true);
		// Total ramp is ramp·(segments−1) = 3 frames; allow ±1 estimation slack.
		expect(r.drift.maxDriftFrames).toBeGreaterThanOrEqual(2);
		expect(r.drift.maxDriftFrames).toBeLessThanOrEqual(4);
		expect(r.drift.perSegmentOffsets.length).toBe(segments);
		// Per-segment offsets should be (weakly) increasing across the window.
		const first = r.drift.perSegmentOffsets[0] as number;
		const last = r.drift.perSegmentOffsets[segments - 1] as number;
		expect(last - first).toBeGreaterThanOrEqual(2);
	});

	it("reports NO drift for a constant offset (steady capture)", () => {
		const W = F * 4;
		const distorted = makeDistorted(source, 88, W, { noise: 2, seed: 33 });
		const r = alignLoopedSignatures(source, distorted, { coarseOffset: 88 });
		expect(r.drift.detected).toBe(false);
		expect(r.drift.maxDriftFrames).toBeLessThanOrEqual(1);
	});
});

describe("alignLoopedSignatures — confidence floor on unrelated input", () => {
	const F = 150;
	const source = makeSource(F);

	it("scores LOW confidence when the distorted window is pure noise", () => {
		const rng = makeRng(424242);
		const W = F * 3;
		const noise = Array.from({ length: W }, () => 128 + (rng() - 0.5) * 80);
		const r = alignLoopedSignatures(source, noise);
		// A caller gates on this: noise must not masquerade as an alignment.
		expect(r.confidence).toBeLessThan(0.5);
	});

	it("a real match scores far above an unrelated one (separation)", () => {
		const real = makeDistorted(source, 70, F * 3, { noise: 3, seed: 9 });
		const rng = makeRng(55);
		const noise = Array.from({ length: F * 3 }, () => 128 + (rng() - 0.5) * 80);
		const realR = alignLoopedSignatures(source, real);
		const noiseR = alignLoopedSignatures(source, noise);
		expect(realR.confidence).toBeGreaterThan(0.85);
		expect(realR.confidence - noiseR.confidence).toBeGreaterThan(0.4);
	});

	it("scores LOW confidence against an UNRELATED but structured signal", () => {
		// A different sum-of-sines (no shared frequencies) — structured, not white
		// noise, yet not the source. Confidence must still be low.
		const W = F * 3;
		const other = Array.from(
			{ length: W },
			(_, i) =>
				128 +
				50 * Math.sin((2 * Math.PI * i) / 13.1) +
				30 * Math.sin((2 * Math.PI * i) / 4.2 + 0.9),
		);
		const r = alignLoopedSignatures(source, other);
		expect(r.confidence).toBeLessThan(0.5);
	});
});

describe("alignLoopedSignatures — sourceIndexAt correctness", () => {
	const F = 150;
	const KNOWN = 57;
	const source = makeSource(F);

	it("returns (i+offset) mod F for sampled i, including across wraps", () => {
		const W = F * 3 + 20;
		const distorted = makeDistorted(source, KNOWN, W, { noise: 2, seed: 1 });
		const r = alignLoopedSignatures(source, distorted, { coarseOffset: KNOWN });
		const off = r.offset;
		for (const i of [0, 1, 50, F - off - 1, F - off, F - off + 1, 200, 449]) {
			expect(r.sourceIndexAt(i)).toBe((((i + off) % F) + F) % F);
		}
		// Always in range [0, F).
		for (const i of [0, 73, 149, 150, 299, 448]) {
			const v = r.sourceIndexAt(i);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(F);
		}
	});
});

describe("alignLoopedSignatures — edges", () => {
	it("handles W < F (partial loop) with NO wrap: exactly one loop-map entry", () => {
		const F = 200;
		const KNOWN = 40; // wrap would fall at output frame F−KNOWN=160 > W
		const source = makeSource(F);
		const W = 120; // less than one full loop AND ends before the wrap
		const distorted = makeDistorted(source, KNOWN, W, { noise: 2, seed: 4 });
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: KNOWN,
			segmentCount: 3,
		});
		expect(Math.abs(r.offset - KNOWN)).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.8);
		// The window never reaches the wrap ⇒ exactly the single in-progress-loop
		// entry beginning at source frame = offset.
		expect(r.loopMap.length).toBe(1);
		expect(r.loopMap[0]).toEqual({
			outputFrameStart: 0,
			sourceFrameStart: r.offset % F,
			loopIndex: 0,
		});
	});

	it("handles W < F (partial loop) that DOES wrap once: two loop-map entries", () => {
		const F = 200;
		const KNOWN = 150; // wrap at output frame F−KNOWN=50, inside W
		const source = makeSource(F);
		const W = 120; // still less than a full loop, but crosses one wrap
		const distorted = makeDistorted(source, KNOWN, W, { noise: 2, seed: 6 });
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: KNOWN,
			searchRadius: 12,
		});
		expect(Math.abs(r.offset - KNOWN)).toBeLessThanOrEqual(1);
		expect(r.loopMap.length).toBe(2);
		expect(r.loopMap[0]?.loopIndex).toBe(0);
		expect(r.loopMap[1]?.loopIndex).toBe(1);
		expect(r.loopMap[1]?.sourceFrameStart).toBe(0);
		// Wrap lands at output frame F − offset.
		expect(r.loopMap[1]?.outputFrameStart).toBe(F - r.offset);
	});

	it("handles an offset on the F−1 wrap boundary", () => {
		const F = 128;
		const KNOWN = F - 1; // 127
		const source = makeSource(F);
		const W = F * 3;
		const distorted = makeDistorted(source, KNOWN, W, { noise: 2, seed: 8 });
		const r = alignLoopedSignatures(source, distorted, {
			coarseOffset: KNOWN,
			searchRadius: 10,
		});
		// Wrap-aware: KNOWN, 0, or F−1±1 are all within ±1 on the ring.
		const ring = Math.min(
			(((r.offset - KNOWN) % F) + F) % F,
			(((KNOWN - r.offset) % F) + F) % F,
		);
		expect(ring).toBeLessThanOrEqual(1);
		expect(r.confidence).toBeGreaterThan(0.85);
		// First wrap should be ~1 frame in (offset F−1 ⇒ wraps at output frame 1).
		expect(r.loopMap.length).toBeGreaterThanOrEqual(3);
	});

	it("handles F = 1 (degenerate single-frame source)", () => {
		const source = [42];
		const distorted = [42, 42, 42, 42, 42];
		const r = alignLoopedSignatures(source, distorted, { coarseOffset: 0 });
		expect(r.offset).toBe(0);
		// Every output maps to the only source frame.
		for (let i = 0; i < 5; i++) {
			expect(r.sourceIndexAt(i)).toBe(0);
		}
		// A flat single-frame source has no discriminative content → confidence
		// is defined (no NaN) and necessarily low; we only assert it's a number
		// in range so a caller still gets a usable verdict.
		expect(Number.isFinite(r.confidence)).toBe(true);
		expect(r.confidence).toBeGreaterThanOrEqual(0);
		expect(r.confidence).toBeLessThanOrEqual(1);
		// loopMap: one wrap per output frame (period 1).
		expect(r.loopMap.length).toBe(5);
		expect(r.loopMap.map((e) => e.loopIndex)).toEqual([0, 1, 2, 3, 4]);
	});

	it("throws on empty source or distorted", () => {
		expect(() => alignLoopedSignatures([], [1, 2, 3])).toThrow(/source/);
		expect(() => alignLoopedSignatures([1, 2, 3], [])).toThrow(/distorted/);
	});
});
