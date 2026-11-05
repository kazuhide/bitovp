export const BANDING_DECISION_PRECISION = "LIBVMAF_JSON_ADAPTIVE_6_16" as const;

/**
 * Match pinned libvmaf output.c JSON feature formatting. The FFmpeg CPU path
 * receives these decimals, whereas the native CPU oracle retains full doubles.
 * Use the same decision precision on both, retaining native raw values too.
 * Decimal ties follow printf's default nearest-even, not JS toFixed's ties-up.
 */
export function canonicalBandingScore(value: number): number {
	if (!Number.isFinite(value) || value < 0)
		throw new Error("Banding score must be finite and nonnegative");
	if (value === 0) return 0;
	let fraction = value - Math.trunc(value);
	let leadingZeros = 0;
	while (fraction < 1 && fraction !== 0) {
		fraction *= 10;
		leadingZeros++;
	}
	const places = leadingZeros <= 6 ? 6 : 16;
	const bytes = new DataView(new ArrayBuffer(8));
	bytes.setFloat64(0, value);
	const bits = bytes.getBigUint64(0);
	const exponentBits = Number((bits >> 52n) & 0x7ffn);
	const significand =
		(bits & ((1n << 52n) - 1n)) | (exponentBits === 0 ? 0n : 1n << 52n);
	const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
	if (exponent >= 0) return value; // Already an exact integer.
	const numerator = significand * 10n ** BigInt(places);
	const denominator = 1n << BigInt(-exponent);
	let rounded = numerator / denominator;
	const twiceRemainder = 2n * (numerator % denominator);
	if (
		twiceRemainder > denominator ||
		(twiceRemainder === denominator && rounded % 2n !== 0n)
	)
		rounded++;
	const digits = rounded.toString().padStart(places + 1, "0");
	return Number(`${digits.slice(0, -places)}.${digits.slice(-places)}`);
}
