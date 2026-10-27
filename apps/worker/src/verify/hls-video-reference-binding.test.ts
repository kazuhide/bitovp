import { describe, expect, it } from "vitest";
import {
	checkHlsReferenceObjects,
	type HlsVideoReferences,
} from "./hls-video-reference-binding";

const reference = (
	key: string,
	range?: { offset?: number; length?: number },
): HlsVideoReferences["objects"][number] => ({
	key,
	reference: key,
	init: false,
	...(range ? { range } : {}),
});

describe("HLS referenced object bytes", () => {
	it.each([
		["missing", []],
		["empty", [{ key: "media.mp4", size: 0 }]],
		["negative", [{ key: "media.mp4", size: -1 }]],
		[
			"contradictory",
			[
				{ key: "media.mp4", size: 1000 },
				{ key: "media.mp4", size: 1100 },
			],
		],
	] as const)("rejects a %s object", (_name, listed) => {
		expect(
			checkHlsReferenceObjects(
				"bytes",
				[reference("media.mp4", { offset: 900, length: 100 })],
				listed,
			).verdict,
		).toBe("FAIL");
	});
	it.each([
		{ offset: 900, length: 200 },
		{ offset: -1, length: 100 },
		{ offset: 0, length: 0 },
		{ offset: 0.5, length: 100 },
		{ length: 100 },
		{ offset: Number.MAX_SAFE_INTEGER, length: 2 },
	])("rejects an invalid range %j", (range) => {
		expect(
			checkHlsReferenceObjects(
				"bytes",
				[reference("media.mp4", range)],
				[{ key: "media.mp4", size: 1000 }],
			).verdict,
		).toBe("FAIL");
	});
	it("checks every initialization range when several maps share one object", () => {
		const references = [
			{ ...reference("media.mp4", { offset: 0, length: 100 }), init: true },
			reference("media.mp4", { offset: 100, length: 400 }),
			{ ...reference("media.mp4", { offset: 500, length: 100 }), init: true },
			reference("media.mp4", { offset: 600, length: 400 }),
		];
		const listed = [{ key: "media.mp4", size: 1000 }];
		expect(checkHlsReferenceObjects("bytes", references, listed).verdict).toBe(
			"PASS",
		);
		references[2] = {
			...reference("media.mp4", { offset: 900, length: 200 }),
			init: true,
		};
		expect(checkHlsReferenceObjects("bytes", references, listed).verdict).toBe(
			"FAIL",
		);
	});
	it("reports missing size evidence without masking a proven overrun elsewhere", () => {
		const listed = [{ key: "unknown.mp4" }, { key: "media.mp4", size: 1000 }];
		const references = [
			reference("unknown.mp4"),
			reference("media.mp4", { offset: 900, length: 100 }),
		];
		expect(checkHlsReferenceObjects("bytes", references, listed).verdict).toBe(
			"SKIP",
		);
		references[1] = reference("media.mp4", { offset: 900, length: 200 });
		expect(checkHlsReferenceObjects("bytes", references, listed).verdict).toBe(
			"FAIL",
		);
	});
});
