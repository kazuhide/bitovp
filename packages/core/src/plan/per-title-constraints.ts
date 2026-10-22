export type BitrateInterval = { minimum: number; maximum: number };
type Row = BitrateInterval & { low: number; high: number };
type Fraction = { n: bigint; d: bigint };

const positiveInteger = (value: number) =>
	Number.isSafeInteger(value) && value > 0;
const validInterval = (value: BitrateInterval) =>
	!!value &&
	positiveInteger(value.minimum) &&
	positiveInteger(value.maximum) &&
	value.minimum <= value.maximum;
const validRow = (row: Row) =>
	validInterval(row) &&
	positiveInteger(row.low) &&
	positiveInteger(row.high) &&
	row.low < row.high;
const validStep = (value: number) => Number.isFinite(value) && value > 0;
const integer = (value: number | bigint): Fraction => ({
	n: BigInt(value),
	d: 1n,
});
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const divide = (a: Fraction, b: Fraction): Fraction => ({
	n: a.n * b.d,
	d: a.d * b.n,
});
const lessOne = (a: Fraction): Fraction => ({ n: a.n - a.d, d: a.d });

function affine(row: Row, input: number): Fraction {
	if (input <= row.low) return integer(row.minimum);
	if (input >= row.high) return integer(row.maximum);
	const d = BigInt(row.high) - BigInt(row.low);
	return {
		n:
			BigInt(row.minimum) * d +
			(BigInt(input) - BigInt(row.low)) *
				(BigInt(row.maximum) - BigInt(row.minimum)),
		d,
	};
}

/**
 * Sufficient same-input upper-target proof, not a prediction of analysis or output.
 * Comparing the unrounded affine pieces also orders their floors; false can reject
 * curves whose integer targets coincide. This does not compare q-lower relaxation.
 */
export function complexityTargetsDoNotDecrease(
	before: Row,
	after: Row,
	input: BitrateInterval,
): boolean {
	if (!validRow(before) || !validRow(after) || !validInterval(input))
		return false;
	// Each target difference is affine between these at most six breakpoints.
	const points = new Set([
		input.minimum,
		input.maximum,
		before.low,
		before.high,
		after.low,
		after.high,
	]);
	return [...points]
		.filter((point) => point >= input.minimum && point <= input.maximum)
		.every(
			(point) => compare(affine(after, point), affine(before, point)) >= 0n,
		);
}

/** Conditional bounds for an explicit analysis input; not a prediction of that input. */
export function evaluateComplexityRange(
	args: Row & { input: number; minStep: number },
): BitrateInterval | null {
	if (
		!validRow(args) ||
		!positiveInteger(args.input) ||
		!validStep(args.minStep)
	)
		return null;
	if (args.input <= args.low)
		return { minimum: args.minimum, maximum: args.minimum };
	if (args.input >= args.high)
		return { minimum: args.maximum, maximum: args.maximum };
	const value = affine(args, args.input);
	const target = Number(value.n / value.d);
	const q = Math.round(args.input / args.minStep);
	return {
		minimum: args.minimum <= q && q < target ? q : target,
		maximum: target,
	};
}

/** Repeated positive multiplication and rounding; policy caps belong to the caller. */
export function evaluateForcedRenditions(args: {
	base: BitrateInterval;
	count: number;
	factor: number;
}): BitrateInterval[] | null {
	if (
		!validInterval(args.base) ||
		!Number.isSafeInteger(args.count) ||
		args.count < 0 ||
		args.count > 256 ||
		!validStep(args.factor)
	)
		return null;
	const result: BitrateInterval[] = [];
	let previous = args.base;
	for (let i = 0; i < args.count; i++) {
		const next = {
			minimum: Math.round(previous.minimum * args.factor),
			maximum: Math.round(previous.maximum * args.factor),
		};
		if (!validInterval(next)) return null;
		result.push(next);
		previous = next;
	}
	return result;
}

const float = new DataView(new ArrayBuffer(8));
function exactDouble(value: number): Fraction {
	if (value === 0) return integer(0);
	float.setFloat64(0, value);
	const bits = float.getBigUint64(0);
	const exponent = Number((bits >> 52n) & 2047n);
	const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
	const shift = (exponent || 1) - 1023 - 52;
	return shift >= 0
		? { n: mantissa << BigInt(shift), d: 1n }
		: { n: mantissa, d: 1n << BigInt(-shift) };
}

// Directed rounding preserves a sufficient bound without a numerical tolerance.
function rounded(value: Fraction, down: boolean): number | null {
	let candidate = Number(value.n) / Number(value.d);
	if (!Number.isFinite(candidate) || candidate < 0 || value.d <= 0n)
		return null;
	for (let i = 0; i < 8; i++) {
		const difference = compare(exactDouble(candidate), value);
		if (down ? difference <= 0n : difference >= 0n) return candidate;
		float.setFloat64(0, candidate);
		float.setBigUint64(0, float.getBigUint64(0) + (down ? -1n : 1n));
		candidate = float.getFloat64(0);
	}
	return null;
}

function boundsAtEnds(row: Row, start: number, end: number) {
	const a = affine(row, start),
		b = affine(row, end);
	const first = a.n / a.d,
		last = b.n / b.d;
	const exact = first === last;
	return { points: exact ? [integer(first), integer(first)] : [a, b], exact };
}

/** Sufficient spacing of the upper-endpoint placement across all integer inputs. */
export function certifyComplexitySpacing(
	rows: readonly Row[],
	input: BitrateInterval,
): {
	maximumMinimumStep: number;
	minimumMaximumStep: number;
	checkedSegments: number;
} | null {
	if (
		!validInterval(input) ||
		rows.length < 2 ||
		rows.length > 64 ||
		!rows.every(validRow)
	)
		return null;
	const cuts = [
		...new Set([
			input.minimum,
			input.maximum,
			...rows.flatMap((row) => [row.low, row.high]),
		]),
	]
		.filter((value) => value >= input.minimum && value <= input.maximum)
		.sort((a, b) => a - b);
	let lower: Fraction | undefined, upper: Fraction | undefined;
	const segments = Math.max(1, cuts.length - 1);
	for (let part = 0; part < segments; part++) {
		const start = cuts[part],
			end = cuts[part + 1] ?? start;
		if (start === undefined || end === undefined) return null;
		const values = rows.map((row) => boundsAtEnds(row, start, end));
		for (let i = 1; i < values.length; i++) {
			const previous = values[i - 1],
				next = values[i];
			if (!previous || !next) return null;
			for (let side = 0; side < 2; side++) {
				const a = previous.points[side],
					b = next.points[side];
				if (!a || !b) return null;
				const denominator = previous.exact ? a : lessOne(a);
				if (denominator.n <= 0n) return null;
				const lo = divide(next.exact ? b : lessOne(b), a),
					hi = divide(b, denominator);
				if (!lower || compare(lo, lower) < 0n) lower = lo;
				if (!upper || compare(hi, upper) > 0n) upper = hi;
			}
		}
	}
	if (!lower || !upper) return null;
	const minimum = rounded(lower, true),
		maximum = rounded(upper, false);
	return minimum === null || maximum === null
		? null
		: {
				maximumMinimumStep: minimum,
				minimumMaximumStep: maximum,
				checkedSegments: segments,
			};
}

function activation(
	row: Row,
	input: BitrateInterval,
	step: number,
): number | undefined {
	if (Math.round(input.maximum / step) < row.minimum) return undefined;
	let low = input.minimum,
		high = input.maximum;
	for (let i = 0; i < 64 && low < high; i++) {
		const middle = low + Math.floor((high - low) / 2);
		if (Math.round(middle / step) >= row.minimum) high = middle;
		else low = middle + 1;
	}
	return low;
}

/** Sufficient rectangle bounds for every effective rate, over the integer input domain. */
export function certifyComplexityIntervals(
	rows: readonly Row[],
	input: BitrateInterval,
	minStep: number,
): {
	minimumAdjacentRatio?: number;
	maximumAdjacentRatio?: number;
	maximumWithinRowRatio: number;
	checkedSegments: number;
} | null {
	if (
		!validInterval(input) ||
		!validStep(minStep) ||
		rows.length < 1 ||
		rows.length > 64 ||
		!rows.every(validRow)
	)
		return null;
	// Disjoint integer pieces isolate clamp equalities and the possible downward jump at activation.
	const cuts = [
		...new Set([
			input.minimum,
			...rows.flatMap((row) =>
				[row.low + 1, row.high, activation(row, input, minStep)].filter(
					(point): point is number =>
						point !== undefined &&
						point > input.minimum &&
						point <= input.maximum,
				),
			),
		]),
	].sort((a, b) => a - b);
	const step = exactDouble(minStep);
	const qLower = (c: number): Fraction => ({
		n: 2n * BigInt(c) * step.d - step.n,
		d: 2n * step.n,
	});
	let adjacentLower: Fraction | undefined,
		adjacentUpper: Fraction | undefined,
		within: Fraction | undefined;
	for (let part = 0; part < cuts.length; part++) {
		const start = cuts[part],
			end =
				cuts[part + 1] === undefined
					? input.maximum
					: (cuts[part + 1] as number) - 1;
		if (start === undefined) return null;
		const rectangles: { upper: Fraction[]; lower: Fraction[][] }[] = [];
		for (const row of rows) {
			const target = boundsAtEnds(row, start, end);
			const a = evaluateComplexityRange({ ...row, input: start, minStep });
			const b = evaluateComplexityRange({ ...row, input: end, minStep });
			if (!a || !b) return null;
			// Each piece has a fixed branch; its effective lower bound is monotone there.
			const lower =
				a.minimum === b.minimum
					? [[integer(a.minimum), integer(a.minimum)]]
					: [
							target.points.map((point) =>
								target.exact ? point : lessOne(point),
							),
						];
			if (
				a.minimum !== b.minimum &&
				start > row.low &&
				end < row.high &&
				Math.round(start / minStep) >= row.minimum
			)
				lower.push([qLower(start), qLower(end)]);
			if (lower.some((branch) => branch.some((point) => point.n <= 0n)))
				return null;
			rectangles.push({ upper: target.points, lower });
		}
		for (let i = 0; i < rectangles.length; i++) {
			const row = rectangles[i],
				previous = rectangles[i - 1];
			if (!row) return null;
			for (let side = 0; side < 2; side++) {
				const top = row.upper[side];
				if (!top) return null;
				for (const branch of row.lower) {
					const bottom = branch[side];
					if (!bottom) return null;
					const ratio = divide(top, bottom);
					if (!within || compare(ratio, within) > 0n) within = ratio;
					if (previous) {
						const priorTop = previous.upper[side];
						if (!priorTop) return null;
						const lower = divide(bottom, priorTop);
						if (!adjacentLower || compare(lower, adjacentLower) < 0n)
							adjacentLower = lower;
					}
				}
				if (previous)
					for (const branch of previous.lower) {
						const bottom = branch[side];
						if (!bottom) return null;
						const upper = divide(top, bottom);
						if (!adjacentUpper || compare(upper, adjacentUpper) > 0n)
							adjacentUpper = upper;
					}
			}
		}
	}
	if (!within) return null;
	const maximumWithinRowRatio = rounded(within, false);
	const minimumAdjacentRatio = adjacentLower
		? rounded(adjacentLower, true)
		: undefined;
	const maximumAdjacentRatio = adjacentUpper
		? rounded(adjacentUpper, false)
		: undefined;
	if (
		maximumWithinRowRatio === null ||
		minimumAdjacentRatio === null ||
		maximumAdjacentRatio === null
	)
		return null;
	return {
		maximumWithinRowRatio,
		checkedSegments: cuts.length,
		...(minimumAdjacentRatio === undefined ? {} : { minimumAdjacentRatio }),
		...(maximumAdjacentRatio === undefined ? {} : { maximumAdjacentRatio }),
	};
}
