import { experimentResultSchema } from "@bitovp/core/encoding-experiments";

export function readMeasurement(
	value: unknown,
	runtimeId: string,
	frameCount: number,
) {
	const result = experimentResultSchema.parse(value);
	if (
		result.runtimeId !== runtimeId ||
		result.frameCount !== frameCount ||
		BigInt(result.durationTicks) * BigInt(result.timeBase.num) * 30n !==
			BigInt(frameCount) * BigInt(result.timeBase.den)
	)
		throw new Error("EXPERIMENT_RECEIPT_MISMATCH");
	return result;
}
