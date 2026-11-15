import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createVmafModelResolver } from "./model-path";

const hdr = "hdr_vmaf_v1.1.8_3d0h_2160";
const sdr = "vmaf_v1.0.16_3d0h_2160";
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bitovp-models-"));
	await mkdir(join(root, "sdr"));
	await mkdir(join(root, "hdr"));
	await writeFile(join(root, "sdr", `${sdr}.json`), "sdr-original");
	await writeFile(join(root, "sdr", `${hdr}.json`), "old-shared-hdr");
	await writeFile(join(root, "hdr", `${hdr}.json`), "isolated-hdr");
	await writeFile(join(root, "hdr", `${sdr}.json`), "wrong-sdr-copy");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it("resolves HDR from its isolated runtime while preserving the SDR path", () => {
	const resolve = createVmafModelResolver({
		sdrDir: join(root, "sdr"),
		hdrDir: join(root, "hdr"),
	});
	expect(resolve?.(hdr)).toBe(join(root, "hdr", `${hdr}.json`));
	expect(resolve?.(sdr)).toBe(join(root, "sdr", `${sdr}.json`));
});
it("does not silently use an older shared HDR file if the isolated file is missing", async () => {
	await rm(join(root, "hdr", `${hdr}.json`));
	const resolve = createVmafModelResolver({
		sdrDir: join(root, "sdr"),
		hdrDir: join(root, "hdr"),
	});
	expect(resolve?.(hdr)).toBeUndefined();
});
it("retains existing shared-directory installations when no HDR directory is configured", () => {
	const resolve = createVmafModelResolver({ sdrDir: join(root, "sdr") });
	expect(resolve?.(hdr)).toBe(join(root, "sdr", `${hdr}.json`));
	expect(resolve?.(sdr)).toBe(join(root, "sdr", `${sdr}.json`));
});
it("does not take SDR files from a standalone HDR runtime", () => {
	const resolve = createVmafModelResolver({ hdrDir: join(root, "hdr") });
	expect(resolve?.(hdr)).toBe(join(root, "hdr", `${hdr}.json`));
	expect(resolve?.(sdr)).toBeUndefined();
});
it("leaves the built-in model path unchanged without any model directory", () => {
	expect(createVmafModelResolver({})).toBeUndefined();
});
