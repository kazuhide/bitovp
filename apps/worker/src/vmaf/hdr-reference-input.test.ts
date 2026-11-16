import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hdrReferenceInputOptions } from "./hdr-reference-input";

it("selects sequential MXF reading only for a declared HDR reference with a real header partition", async () => {
	const root = await mkdtemp(join(tmpdir(), "hdr-mxf-options-"));
	const path = join(root, "ref-0.mp4");
	const signal = new AbortController().signal;
	try {
		// Exact first 16 bytes of the saved original Meridian MXF header.
		await writeFile(
			path,
			Buffer.from("060e2b34020501010d01020101020400", "hex"),
		);
		expect(
			await hdrReferenceInputOptions(path, "P3_D65_PQ_RGB_FULL", signal),
		).toEqual(["-f", "mxf", "-seekable", "0"]);
		expect(await hdrReferenceInputOptions(path, undefined, signal)).toEqual([]);
		await writeFile(path, Buffer.from("00000018667479706d703432", "hex"));
		expect(
			await hdrReferenceInputOptions(path, "P3_D65_PQ_RGB_FULL", signal),
		).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
