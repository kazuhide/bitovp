import { deflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { canonicalEditingPng, pngChunk } from "./editing-png";

function image(
	width = 1,
	height = 1,
	pixels = Buffer.from([0, 255, 0, 0, 255]),
) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", header),
		pngChunk("tEXt", Buffer.from("private\0metadata")),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}
test("validates pixel bytes and strips nonessential metadata", () => {
	const result = canonicalEditingPng(image());
	expect(result).toMatchObject({ width: 1, height: 1 });
	expect(result.bytes.includes(Buffer.from("private"))).toBe(false);
	expect(canonicalEditingPng(result.bytes).bytes).toEqual(result.bytes);
});
test("rejects corrupt CRC, invalid pixel filters, extra payload and oversized dimensions", () => {
	const corrupt = image();
	corrupt[29] = (corrupt[29] ?? 0) ^ 1;
	for (const bytes of [
		corrupt,
		image(1, 1, Buffer.from([5, 1, 2, 3, 4])),
		Buffer.concat([image(), Buffer.from("extra")]),
		image(2049),
		image(1, 1, Buffer.alloc(100)),
	])
		expect(() => canonicalEditingPng(bytes)).toThrow("INVALID_EDITING_PNG");
});

test("admits the documented 2048 square when compressed bytes remain within the upload limit", () => {
	const pixels = Buffer.alloc((2048 * 4 + 1) * 2048);
	const result = canonicalEditingPng(image(2048, 2048, pixels));
	expect(result).toMatchObject({ width: 2048, height: 2048 });
	expect(result.bytes.length).toBeLessThan(8 * 1024 * 1024);
});
