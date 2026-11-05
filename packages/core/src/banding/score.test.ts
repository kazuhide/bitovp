import { describe, expect, it } from "vitest";
import { canonicalBandingScore } from "./score";

describe("official libvmaf JSON decision precision", () => {
	it("matches six-decimal feature logging with nearest-even ties", () => {
		expect(canonicalBandingScore(22.1234564)).toBe(22.123456);
		expect(canonicalBandingScore(0.0078125)).toBe(0.007812);
		expect(canonicalBandingScore(0.0234375)).toBe(0.023438);
	});
	it("preserves the official adaptive 16-place treatment of tiny fractional parts", () => {
		expect(canonicalBandingScore(5.0000004)).toBe(5.0000004);
		expect(canonicalBandingScore(0.00000000000000016)).toBe(0.0000000000000002);
		expect(canonicalBandingScore(0)).toBe(0);
	});
	it("is idempotent for already logged scores and rejects invalid scores", () => {
		for (const score of [0, 22.307707, 5.0000004, 1e-12, 1e100]) {
			const once = canonicalBandingScore(score);
			expect(canonicalBandingScore(once)).toBe(once);
		}
		for (const score of [Number.NaN, Infinity, -0.01]) {
			expect(() => canonicalBandingScore(score)).toThrow();
		}
	});
});
