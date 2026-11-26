import { open } from "node:fs/promises";
import type { HdrReferenceColor } from "@bitovp/core";

/** Only inspect the bounded MXF header partition of an explicitly declared
 * reference. Downloaded cache names are ref-N.mp4 regardless of container. */
export async function hdrReferenceInputOptions(
	path: string,
	declaration: HdrReferenceColor | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	if (declaration !== "P3_D65_PQ_RGB_FULL") return [];
	signal.throwIfAborted();
	const input = await open(path, "r");
	try {
		const header = Buffer.alloc(16);
		const { bytesRead } = await input.read(header, 0, 16, 0);
		signal.throwIfAborted();
		if (
			bytesRead !== 16 ||
			!header
				.subarray(0, 14)
				.equals(Buffer.from("060e2b34020501010d0102010102", "hex")) ||
			(header[14] ?? 0) < 1 ||
			(header[14] ?? 0) > 4 ||
			header[15] !== 0
		)
			return [];
		// Official file protocol: seekable=0 prevents footer seeks in PHDR MXF.
		// https://ffmpeg.org/ffmpeg-protocols.html#file
		return ["-f", "mxf", "-seekable", "0"];
	} finally {
		await input.close();
	}
}
