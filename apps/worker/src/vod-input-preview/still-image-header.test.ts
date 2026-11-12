import { describe, expect, it } from "vitest";
import {
	inspectVodStillImage,
	vodStillImageDecodeBytes,
	vodStillImageOrientationFilters,
} from "./still-image-header";

const chunk = (name: string, data = Buffer.alloc(0)) => {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(data.length);
	header.write(name, 4);
	return Buffer.concat([header, data, Buffer.alloc(4)]);
};
function png(width = 320, height = 180, extra: Buffer[] = []) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", header),
		...extra,
		chunk("IDAT", Buffer.from([1])),
		chunk("IEND"),
	]);
}
function jpeg(orientation = 1, width = 320, height = 180) {
	const exif = Buffer.alloc(32);
	exif.write("Exif\0\0II");
	exif.writeUInt16LE(42, 8);
	exif.writeUInt32LE(8, 10);
	exif.writeUInt16LE(1, 14);
	exif.writeUInt16LE(0x112, 16);
	exif.writeUInt16LE(3, 18);
	exif.writeUInt32LE(1, 20);
	exif.writeUInt16LE(orientation, 24);
	const segment = (marker: number, data: Buffer) => {
		const start = Buffer.from([255, marker, 0, 0]);
		start.writeUInt16BE(data.length + 2, 2);
		return Buffer.concat([start, data]);
	};
	const dimensions = Buffer.alloc(9);
	dimensions[0] = 8;
	dimensions.writeUInt16BE(height, 1);
	dimensions.writeUInt16BE(width, 3);
	dimensions[5] = 1;
	return Buffer.concat([
		Buffer.from([255, 216]),
		segment(225, exif),
		segment(192, dimensions),
		segment(218, Buffer.from([1])),
		Buffer.from([1, 255, 0, 2, 255, 217]),
	]);
}

describe("bounded single-image headers", () => {
	it("reads dimensions and alpha PNG without decoding pixels", () => {
		expect(inspectVodStillImage(png())).toEqual({
			format: "PNG",
			width: 320,
			height: 180,
			orientation: 1,
		});
		const tagged = png(320, 180, [
			chunk("zTXt", Buffer.from("compressed metadata is not decoder input")),
		]);
		expect(
			vodStillImageDecodeBytes(tagged, inspectVodStillImage(tagged)),
		).toEqual(png());
	});
	it("reads all eight JPEG EXIF orientations and supplies explicit transforms", () => {
		for (let orientation = 1; orientation <= 8; orientation++)
			expect(inspectVodStillImage(jpeg(orientation))).toEqual({
				format: "JPEG",
				width: 320,
				height: 180,
				orientation,
			});
		expect(vodStillImageOrientationFilters(1)).toEqual([]);
		expect(vodStillImageOrientationFilters(5)).toEqual([
			"transpose=clock",
			"hflip",
		]);
		expect(vodStillImageOrientationFilters(6)).toEqual(["transpose=clock"]);
		expect(vodStillImageOrientationFilters(8)).toEqual(["transpose=cclock"]);
	});
	it("rejects animation, multiple frames, malformed EXIF, unsafe dimensions and decode budgets", () => {
		for (const bytes of [
			png(9000, 1),
			png(8192, 8192),
			png(0, 180),
			png(320, 180, [chunk("acTL", Buffer.alloc(8))]),
			png().subarray(0, 30),
			Buffer.concat([jpeg(), jpeg()]),
			jpeg(9),
			Buffer.from("not an image"),
		])
			expect(() => inspectVodStillImage(bytes)).toThrow();
	});
});
