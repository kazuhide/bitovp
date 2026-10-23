import { decimalParameter } from "./per-title-numeric";

type Interval = { minimum: bigint; maximum: bigint };

type CountSlotProjection =
	| {
			status: "conditional";
			slots: { minimum: number; maximum: number }[];
	  }
	| { status: "infeasible"; reason: "integer-chain-infeasible" }
	| {
			status: "unavailable";
			reason: "invalid-input" | "invalid-count" | "model-limit";
	  };

const validBitrate = (value: number) =>
	Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

const ceil = (numerator: bigint, denominator: bigint) =>
	(numerator + denominator - 1n) / denominator;
const greater = (a: bigint, b: bigint) => (a > b ? a : b);
const lesser = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Project integer placements with a fixed first rate and constant ratio bounds.
 * The ceiling is only an upper bound; the last slot need not reach it.
 * Every value in a slot can belong to a complete chain, but different slots'
 * endpoints need not belong to the same chain. This does not predict outputs.
 */
export function projectIntegerBitrateSlots(input: {
	minimumBitrate: number;
	ceiling: number;
	minimumStep: number;
	maximumStep: number;
	count: number;
}): CountSlotProjection {
	if (!Number.isSafeInteger(input.count) || input.count < 1)
		return { status: "unavailable", reason: "invalid-count" };
	if (input.count > 256)
		return { status: "unavailable", reason: "model-limit" };
	if (
		!validBitrate(input.minimumBitrate) ||
		!validBitrate(input.ceiling) ||
		input.ceiling < input.minimumBitrate ||
		!Number.isFinite(input.minimumStep) ||
		input.minimumStep <= 1 ||
		!Number.isFinite(input.maximumStep) ||
		input.maximumStep < input.minimumStep
	)
		return { status: "unavailable", reason: "invalid-input" };

	const minimum = decimalParameter(input.minimumStep);
	const maximum = decimalParameter(input.maximumStep);
	const ceiling = BigInt(input.ceiling);
	const first = BigInt(input.minimumBitrate);
	const forward: Interval[] = [{ minimum: first, maximum: first }];
	// Before the first branch the reachable set is a singleton. A branch from
	// x implies (maximumStep - minimumStep) * x >= 1. At the next minimum L,
	// that difference times L is >= minimumStep, so all adjacent successor
	// intervals touch. The reachable set therefore stays an integer interval.
	// This argument depends on the fixed start and the same bounds at every step.
	let previous = forward[0] as Interval;
	for (let index = 1; index < input.count; index++) {
		const next = {
			minimum: ceil(previous.minimum * minimum.n, minimum.d),
			maximum: lesser(ceiling, (previous.maximum * maximum.n) / maximum.d),
		};
		if (next.minimum > next.maximum)
			return { status: "infeasible", reason: "integer-chain-infeasible" };
		forward.push(next);
		previous = next;
	}

	const projected = forward.map((interval) => ({ ...interval }));
	for (let index = projected.length - 2; index >= 0; index--) {
		const reachable = forward[index] as Interval;
		const next = projected[index + 1] as Interval;
		const current = {
			minimum: greater(
				reachable.minimum,
				ceil(next.minimum * maximum.d, maximum.n),
			),
			maximum: lesser(
				reachable.maximum,
				(next.maximum * minimum.d) / minimum.n,
			),
		};
		if (current.minimum > current.maximum)
			return { status: "infeasible", reason: "integer-chain-infeasible" };
		projected[index] = current;
	}
	return {
		status: "conditional",
		slots: projected.map((interval) => ({
			minimum: Number(interval.minimum),
			maximum: Number(interval.maximum),
		})),
	};
}
