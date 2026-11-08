/** Frame index relative to the original presentation origin of a fixed 30 fps map. */
export function originalTimeToCfrFrame(
	us: number,
	sourceStartUs: number,
	rounding: "FLOOR" | "CEIL",
): bigint {
	if (
		!Number.isSafeInteger(us) ||
		us < 0 ||
		!Number.isSafeInteger(sourceStartUs) ||
		sourceStartUs < 0 ||
		(rounding !== "FLOOR" && rounding !== "CEIL")
	)
		throw new RangeError("Invalid original CFR time");
	const scaled = (BigInt(us) - BigInt(sourceStartUs)) * 30n;
	const frame = scaled / 1_000_000n;
	if (scaled % 1_000_000n === 0n) return frame;
	if (rounding === "FLOOR") return scaled < 0n ? frame - 1n : frame;
	return scaled > 0n ? frame + 1n : frame;
}
