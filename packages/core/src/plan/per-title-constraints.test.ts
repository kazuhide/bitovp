import { describe, expect, it } from "vitest";
import {
	certifyComplexityDirectConnection,
	certifyComplexityIntervals,
	certifyComplexitySpacing,
	complexityTargetsDoNotDecrease,
	evaluateComplexityRange,
	evaluateForcedRenditions,
} from "./per-title-constraints";

const row = { minimum: 180, maximum: 380, low: 200, high: 600 };
type Row = typeof row;

describe("whole-interval direct connection certificate", () => {
	it("certifies a derived curve over the complete input interval", () => {
		expect(
			certifyComplexityDirectConnection(
				{ minimum: 160, maximum: 480, low: 240, high: 720 },
				{ minimum: 240, maximum: 720 },
				{ minimum: 1.5, maximum: 4 },
			)?.allPermittedRates,
		).toBe(true);
	});
	it("rejects a reachable endpoint whose interior cannot connect", () => {
		expect(
			certifyComplexityDirectConnection(
				{ minimum: 160, maximum: 220, low: 200, high: 480 },
				{ minimum: 200, maximum: 720 },
				{ minimum: 1.5, maximum: 5 },
			)?.allPermittedRates,
		).toBe(false);
	});
	it("never certifies a false connection in independently enumerated small domains", () => {
		let checked = 0;
		for (const minimum of [8, 13, 24])
			for (const maximum of [30, 48, 60])
				for (const low of [15, 36, 60])
					for (const high of [70, 96, 120])
						for (const minimumStep of [1.2, 1.5, 2]) {
							const curve = { minimum, maximum, low, high };
							const domain = { minimum: 60, maximum: 140 };
							const certificate = certifyComplexityDirectConnection(
								curve,
								domain,
								{
									minimum: minimumStep,
									maximum: 5,
								},
							);
							if (!certificate?.allPermittedRates) continue;
							checked++;
							for (
								let input = domain.minimum;
								input <= domain.maximum;
								input++
							) {
								const range = evaluateComplexityRange({
									...curve,
									input,
									minStep: minimumStep,
								});
								expect(range).not.toBeNull();
								for (
									let bitrate = range?.minimum ?? 0;
									bitrate <= (range?.maximum ?? -1);
									bitrate++
								) {
									expect(input / bitrate).toBeGreaterThanOrEqual(minimumStep);
									expect(input / bitrate).toBeLessThanOrEqual(5);
								}
							}
						}
		expect(checked).toBeGreaterThan(10);
	});
});

describe("conditional complexity bounds", () => {
	it.each([
		[100, 180, 180],
		[200, 180, 180],
		[201, 180, 180],
		[401, 201, 280],
		[599, 300, 379],
		[600, 380, 380],
		[700, 380, 380],
	])("clamps or interpolates input %s using integer targets and rounded lower relaxation", (input, minimum, maximum) => {
		expect(evaluateComplexityRange({ ...row, input, minStep: 2 })).toEqual({
			minimum,
			maximum,
		});
	});
	it("does not relax below the requested minimum, and accepts equality", () => {
		expect(
			evaluateComplexityRange({ ...row, input: 400, minStep: 400 / 180 }),
		).toEqual({ minimum: 180, maximum: 280 });
		expect(evaluateComplexityRange({ ...row, input: 400, minStep: 3 })).toEqual(
			{ minimum: 280, maximum: 280 },
		);
	});
	it("does not round the interpolation product through a double", () => {
		expect(
			evaluateComplexityRange({
				minimum: 7,
				maximum: 9007199254740980,
				low: 3,
				high: 9007199254740974,
				input: 9007199254739990,
				minStep: 1,
			})?.maximum,
		).toBe(9007199254739995);
	});
	it("keeps the upper target monotone across boundaries", () => {
		let previous = 0;
		for (let input = 1; input <= 750; input++) {
			const result = evaluateComplexityRange({ ...row, input, minStep: 1.7 });
			expect(result).not.toBeNull();
			expect(result?.maximum).toBeGreaterThanOrEqual(previous);
			expect(result?.minimum).toBeGreaterThanOrEqual(row.minimum);
			expect(result?.minimum).toBeLessThanOrEqual(result?.maximum ?? 0);
			previous = result?.maximum ?? 0;
		}
	});
	it.each([
		{ minimum: 0 },
		{ maximum: 179 },
		{ low: 600 },
		{ high: 199 },
		{ input: Number.MAX_SAFE_INTEGER + 1 },
		{ input: NaN },
		{ minimum: 1.5 },
		{ minStep: 0 },
		{ minStep: Infinity },
	])("refuses invalid numeric inputs %j", (invalid) => {
		expect(
			evaluateComplexityRange({ ...row, input: 400, minStep: 2, ...invalid }),
		).toBeNull();
	});
});

describe("same-input complexity target nondecrease", () => {
	const before = { minimum: 100, maximum: 200, low: 200, high: 400 };
	it("rejects increasing H alone when an interior target decreases", () => {
		expect(
			complexityTargetsDoNotDecrease(
				before,
				{ ...before, high: 1600 },
				{ minimum: 100, maximum: 1600 },
			),
		).toBe(false);
	});
	it.each([
		{ minimum: 100, maximum: 400, low: 400, high: 1600 },
		{ minimum: 100, maximum: 600, low: 600, high: 1600 },
	])("rejects increased endpoint values when rescaled calibration lowers a same-input target", (after) => {
		expect(after.minimum).toBeGreaterThanOrEqual(before.minimum);
		expect(after.maximum).toBeGreaterThanOrEqual(before.maximum);
		expect(
			evaluateComplexityRange({ ...before, input: 300, minStep: 1 })?.maximum,
		).toBe(150);
		expect(
			evaluateComplexityRange({ ...after, input: 300, minStep: 1 })?.maximum,
		).toBe(100);
		expect(
			complexityTargetsDoNotDecrease(before, after, {
				minimum: 100,
				maximum: 1600,
			}),
		).toBe(false);
	});
	it("accepts equal curves and increased row values with preserved calibration", () => {
		expect(
			complexityTargetsDoNotDecrease(before, before, {
				minimum: 1,
				maximum: 2000,
			}),
		).toBe(true);
		expect(
			complexityTargetsDoNotDecrease(
				before,
				{ ...before, minimum: 101, maximum: 250 },
				{ minimum: 1, maximum: 2000 },
			),
		).toBe(true);
	});
	it("limits its certificate to the requested domain, including singleton and clamp equality", () => {
		const after = { ...before, high: 800 };
		expect(
			complexityTargetsDoNotDecrease(before, after, {
				minimum: 1,
				maximum: 200,
			}),
		).toBe(true);
		expect(
			complexityTargetsDoNotDecrease(before, after, {
				minimum: 800,
				maximum: 1000,
			}),
		).toBe(true);
		expect(
			complexityTargetsDoNotDecrease(before, after, {
				minimum: 300,
				maximum: 300,
			}),
		).toBe(false);
		expect(
			complexityTargetsDoNotDecrease(before, after, {
				minimum: 200,
				maximum: 200,
			}),
		).toBe(true);
	});
	it("is sufficient rather than necessary when both rounded targets coincide", () => {
		const old = { minimum: 10, maximum: 11, low: 1, high: 101 },
			after = { ...old, high: 102 };
		expect(
			evaluateComplexityRange({ ...old, input: 2, minStep: 1 })?.maximum,
		).toBe(10);
		expect(
			evaluateComplexityRange({ ...after, input: 2, minStep: 1 })?.maximum,
		).toBe(10);
		expect(
			complexityTargetsDoNotDecrease(old, after, { minimum: 2, maximum: 2 }),
		).toBe(false);
		expect(
			evaluateComplexityRange({ ...old, input: 101, minStep: 1 })?.maximum,
		).toBe(11);
		expect(
			evaluateComplexityRange({ ...after, input: 101, minStep: 1 })?.maximum,
		).toBe(10);
		expect(
			complexityTargetsDoNotDecrease(old, after, {
				minimum: 101,
				maximum: 101,
			}),
		).toBe(false);
	});
	it("uses exact rational comparisons near the safe integer limit", () => {
		const old = {
			minimum: Number.MAX_SAFE_INTEGER - 1000,
			maximum: Number.MAX_SAFE_INTEGER - 100,
			low: 10,
			high: 30,
		};
		expect(
			complexityTargetsDoNotDecrease(
				old,
				{ ...old, maximum: old.maximum - 1 },
				{ minimum: 11, maximum: 11 },
			),
		).toBe(false);
		expect(
			complexityTargetsDoNotDecrease(
				old,
				{ ...old, minimum: old.minimum + 1, maximum: old.maximum + 1 },
				{ minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
			),
		).toBe(true);
	});
	it.each([
		{ minimum: 0 },
		{ maximum: 99 },
		{ low: 400 },
		{ high: NaN },
		{ maximum: Number.MAX_SAFE_INTEGER + 1 },
		{ minimum: 1.5 },
	])("refuses invalid row values %j", (invalid) => {
		expect(
			complexityTargetsDoNotDecrease({ ...before, ...invalid }, before, {
				minimum: 1,
				maximum: 1000,
			}),
		).toBe(false);
		expect(
			complexityTargetsDoNotDecrease(
				before,
				{ ...before, ...invalid },
				{ minimum: 1, maximum: 1000 },
			),
		).toBe(false);
	});
	it.each([
		{ minimum: 0, maximum: 100 },
		{ minimum: 3, maximum: 2 },
		{ minimum: 1, maximum: Infinity },
		{ minimum: 1, maximum: Number.MAX_SAFE_INTEGER + 1 },
	])("refuses invalid domains %j", (input) => {
		expect(complexityTargetsDoNotDecrease(before, before, input)).toBe(false);
	});
	it("accepted certificates preserve discrete upper targets across a deterministic domain", () => {
		let accepted = 0;
		for (let offset = 0; offset < 12; offset++) {
			const old = {
				minimum: 7 + offset,
				maximum: 40 + 2 * offset,
				low: 11,
				high: 67,
			};
			for (const after of [
				{ ...old, minimum: old.minimum + 1, maximum: old.maximum + 3 },
				{ ...old, low: 8, high: 60 },
				{ ...old, high: 90 },
			]) {
				if (
					!complexityTargetsDoNotDecrease(old, after, {
						minimum: 1,
						maximum: 100,
					})
				)
					continue;
				accepted++;
				for (let input = 1; input <= 100; input++) {
					const a = evaluateComplexityRange({ ...old, input, minStep: 2 }),
						b = evaluateComplexityRange({ ...after, input, minStep: 2 });
					expect(a).not.toBeNull();
					expect(b).not.toBeNull();
					expect(b?.maximum).toBeGreaterThanOrEqual(a?.maximum ?? Infinity);
				}
			}
		}
		expect(accepted).toBeGreaterThan(0);
	});
});

describe("iterated forced bounds", () => {
	it("rounds each step separately without clamping to the original range", () => {
		expect(
			evaluateForcedRenditions({
				base: { minimum: 7, maximum: 11 },
				count: 3,
				factor: 1.25,
			}),
		).toEqual([
			{ minimum: 9, maximum: 14 },
			{ minimum: 11, maximum: 18 },
			{ minimum: 14, maximum: 23 },
		]);
	});
	it("preserves nonincreasing and equal factors as arithmetic inputs", () => {
		expect(
			evaluateForcedRenditions({
				base: { minimum: 18, maximum: 34 },
				count: 3,
				factor: 0.5,
			}),
		).toEqual([
			{ minimum: 9, maximum: 17 },
			{ minimum: 5, maximum: 9 },
			{ minimum: 3, maximum: 5 },
		]);
		expect(
			evaluateForcedRenditions({
				base: { minimum: 2, maximum: 3 },
				count: 2,
				factor: 1,
			}),
		).toEqual([
			{ minimum: 2, maximum: 3 },
			{ minimum: 2, maximum: 3 },
		]);
	});
	it("accepts zero and bounded counts", () => {
		expect(
			evaluateForcedRenditions({
				base: { minimum: 3, maximum: 5 },
				count: 0,
				factor: 2,
			}),
		).toEqual([]);
		expect(
			evaluateForcedRenditions({
				base: { minimum: 3, maximum: 5 },
				count: 256,
				factor: 1,
			}),
		).toHaveLength(256);
	});
	it.each([
		{ count: -1 },
		{ count: 257 },
		{ count: 1.5 },
		{ factor: 0 },
		{ factor: NaN },
		{ factor: Infinity },
		{ base: { minimum: 2, maximum: 1 } },
		{
			base: {
				minimum: Number.MAX_SAFE_INTEGER,
				maximum: Number.MAX_SAFE_INTEGER,
			},
		},
		{ base: { minimum: 1, maximum: 2 }, factor: 0.1 },
	])("rejects unsafe inputs or results %j", (invalid) => {
		expect(
			evaluateForcedRenditions({
				base: { minimum: 2, maximum: 4 },
				count: 2,
				factor: 2,
				...invalid,
			}),
		).toBeNull();
	});
});

// Independent discrete target for dense certificate checks: this deliberately has no relaxation.
function target(row: Row, input: number) {
	if (input <= row.low) return row.minimum;
	if (input >= row.high) return row.maximum;
	return Number(
		BigInt(row.minimum) +
			(BigInt(input - row.low) * BigInt(row.maximum - row.minimum)) /
				BigInt(row.high - row.low),
	);
}
function checkDense(rows: Array<Row>, minimum: number, maximum: number) {
	const proof = certifyComplexitySpacing(rows, { minimum, maximum });
	expect(proof).not.toBeNull();
	if (!proof) throw new Error("Missing arithmetic certificate");
	expect(Number.isFinite(proof.maximumMinimumStep)).toBe(true);
	expect(Number.isFinite(proof.minimumMaximumStep)).toBe(true);
	expect(proof.checkedSegments).toBeGreaterThan(0);
	for (let input = minimum; input <= maximum; input++)
		for (let i = 1; i < rows.length; i++) {
			const next = rows[i],
				previous = rows[i - 1];
			if (!next || !previous) throw new Error("Missing adjacent row");
			const ratio = target(next, input) / target(previous, input);
			expect(ratio).toBeGreaterThanOrEqual(proof.maximumMinimumStep);
			expect(ratio).toBeLessThanOrEqual(proof.minimumMaximumStep);
		}
	return proof;
}

describe("sufficient upper-placement spacing certificate", () => {
	it("bounds every discrete input across all low/high/equality branches", () => {
		const rows = [
			{ minimum: 20, maximum: 40, low: 10, high: 30 },
			{ minimum: 65, maximum: 150, low: 12, high: 48 },
		];
		const full = checkDense(rows, 1, 60);
		const restricted = checkDense(rows, 15, 35);
		expect(restricted.maximumMinimumStep).toBeGreaterThanOrEqual(
			full.maximumMinimumStep,
		);
		expect(restricted.minimumMaximumStep).toBeLessThanOrEqual(
			full.minimumMaximumStep,
		);
	});
	it("keeps exact plateaus and singleton placements free of a one-bps margin", () => {
		expect(
			certifyComplexitySpacing(
				[
					{ minimum: 1, maximum: 1, low: 10, high: 20 },
					{ minimum: 3, maximum: 3, low: 10, high: 20 },
				],
				{ minimum: 1, maximum: 30 },
			),
		).toMatchObject({ maximumMinimumStep: 3, minimumMaximumStep: 3 });
		expect(
			certifyComplexitySpacing(
				[
					{ minimum: 10, maximum: 20, low: 10, high: 20 },
					{ minimum: 30, maximum: 60, low: 10, high: 20 },
				],
				{ minimum: 1, maximum: 5 },
			),
		).toMatchObject({ maximumMinimumStep: 3, minimumMaximumStep: 3 });
		checkDense(
			[
				{ minimum: 10, maximum: 20, low: 10, high: 20 },
				{ minimum: 20, maximum: 50, low: 10, high: 20 },
			],
			15,
			15,
		);
	});
	it("does not divide by a nonpositive conservative denominator", () => {
		expect(
			certifyComplexitySpacing(
				[
					{ minimum: 1, maximum: 5, low: 1, high: 10 },
					{ minimum: 3, maximum: 9, low: 1, high: 10 },
				],
				{ minimum: 1, maximum: 10 },
			),
		).toBeNull();
	});
	it("checks deterministic varied domains against independent dense integer placements", () => {
		let seed = 60493;
		const random = (max: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % max;
		};
		for (let example = 0; example < 80; example++) {
			const rows = Array.from({ length: 3 }, () => {
				const minimum = 5 + random(35),
					low = 2 + random(20);
				return {
					minimum,
					maximum: minimum + random(80),
					low,
					high: low + 1 + random(30),
				};
			});
			checkDense(rows, 1, 60);
		}
	});
	it("rejects invalid inputs and limits the number of rows", () => {
		const good = { minimum: 2, maximum: 3, low: 1, high: 10 };
		for (const rows of [
			[],
			[good],
			Array.from({ length: 65 }, () => good),
			[good, { ...good, high: 1 }],
			[good, { ...good, maximum: Infinity }],
		])
			expect(
				certifyComplexitySpacing(rows, { minimum: 1, maximum: 10 }),
			).toBeNull();
		expect(
			certifyComplexitySpacing([good, good], { minimum: 10, maximum: 1 }),
		).toBeNull();
	});
});

function effective(row: Row, input: number, step: number) {
	const maximum = target(row, input);
	const q = Math.round(input / step);
	return {
		minimum:
			input > row.low && input < row.high && q >= row.minimum && q < maximum
				? q
				: maximum,
		maximum,
	};
}
function checkIntervals(
	rows: Row[],
	input: { minimum: number; maximum: number },
	step: number,
) {
	const proof = certifyComplexityIntervals(rows, input, step);
	expect(proof).not.toBeNull();
	if (!proof) throw new Error("Missing rectangle certificate");
	expect(proof.checkedSegments).toBeLessThanOrEqual(1 + 3 * rows.length);
	for (let c = input.minimum; c <= input.maximum; c++) {
		const ranges = rows.map((row) => effective(row, c, step));
		for (let i = 0; i < ranges.length; i++) {
			const range = ranges[i];
			if (!range) throw new Error("Missing range");
			expect(range.maximum / range.minimum).toBeLessThanOrEqual(
				proof.maximumWithinRowRatio,
			);
			const previous = ranges[i - 1];
			if (previous) {
				expect(range.minimum / previous.maximum).toBeGreaterThanOrEqual(
					proof.minimumAdjacentRatio ?? Infinity,
				);
				expect(range.maximum / previous.minimum).toBeLessThanOrEqual(
					proof.maximumAdjacentRatio ?? 0,
				);
			}
		}
	}
	return proof;
}

describe("sufficient effective-interval rectangle certificate", () => {
	it("bounds sampled placements across a safe-integer-sized input domain", () => {
		const maximum = Number.MAX_SAFE_INTEGER;
		const rows: [Row, Row] = [
			{ minimum: 900000, maximum: 1700000, low: 3, high: maximum - 10 },
			{ minimum: 2500000, maximum: 8000000, low: 11, high: maximum },
		];
		const proof = certifyComplexityIntervals(
			rows,
			{ minimum: 1, maximum },
			1.27,
		);
		expect(proof).not.toBeNull();
		if (!proof) throw new Error("Missing large-domain certificate");
		for (const input of [
			1,
			2,
			3,
			10,
			11,
			Math.floor(maximum / 4),
			Math.floor(maximum / 2),
			maximum - 11,
			maximum - 10,
			maximum - 1,
			maximum,
		]) {
			const first = effective(rows[0], input, 1.27),
				next = effective(rows[1], input, 1.27);
			expect(next.minimum / first.maximum).toBeGreaterThanOrEqual(
				proof.minimumAdjacentRatio ?? Infinity,
			);
			expect(next.maximum / first.minimum).toBeLessThanOrEqual(
				proof.maximumAdjacentRatio ?? 0,
			);
		}
	});
	it("covers lower relaxation, not only the upper placement", () => {
		const rows = [
			{ minimum: 100, maximum: 200, low: 100, high: 300 },
			{ minimum: 300, maximum: 500, low: 100, high: 300 },
		];
		const proof = checkIntervals(rows, { minimum: 200, maximum: 200 }, 1.5);
		expect(proof.maximumAdjacentRatio).toBeGreaterThan(400 / 150);
		expect(proof.maximumWithinRowRatio).toBeGreaterThan(1);
	});
	it("uses exact plateau and singleton rectangles, and leaves single-row adjacency absent", () => {
		const proof = checkIntervals(
			[{ minimum: 10, maximum: 10, low: 2, high: 5 }],
			{ minimum: 1, maximum: 9 },
			2,
		);
		expect(proof.maximumWithinRowRatio).toBe(1);
		expect(proof.minimumAdjacentRatio).toBeUndefined();
		expect(proof.maximumAdjacentRatio).toBeUndefined();
		checkIntervals(
			[{ minimum: 100, maximum: 200, low: 100, high: 300 }],
			{ minimum: 200, maximum: 200 },
			1.5,
		);
	});
	it("isolates both clamp equalities and the first rounded activation integer", () => {
		checkIntervals(
			[
				{ minimum: 9, maximum: 40, low: 3, high: 38 },
				{ minimum: 13, maximum: 71, low: 6, high: 43 },
			],
			{ minimum: 1, maximum: 60 },
			2,
		);
	});
	it("bounds every rectangle endpoint in deterministic varied domains", () => {
		let seed = 43981;
		const random = (maximum: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % maximum;
		};
		for (let example = 0; example < 80; example++) {
			const rows = Array.from({ length: 1 + random(4) }, () => {
				const minimum = 5 + random(30),
					low = 1 + random(20);
				return {
					minimum,
					maximum: minimum + random(80),
					low,
					high: low + 1 + random(30),
				};
			});
			checkIntervals(
				rows,
				{ minimum: 1, maximum: 60 },
				[0.75, 1, 1.37, 2, 4.2, 14][random(6)] ?? 2,
			);
		}
	});
	it("rejects invalid input instead of inventing a certificate", () => {
		expect(
			certifyComplexityIntervals([], { minimum: 1, maximum: 2 }, 2),
		).toBeNull();
		expect(
			certifyComplexityIntervals([row], { minimum: 2, maximum: 1 }, 2),
		).toBeNull();
		expect(
			certifyComplexityIntervals([row], { minimum: 1, maximum: 2 }, 0),
		).toBeNull();
		expect(
			certifyComplexityIntervals([row], { minimum: 1, maximum: 2 }, NaN),
		).toBeNull();
		expect(
			certifyComplexityIntervals(
				Array.from({ length: 65 }, () => row),
				{ minimum: 1, maximum: 2 },
				2,
			),
		).toBeNull();
	});
});
