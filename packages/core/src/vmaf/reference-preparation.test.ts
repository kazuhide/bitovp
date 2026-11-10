import { describe, expect, it } from "vitest";
import {
	referencePreparationOf,
	vmafReferencePreparationEvidenceSchema,
} from "./reference-preparation";

const evidence = {
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

describe("public reference preparation evidence", () => {
	it("retains complete verification evidence without private provenance", () => {
		expect(vmafReferencePreparationEvidenceSchema.parse(evidence)).toEqual(
			evidence,
		);
		expect(
			referencePreparationOf({
				referencePreparation: evidence,
				reference: { path: "/private/original.mov" },
				preparedPath: "/private/prepared.mov",
			}),
		).toEqual(evidence);
	});

	it.each([
		{ version: 2 },
		{ method: "SCALE" },
		{ comparisonSpace: "DISPLAY" },
		{ inputSha256: "A".repeat(64) },
		{ preparedSha256: "bad" },
		{ packetSha256: "bad" },
		{ frameSha256: "bad" },
		{ streamIdentitySha256: "bad" },
		{ preparedBytes: 0 },
		{ preparedBytes: Number.MAX_SAFE_INTEGER + 1 },
		{ sourceDisplayMatrix: evidence.sourceDisplayMatrix.slice(1) },
		{ sourceDisplayMatrix: [...evidence.sourceDisplayMatrix, 0] },
		{ sourceDisplayMatrix: [0.5, ...evidence.sourceDisplayMatrix.slice(1)] },
		{
			sourceDisplayMatrix: [
				2147483648,
				...evidence.sourceDisplayMatrix.slice(1),
			],
		},
		{ width: 16385 },
		{ height: 0 },
		{ codec: "h264 /private/source" },
		{ pixelFormat: "x".repeat(33) },
		{ timeBase: "1/0" },
		{ timeBase: "0/24" },
		{ timeBase: "1/9007199254740992" },
		{ packetCount: 0 },
		{ frameCount: 1.5 },
		{ packetTimingVerified: false },
		{ frameTimingVerified: false },
		{ path: "/private/prepared.mov" },
	])("withholds invalid or private preparation evidence: %j", (changes) => {
		const invalid = { ...evidence, ...changes };
		expect(
			vmafReferencePreparationEvidenceSchema.safeParse(invalid).success,
		).toBe(false);
		expect(
			referencePreparationOf({ referencePreparation: invalid }),
		).toBeUndefined();
	});

	it.each([
		null,
		undefined,
		1,
		[],
		{},
		{ referencePreparation: null },
	])("leaves historical or missing evidence absent: %j", (provenance) =>
		expect(referencePreparationOf(provenance)).toBeUndefined());
});
