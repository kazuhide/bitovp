import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// MOV clean-aperture atom, applied by ffmpeg CLI but not by ffprobe's decoder.
// Keep moov after mdat so inserting metadata cannot invalidate chunk offsets.
export function createContainerCropFixture(
	dir: string,
	ffmpeg = "ffmpeg",
	{ width = 128, height = 90, frames = 24 } = {},
) {
	const original = join(dir, "codec-crop.mov"),
		cropped = join(dir, "container-crop.mov");
	execFileSync(
		ffmpeg,
		[
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=size=${width}x${height}:rate=24`,
			"-frames:v",
			String(frames),
			"-c:v",
			"libx264",
			"-crf",
			"0",
			"-pix_fmt",
			"yuv420p",
			original,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	const input = readFileSync(original),
		clap = Buffer.alloc(40);
	clap.writeUInt32BE(40, 0);
	clap.write("clap", 4);
	for (const [i, n] of [width - 32, 1, height - 18, 1, 0, 1, 0, 1].entries())
		clap.writeUInt32BE(n, 8 + i * 4);
	let inserted = 0;
	const rewrite = (buffer: Buffer): Buffer => {
		const chunks: Buffer[] = [];
		for (let pos = 0; pos < buffer.length; ) {
			const size = buffer.readUInt32BE(pos),
				type = buffer.toString("ascii", pos + 4, pos + 8);
			if (size < 8 || pos + size > buffer.length)
				throw Error("Invalid fixture atom");
			const atom = buffer.subarray(pos, pos + size);
			let replacement = atom;
			if (["moov", "trak", "mdia", "minf", "stbl"].includes(type))
				replacement = Buffer.concat([
					atom.subarray(0, 8),
					rewrite(atom.subarray(8)),
				]);
			if (type === "stsd") {
				const entrySize = atom.readUInt32BE(16);
				if (atom.toString("ascii", 20, 24) !== "avc1")
					throw Error("Missing AVC fixture entry");
				const entry = Buffer.concat([atom.subarray(16, 16 + entrySize), clap]);
				entry.writeUInt32BE(entry.length, 0);
				replacement = Buffer.concat([
					atom.subarray(0, 16),
					entry,
					atom.subarray(16 + entrySize),
				]);
				inserted++;
			}
			if (replacement !== atom)
				replacement.writeUInt32BE(replacement.length, 0);
			chunks.push(replacement);
			pos += size;
		}
		return Buffer.concat(chunks);
	};
	if (input.indexOf(Buffer.from("moov")) < input.indexOf(Buffer.from("mdat")))
		throw Error("Fixture must put moov last");
	const modified = rewrite(input);
	if (inserted !== 1) throw Error("Ambiguous fixture crop");
	writeFileSync(cropped, modified);
	return { original, cropped, width, height };
}
