import { describe, expect, it } from "vitest";
import { findCapReachingMaximumStep } from "./per-title-cap-reach";
import { decimalParameter } from "./per-title-numeric";
import { projectIntegerBitrateSlots } from "./per-title-output-count";

type Input = Parameters<typeof findCapReachingMaximumStep>[0];
type Fraction = { n: bigint; d: bigint };
const less = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d;

function nextDown(value: number) {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	view.setBigUint64(0, view.getBigUint64(0) - 1n);
	return view.getFloat64(0);
}

/** Independently enumerate every small integer chain with the required endpoints. */
function minimumMaximumRatio(input: Input): Fraction | null {
	const minimum = decimalParameter(input.minimumStep);
	let best: Fraction | null = null;
	const visit = (points: number[], largest?: Fraction) => {
		if (points.length === input.count) {
			if (points.at(-1) === input.maximumBitrate && largest)
				if (!best || less(largest, best)) best = largest;
			return;
		}
		const previous = points.at(-1) as number;
		const remaining = input.count - points.length;
		const first = remaining === 1 ? input.maximumBitrate : previous + 1;
		const last = input.maximumBitrate - remaining + 1;
		for (let next = first; next <= last; next++) {
			if (
				next <= previous ||
				BigInt(next) * minimum.d < BigInt(previous) * minimum.n
			)
				continue;
			const ratio = { n: BigInt(next), d: BigInt(previous) };
			visit(
				[...points, next],
				!largest || less(largest, ratio) ? ratio : largest,
			);
		}
	};
	visit([input.minimumBitrate]);
	return best;
}

describe("cap-reaching maximum bitrate step", () => {
	const base: Input = {
		minimumBitrate: 300_000,
		maximumBitrate: 4_000_000,
		minimumStep: 2.128663656502157,
		count: 4,
	};
	const small = [1, 3, 5].flatMap((minimumBitrate) =>
		[2, 5, 9].flatMap((span) =>
			[2, 3, 4].flatMap((count) =>
				[1.1, 1.3, 1.9].map((minimumStep) => ({
					minimumBitrate,
					maximumBitrate: minimumBitrate + span,
					count,
					minimumStep,
				})),
			),
		),
	);

	// Arithmetic-model inputs deliberately include values below the API floor.
	it.each(small)("matches complete integer enumeration: %j", (input) => {
		const expected = minimumMaximumRatio(input);
		const actual = findCapReachingMaximumStep(input);
		if (!expected) {
			expect(actual).toBeNull();
			return;
		}
		expect(actual).not.toBeNull();
		if (actual === null) throw new Error("Missing feasible maximum step");
		expect(less(decimalParameter(actual), expected)).toBe(false);
		expect(less(decimalParameter(nextDown(actual)), expected)).toBe(true);
	});

	it("allows the cap while retaining the selected minimum-step count bound", () => {
		const maximumStep = findCapReachingMaximumStep(base);
		expect(maximumStep).toBe(2.3712633333333337);
		if (maximumStep === null) throw new Error("Missing maximum step");
		const output = projectIntegerBitrateSlots({
			minimumBitrate: base.minimumBitrate,
			ceiling: base.maximumBitrate,
			minimumStep: base.minimumStep,
			maximumStep,
			count: base.count,
		});
		expect(output.status).toBe("conditional");
		if (output.status !== "conditional")
			throw new Error("Missing integer slots");
		expect(output.slots.at(-1)).toEqual({
			minimum: 2_893_631,
			maximum: 4_000_000,
		});
		expect(
			projectIntegerBitrateSlots({
				minimumBitrate: base.minimumBitrate,
				ceiling: base.maximumBitrate,
				minimumStep: base.minimumStep,
				maximumStep: base.maximumBitrate / base.minimumBitrate + 1,
				count: 5,
			}).status,
		).toBe("infeasible");
	});

	it("rounds the JSON decimal outward at the single-step rational boundary", () => {
		const value = findCapReachingMaximumStep({
			minimumBitrate: 3,
			maximumBitrate: 4,
			minimumStep: 1.1,
			count: 2,
		});
		expect(value).toBe(1.3333333333333335);
	});

	it("keeps endpoint feasibility separate from an output-count certificate", () => {
		const maximumStep = findCapReachingMaximumStep({
			...base,
			minimumStep: 1.1,
		});
		expect(maximumStep).not.toBeNull();
		expect(
			projectIntegerBitrateSlots({
				minimumBitrate: base.minimumBitrate,
				ceiling: base.maximumBitrate,
				minimumStep: 1.1,
				maximumStep: base.maximumBitrate / base.minimumBitrate + 1,
				count: 5,
			}).status,
		).toBe("conditional");
	});

	it.each([
		{
			minimumBitrate: 1,
			maximumBitrate: 2_147_483_647,
			minimumStep: 1.1,
			count: 2,
		},
		{
			minimumBitrate: 10_000,
			maximumBitrate: 2_147_483_647,
			minimumStep: 1.01,
			count: 256,
		},
		{
			minimumBitrate: 2_147_483_000,
			maximumBitrate: 2_147_483_647,
			minimumStep: 1 + Number.EPSILON,
			count: 256,
		},
	])("retains exact cap reach near the supported domain boundary: %j", (input) => {
		const maximumStep = findCapReachingMaximumStep(input);
		expect(maximumStep).not.toBeNull();
		if (maximumStep === null) throw new Error("Missing maximum step");
		const result = projectIntegerBitrateSlots({
			minimumBitrate: input.minimumBitrate,
			ceiling: input.maximumBitrate,
			minimumStep: input.minimumStep,
			maximumStep,
			count: input.count,
		});
		expect(result.status).toBe("conditional");
		if (result.status !== "conditional")
			throw new Error("Missing integer slots");
		expect(result.slots.at(-1)?.maximum).toBe(input.maximumBitrate);
	});

	it.each([
		{ count: 0 },
		{ count: 1 },
		{ count: 257 },
		{ count: 2.5 },
		{ count: NaN },
		{ minimumBitrate: 0 },
		{ minimumBitrate: 1.5 },
		{ minimumBitrate: Infinity },
		{ maximumBitrate: 299_999 },
		{ maximumBitrate: 300_000 },
		{ maximumBitrate: 2_147_483_648 },
		{ maximumBitrate: NaN },
		{ minimumStep: 1 },
		{ minimumStep: 0 },
		{ minimumStep: NaN },
		{ minimumStep: Infinity },
		{ minimumStep: 100 },
	])("returns no placement for invalid, single-output or impossible inputs: %j", (change) => {
		expect(findCapReachingMaximumStep({ ...base, ...change })).toBeNull();
	});
});
