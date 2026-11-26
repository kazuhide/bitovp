import {
	MAX_VOD_INPUT_IMAGE_BYTES,
	MAX_VOD_INPUT_IMAGE_PIXELS,
} from "@bitovp/core/vod-input-timeline";
import { MediaOperationError } from "../library-editing/process";

export type VodStillImageHeader = {
	format: "PNG" | "JPEG";
	width: number;
	height: number;
	orientation: number;
};
const invalid = (): never => {
	throw new MediaOperationError("IMAGE_UNSUPPORTED");
};

function exifOrientation(bytes: Buffer): number {
	if (bytes.length < 8) return invalid();
	const order = bytes.toString("ascii", 0, 2);
	if (order !== "II" && order !== "MM") return invalid();
	const little = order === "II";
	const word = (offset: number) =>
		little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
	const long = (offset: number) =>
		little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
	if (word(2) !== 42) return invalid();
	const offset = long(4);
	if (offset < 8 || offset + 2 > bytes.length) return invalid();
	const count = word(offset);
	if (count > 1024 || offset + 2 + count * 12 > bytes.length) return invalid();
	let found: number | undefined;
	for (let i = 0; i < count; i++) {
		const entry = offset + 2 + i * 12;
		if (word(entry) !== 0x112) continue;
		if (found !== undefined || word(entry + 2) !== 3 || long(entry + 4) !== 1)
			return invalid();
		found = word(entry + 8);
		if (found < 1 || found > 8) return invalid();
	}
	return found ?? 1;
}

function png(bytes: Buffer): VodStillImageHeader {
	let position = 8,
		width = 0,
		height = 0,
		orientation = 1,
		seenPixels = false,
		seenExif = false;
	while (position + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(position),
			type = bytes.toString("ascii", position + 4, position + 8);
		if (position + 12 + length > bytes.length || !/^[A-Za-z]{4}$/.test(type))
			return invalid();
		const data = bytes.subarray(position + 8, position + 8 + length);
		if (position === 8 && type !== "IHDR") return invalid();
		if (type === "IHDR") {
			if (position !== 8 || length !== 13) return invalid();
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (
				![1, 2, 4, 8, 16].includes(data[8] ?? 0) ||
				![0, 2, 3, 4, 6].includes(data[9] ?? -1) ||
				data[10] !== 0 ||
				data[11] !== 0 ||
				![0, 1].includes(data[12] ?? -1)
			)
				return invalid();
		}
		if (["acTL", "fcTL", "fdAT"].includes(type)) return invalid();
		if (
			type[0] === type[0]?.toUpperCase() &&
			!["IHDR", "PLTE", "IDAT", "IEND"].includes(type)
		)
			return invalid();
		if (type === "eXIf") {
			if (seenExif) return invalid();
			orientation = exifOrientation(data);
			seenExif = true;
		}
		if (type === "IDAT") seenPixels = true;
		position += length + 12;
		if (type === "IEND") {
			if (length !== 0 || !seenPixels || position !== bytes.length)
				return invalid();
			return { format: "PNG", width, height, orientation };
		}
	}
	return invalid();
}

function jpeg(bytes: Buffer): VodStillImageHeader {
	let position = 2,
		scan = false,
		width = 0,
		height = 0,
		orientation = 1,
		seenExif = false,
		seenScan = false;
	while (position < bytes.length) {
		if (scan && bytes[position] !== 255) {
			position++;
			continue;
		}
		if (bytes[position++] !== 255) return invalid();
		while (bytes[position] === 255) position++;
		const marker = bytes[position++];
		if (marker === undefined) return invalid();
		if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
		scan = false;
		if (marker === 0xd9) {
			if (!width || !seenScan || position !== bytes.length) return invalid();
			return { format: "JPEG", width, height, orientation };
		}
		if (marker === 0 || marker === 0xd8 || position + 2 > bytes.length)
			return invalid();
		if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		const length = bytes.readUInt16BE(position);
		if (length < 2 || position + length > bytes.length) return invalid();
		const data = bytes.subarray(position + 2, position + length);
		if ([0xc0, 0xc1, 0xc2].includes(marker)) {
			if (width || data.length < 6 || data[0] !== 8) return invalid();
			height = data.readUInt16BE(1);
			width = data.readUInt16BE(3);
		}
		if (
			marker === 0xe1 &&
			data.subarray(0, 6).equals(Buffer.from("Exif\0\0"))
		) {
			if (seenExif) return invalid();
			orientation = exifOrientation(data.subarray(6));
			seenExif = true;
		}
		if (marker === 0xe2 && data.toString("ascii", 0, 4) === "MPF\0")
			return invalid();
		if (marker === 0xda) {
			scan = true;
			seenScan = true;
		}
		position += length;
	}
	return invalid();
}

/** Inspect the compressed header before any pixel allocation or image decoder runs. */
export function inspectVodStillImage(bytes: Buffer): VodStillImageHeader {
	if (bytes.length < 12 || bytes.length > MAX_VOD_INPUT_IMAGE_BYTES)
		return invalid();
	const result = bytes
		.subarray(0, 8)
		.equals(Buffer.from("89504e470d0a1a0a", "hex"))
		? png(bytes)
		: bytes[0] === 255 && bytes[1] === 216
			? jpeg(bytes)
			: invalid();
	if (
		!result.width ||
		!result.height ||
		result.width > 8192 ||
		result.height > 8192 ||
		result.width * result.height > MAX_VOD_INPUT_IMAGE_PIXELS
	)
		return invalid();
	return result;
}

export function vodStillImageOrientationFilters(orientation: number): string[] {
	switch (orientation) {
		case 1:
			return [];
		case 2:
			return ["hflip"];
		case 3:
			return ["hflip", "vflip"];
		case 4:
			return ["vflip"];
		case 5:
			return ["transpose=clock", "hflip"];
		case 6:
			return ["transpose=clock"];
		case 7:
			return ["transpose=clock", "vflip"];
		case 8:
			return ["transpose=cclock"];
		default:
			return invalid();
	}
}

/** Drop compressed ancillary text/profiles so their inflation cannot bypass the pixel budget. */
export function vodStillImageDecodeBytes(
	bytes: Buffer,
	header: VodStillImageHeader,
): Buffer {
	if (header.format !== "PNG") return bytes;
	const chunks = [bytes.subarray(0, 8)];
	for (let position = 8; position < bytes.length; ) {
		const length = bytes.readUInt32BE(position),
			end = position + 12 + length;
		const type = bytes.toString("ascii", position + 4, position + 8);
		if (
			["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "sRGB", "gAMA", "cHRM"].includes(
				type,
			)
		)
			chunks.push(bytes.subarray(position, end));
		position = end;
	}
	return Buffer.concat(chunks);
}
