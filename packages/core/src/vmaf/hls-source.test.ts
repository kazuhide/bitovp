import { describe, expect, it } from "vitest";
import {
	hlsQcEvidenceOf,
	hlsQcEvidenceSchema,
	publicHlsQcEvidenceOf,
} from "./hls-source";

const object = (role: string, key: string, bytes: number) => ({
	role,
	key,
	bytes,
	sha256: "a".repeat(64),
	identity: { size: bytes, etag: '"pinned"' },
});
const witness = {
	version: 1,
	method: "FMP4_INIT_SEGMENTS",
	vmafJobId: "00000000-0000-4000-8000-000000000003",
	renditionKey: "v",
	muxingKey: "mux",
	bucket: "private-output",
	masterKey: "run/master.m3u8",
	mediaKey: "run/video.m3u8",
	objects: [
		object("MASTER", "run/master.m3u8", 20),
		object("MEDIA", "run/video.m3u8", 30),
		object("INIT", "run/video/init.mp4", 10),
		object("SEGMENT", "run/video/seg_0.m4s", 40),
	],
	segmentCount: 1,
	durationSeconds: 2,
	assembledSha256: "b".repeat(64),
	assembledBytes: 50,
	complete: true,
};

describe("retained HLS QC witness", () => {
	it("requires a complete ordered immutable object population", () => {
		expect(hlsQcEvidenceSchema.parse(witness)).toEqual(witness);
		for (const malformed of [
			{ ...witness, complete: false },
			{ ...witness, segmentCount: 2 },
			{ ...witness, assembledBytes: 49 },
			{ ...witness, objects: witness.objects.slice(1) },
			{
				...witness,
				objects: witness.objects.map((o) => ({
					...o,
					identity: { size: o.bytes },
				})),
			},
			{
				...witness,
				objects: witness.objects.map((o, i) =>
					i === 3 ? { ...o, key: witness.objects[2]?.key } : o,
				),
			},
		])
			expect(hlsQcEvidenceSchema.safeParse(malformed).success).toBe(false);
	});
	it("keeps object coordinates private and malformed receipts absent", () => {
		expect(hlsQcEvidenceOf({ hlsSource: witness })).toEqual(witness);
		expect(
			hlsQcEvidenceOf({ hlsSource: { ...witness, private: true } }),
		).toBeUndefined();
		const projected = publicHlsQcEvidenceOf({ hlsSource: witness });
		expect(projected).toEqual({
			version: 1,
			method: "FMP4_INIT_SEGMENTS",
			segmentCount: 1,
			durationSeconds: 2,
			assembledSha256: "b".repeat(64),
			assembledBytes: 50,
			complete: true,
		});
		expect(JSON.stringify(projected)).not.toMatch(
			/private-output|master.m3u8|pinned/,
		);
	});
});
