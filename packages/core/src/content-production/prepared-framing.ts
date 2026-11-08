import {
	getPreparedShotPartitionEntry,
	type PreparedShotPartition,
} from "../content-editing/prepared-shot-partition";
import {
	type EditFraming,
	editFramingSchema,
	type NormalizedCropRect,
} from "../content-editing/schema";

/** Preserve clip frames and audio while withholding crop in an uncertain cut band. */
export function preparedShotFraming(input: {
	partition?: PreparedShotPartition;
	sceneId: string;
	shotIndex?: number;
	fromFrame: number;
	durationFrames: number;
	proposal: { mode: "FIT" | "CROP"; rect?: NormalizedCropRect };
}): EditFraming[] {
	const { durationFrames, fromFrame, proposal, partition } = input;
	if (
		!Number.isSafeInteger(fromFrame) ||
		fromFrame < 0 ||
		!Number.isSafeInteger(durationFrames) ||
		durationFrames < 1 ||
		durationFrames > 5400
	)
		throw new RangeError("Expected a bounded prepared clip");
	const part = (from: number, to: number, fit: boolean): EditFraming =>
		editFramingSchema.parse({
			fromFrame: from,
			toFrame: to,
			origin: "AUTO_POLICY",
			mode: fit ? "FIT" : proposal.mode,
			...(!fit && proposal.mode === "CROP" ? { rect: proposal.rect } : {}),
		});
	if (!partition) return [part(0, durationFrames, false)];
	const entry = getPreparedShotPartitionEntry(partition, input);
	const endFrame = fromFrame + durationFrames;
	if (!entry || fromFrame < entry.fromFrame || endFrame > entry.toFrame)
		throw new RangeError("Framing window exceeds its prepared shot");
	const bands = entry.fitBands
		.map((band) => ({
			from: Math.max(0, band.fromFrame - fromFrame),
			to: Math.min(durationFrames, band.toFrame - fromFrame),
		}))
		.filter((band) => band.to > band.from);
	const boundaries = [
		...new Set([
			0,
			durationFrames,
			...bands.flatMap((band) => [band.from, band.to]),
		]),
	].sort((a, b) => a - b);
	return boundaries.slice(0, -1).map((from, index) => {
		const to = boundaries[index + 1];
		if (to === undefined) throw new RangeError("Missing prepared framing end");
		return part(
			from,
			to,
			bands.some((band) => band.from <= from && band.to >= to),
		);
	});
}
