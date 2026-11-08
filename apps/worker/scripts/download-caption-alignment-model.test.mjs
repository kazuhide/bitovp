import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAlignmentFile } from "./download-caption-alignment-model.mjs";

const body = Buffer.from("synthetic model config");
const pin = {
	name: "config.json",
	size: body.length,
	sha256: createHash("sha256").update(body).digest("hex"),
};
test("provisions once, preserves verified files, and never downloads during reuse", async () => {
	const directory = await mkdtemp(join(tmpdir(), "caption-model-test-"));
	try {
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return new Response(body);
		};
		await ensureAlignmentFile(directory, pin, undefined, fetcher);
		await ensureAlignmentFile(directory, pin, undefined, fetcher);
		assert.equal(calls, 1);
		assert.deepEqual(await readFile(join(directory, pin.name)), body);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("rejects existing corruption and incomplete downloads without replacing evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "caption-model-test-"));
	try {
		await assert.rejects(
			ensureAlignmentFile(
				directory,
				pin,
				undefined,
				async () => new Response("short"),
			),
		);
		assert.deepEqual(await readdir(directory), []);
		await writeFile(join(directory, pin.name), "corrupt");
		await assert.rejects(
			ensureAlignmentFile(directory, pin, undefined, async () => {
				throw Error("must not fetch");
			}),
		);
		assert.equal(await readFile(join(directory, pin.name), "utf8"), "corrupt");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("rejects path traversal and an already canceled setup", async () => {
	for (const name of ["../escape", ".", ".."]) {
		await assert.rejects(ensureAlignmentFile("/tmp", { ...pin, name }));
	}
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(ensureAlignmentFile("/tmp", pin, controller.signal));
});
