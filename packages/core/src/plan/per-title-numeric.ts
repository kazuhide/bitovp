/** Exact decimal value sent by JSON serialization of a positive API parameter. */
export function decimalParameter(value: number): { n: bigint; d: bigint } {
	if (!Number.isFinite(value) || value <= 0)
		throw new RangeError("Expected a finite positive parameter");
	const [coefficient = "", exponent = "0"] = value.toString().split("e");
	const [whole = "", decimal = ""] = coefficient.split(".");
	const numerator = BigInt(whole + decimal);
	const scale = decimal.length - Number(exponent);
	return scale <= 0
		? { n: numerator * 10n ** BigInt(-scale), d: 1n }
		: { n: numerator, d: 10n ** BigInt(scale) };
}
