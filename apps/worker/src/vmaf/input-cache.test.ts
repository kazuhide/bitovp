import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runInOrganization } from "../tenant/scope";
import { cachedVmafInput } from "./input-cache";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "vmaf-cache-"));
	dirs.push(dir);
	const path = join(dir, "source");
	await writeFile(path, "video");
	const identity = { size: 5, etag: '"current"' };
	const entry = {
		provider: "GCS_HMAC",
		bucket: "source",
		key: "video",
		path,
		sha256: createHash("sha256").update("video").digest("hex"),
		bytes: 5,
		identity,
	};
	const manifest = join(dir, "manifest.json");
	const save = () =>
		writeFile(manifest, JSON.stringify({ version: 1, entries: [entry] }));
	await save();
	const args = {
		credential: { provider: "GCS_HMAC", config: {}, secret: {} },
		bucket: "source",
		key: "video",
		destPath: join(dir, "link"),
	};
	return { entry, identity, manifest, args, save };
}
it("reuses only current HEAD and digest verified media; removing temp link preserves source", async () => {
	const f = await fixture();
	const result = await cachedVmafInput(f.args, f.identity, f.manifest);
	expect(result).toMatchObject({
		sha256: f.entry.sha256,
		bytes: 5,
		pinned: false,
		identity: f.identity,
	});
	expect(await readlink(f.args.destPath)).toBe(f.entry.path);
	await rm(f.args.destPath);
	expect(await readFile(f.entry.path, "utf8")).toBe("video");
});
it("rejects changed object version, size and cache digest", async () => {
	const f = await fixture();
	await expect(
		cachedVmafInput(f.args, { ...f.identity, etag: '"new"' }, f.manifest),
	).rejects.toThrow("version changed");
	await expect(
		cachedVmafInput(f.args, { ...f.identity, size: 6 }, f.manifest),
	).rejects.toThrow("identity");
	await writeFile(f.entry.path, "other");
	await expect(cachedVmafInput(f.args, f.identity, f.manifest)).rejects.toThrow(
		"digest mismatch",
	);
});
it("does not reuse across provider or without HEAD", async () => {
	const f = await fixture();
	expect(
		await cachedVmafInput(
			{ ...f.args, credential: { ...f.args.credential, provider: "AWS_S3" } },
			f.identity,
			f.manifest,
		),
	).toBeUndefined();
	expect(await cachedVmafInput(f.args, undefined, f.manifest)).toBeUndefined();
});
it("rejects unversioned cache and honors abort", async () => {
	const f = await fixture();
	f.entry.identity = { size: 5, etag: undefined } as never;
	await f.save();
	await expect(cachedVmafInput(f.args, f.identity, f.manifest)).rejects.toThrow(
		"requires an object version",
	);
	f.entry.identity = f.identity;
	await f.save();
	await expect(
		cachedVmafInput(
			{ ...f.args, signal: AbortSignal.abort() },
			f.identity,
			f.manifest,
		),
	).rejects.toThrow();
});

it("never reads the operator's legacy input cache for a different organization", async () => {
	const f = await fixture();
	expect(
		await runInOrganization("aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed", () =>
			cachedVmafInput(f.args, f.identity, "/missing/private-cache-manifest"),
		),
	).toBeUndefined();
});
