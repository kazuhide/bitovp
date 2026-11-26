import type { VmafReferencePreparationEvidence } from "@bitovp/core";

export const referencePreparationEvidence: VmafReferencePreparationEvidence = {
	version: 1,
	method: "LOSSLESS_DISPLAY_SCALE_REMUX",
	comparisonSpace: "CODED_RASTER",
	inputSha256: "a".repeat(64),
	preparedSha256: "b".repeat(64),
	preparedBytes: 123456,
	sourceDisplayMatrix: [34464, 0, 0, 0, 34464, 0, 0, 0, 1073741824],
	width: 1920,
	height: 1080,
	codec: "h264",
	pixelFormat: "yuv420p",
	timeBase: "1/12288",
	packetCount: 14315,
	frameCount: 14315,
	packetSha256: "c".repeat(64),
	frameSha256: "d".repeat(64),
	streamIdentitySha256: "e".repeat(64),
	packetTimingVerified: true,
	frameTimingVerified: true,
};
