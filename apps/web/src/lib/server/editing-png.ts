import { inflateSync } from "node:zlib";

const signature = Buffer.from("89504e470d0a1a0a", "hex");
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++)
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type: string, data: Buffer) {
	const bytes = Buffer.alloc(data.length + 12);
	bytes.writeUInt32BE(data.length);
	bytes.write(type, 4, 4, "ascii");
	data.copy(bytes, 8);
	bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
	return bytes;
}

/** Small, nonanimated, 8-bit RGB/RGBA/grayscale PNGs; no external references or ancillary data. */
export function canonicalEditingPng(input: Uint8Array) {
	const fail = (): never => {
		throw new Error("INVALID_EDITING_PNG");
	};
	const bytes = Buffer.from(input);
	if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(signature))
		fail();
	let offset = 8,
		header: Buffer | undefined,
		ended = false,
		idatEnded = false;
	const chunks: Buffer[] = [];
	while (offset + 12 <= bytes.length) {
		const size = bytes.readUInt32BE(offset),
			end = offset + size + 12;
		if (end > bytes.length) fail();
		const type = bytes.toString("ascii", offset + 4, offset + 8),
			data = bytes.subarray(offset + 8, end - 4);
		if (
			!/^[A-Za-z]{4}$/.test(type) ||
			crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
		)
			fail();
		if (!header && type !== "IHDR") fail();
		if (type === "IHDR") {
			if (header || size !== 13) fail();
			header = Buffer.from(data);
		} else if (type === "IDAT") {
			if (idatEnded) fail();
			chunks.push(data);
		} else {
			if (chunks.length) idatEnded = true;
			if (type === "IEND") {
				if (size || end !== bytes.length) fail();
				ended = true;
				offset = end;
				break;
			}
			if (
				type === "acTL" ||
				type === "fcTL" ||
				type === "fdAT" ||
				type[0] === type[0]?.toUpperCase()
			)
				fail();
		}
		offset = end;
	}
	if (!header || !ended || !chunks.length || offset !== bytes.length)
		return fail();
	const width = header.readUInt32BE(0),
		height = header.readUInt32BE(4),
		channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
			header[9] ?? -1
		];
	if (
		!width ||
		!height ||
		width > 2048 ||
		height > 2048 ||
		!channels ||
		header[8] !== 8 ||
		header[10] ||
		header[11] ||
		header[12]
	)
		return fail();
	const stride = width * channels + 1,
		length = stride * height;
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: length });
	} catch {
		return fail();
	}
	if (raw.length !== length) fail();
	for (let row = 0; row < height; row++)
		if ((raw[row * stride] ?? 5) > 4) fail();
	return {
		width,
		height,
		bytes: Buffer.concat([
			signature,
			pngChunk("IHDR", header),
			pngChunk("IDAT", Buffer.concat(chunks)),
			pngChunk("IEND", Buffer.alloc(0)),
		]),
	};
}
