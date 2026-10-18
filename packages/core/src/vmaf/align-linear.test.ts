import { describe, expect, it } from "vitest";
import { alignLinearSignatures } from "./align-linear";

/**
 * The measured case this exists for: a real 540p mirror scored 31.6 against its
 * source at offset 0 and 61.4 at offset +1, with near-zero frames going from 55
 * to 2 . So the search has to find a
 * one-frame shift reliably — and, just as importantly, must NOT invent one.
 */

/** A signature with real structure: moving content, so offsets are separable. */
function moving(n: number, seed = 1): number[] {
	const out: number[] = [];
	let x = seed;
	for (let i = 0; i < n; i += 1) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out.push((x / 2147483648) * 100);
	}
	return out;
}

describe("alignLinearSignatures", () => {
	it("finds a one-frame reference lead", () => {
		const source = moving(200);
		// The reference carries one extra leading frame — what the real encode did.
		const reference = source;
		const distorted = source.slice(1);
		const out = alignLinearSignatures(reference, distorted);
		expect(out.offset).toBe(1);
		expect(out.confident).toBe(true);
	});

	it("finds a one-frame distorted lead as a negative offset", () => {
		const source = moving(200, 7);
		const out = alignLinearSignatures(source.slice(1), source);
		expect(out.offset).toBe(-1);
		expect(out.confident).toBe(true);
	});

	it("finds larger shifts inside the radius", () => {
		const source = moving(300, 3);
		for (const shift of [2, 5, 11]) {
			const out = alignLinearSignatures(source, source.slice(shift));
			expect(out.offset, `shift ${shift}`).toBe(shift);
			expect(out.confident, `shift ${shift}`).toBe(true);
		}
	});

	it("reports no shift for an already-aligned pair", () => {
		const source = moving(200, 11);
		const out = alignLinearSignatures(source, source);
		expect(out.offset).toBe(0);
		expect(out.confident).toBe(false);
		expect(out.distance).toBe(0);
	});

	it("refuses to shift when no candidate is clearly better", () => {
		/**
		 * A static clip: every offset scores the same, so the winner is a coin
		 * flip. Shifting here would turn a correct comparison into a wrong one,
		 * which is worse than not shifting — hence `confident: false` and offset 0.
		 */
		const flat = new Array(200).fill(50);
		const out = alignLinearSignatures(flat, flat.slice(3));
		expect(out.offset).toBe(0);
		expect(out.confident).toBe(false);
	});

	it("tolerates encode noise on top of a real shift", () => {
		// The distorted side is an ENCODE of the reference, so its luma differs
		// slightly frame by frame. The shift must still win.
		const source = moving(240, 5);
		const noisy = source.slice(1).map((v, i) => v + (i % 5) * 0.4 - 0.8);
		const out = alignLinearSignatures(source, noisy);
		expect(out.offset).toBe(1);
		expect(out.confident).toBe(true);
	});

	it("does not look beyond its radius", () => {
		const source = moving(300, 9);
		const out = alignLinearSignatures(source, source.slice(40), { radius: 5 });
		// 40 frames out is outside [-5,5]; the honest answer is "no confident
		// alignment", not the best of a set that cannot contain the truth.
		expect(out.offset).toBe(0);
		expect(out.confident).toBe(false);
		expect(out.radius).toBe(5);
	});

	it("refuses a comparison with too little overlap", () => {
		const out = alignLinearSignatures(moving(10), moving(10, 2), {
			minOverlap: 24,
		});
		expect(out.offset).toBe(0);
		expect(out.confident).toBe(false);
	});

	it("survives empty input rather than throwing", () => {
		const out = alignLinearSignatures([], []);
		expect(out.offset).toBe(0);
		expect(out.confident).toBe(false);
	});

	it("reports the runner-up so the margin is legible", () => {
		const source = moving(200, 13);
		const out = alignLinearSignatures(source, source.slice(1));
		expect(out.distance).toBeLessThan(out.runnerUp);
		// The margin is what `confident` is decided on; expose it, do not hide it.
		expect(out.distance).toBeLessThanOrEqual(out.runnerUp * 0.9);
	});
});
