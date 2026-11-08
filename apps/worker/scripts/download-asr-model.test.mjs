import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ASR_MODELS,
	BASE_MODEL,
	ensureModel,
	VAD_MODEL,
} from "./download-asr-model.mjs";

const model = Buffer.from("public test model"),
	sha256 = createHash("sha256").update(model).digest("hex");
const turbo = {
	url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
	size: 574041195,
	sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
	fileName: "ggml-large-v3-turbo-q5_0.bin",
};
async function fixture(fn) {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-model-test-"));
	try {
		await fn({
			...BASE_MODEL,
			size: model.length,
			sha256,
			file: join(directory, "model.bin"),
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
test("checks actual cached identity without overwriting a changed model", async () =>
	fixture(async (input) => {
		await writeFile(input.file, model);
		assert.equal((await ensureModel(input)).status, "preserved");
		await writeFile(input.file, "changed");
		await assert.rejects(ensureModel(input), /ASR_MODEL_IDENTITY_MISMATCH/);
		assert.equal(await readFile(input.file, "utf8"), "changed");
	}));
test("honors cancellation even when the requested model is already cached", async () =>
	fixture(async (input) => {
		await writeFile(input.file, model);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(ensureModel(input, controller.signal), {
			name: "AbortError",
		});
	}));
test("atomically publishes only verified complete bytes and makes them readonly", async (t) =>
	fixture(async (input) => {
		t.mock.method(globalThis, "fetch", async () => new Response(model));
		assert.equal((await ensureModel(input)).status, "ready");
		assert.deepEqual(await readFile(input.file), model);
		assert.equal((await stat(input.file)).mode & 0o222, 0);
	}));
test("does not publish oversized or truncated downloaded bytes", async (t) =>
	fixture(async (input) => {
		for (const bytes of [model.subarray(0, 3), Buffer.concat([model, model])]) {
			t.mock.method(globalThis, "fetch", async () => new Response(bytes));
			await assert.rejects(ensureModel(input), /ASR_MODEL_IDENTITY_MISMATCH/);
			await assert.rejects(stat(input.file), { code: "ENOENT" });
		}
	}));
test("verifies complete VAD bytes through the fixed official URL and rejects other VAD revisions", async (t) =>
	fixture(async (input) => {
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (url) => {
			assert.equal(url, VAD_MODEL.url);
			requests++;
			return new Response(model);
		});
		await assert.rejects(
			ensureModel({
				...input,
				url: VAD_MODEL.url.replace(
					"9ffd54a1e1ee413ddf265af9913beaf518d1639b",
					"main",
				),
			}),
			/ASR_MODEL_SETUP_INVALID/,
		);
		assert.equal(requests, 0);
		assert.equal(
			(await ensureModel({ ...input, url: VAD_MODEL.url })).status,
			"ready",
		);
		assert.equal(requests, 1);
		assert.deepEqual(await readFile(input.file), model);
	}));

test("registers the immutable official turbo q5 profile without changing base or small pins", () => {
	assert.deepEqual(ASR_MODELS["large-v3-turbo-q5_0"], turbo);
	assert.equal(Object.isFrozen(ASR_MODELS["large-v3-turbo-q5_0"]), true);
	assert.equal(ASR_MODELS.base.sha256, BASE_MODEL.sha256);
	assert.equal(ASR_MODELS.small.size, 487601967);
	assert.equal(
		ASR_MODELS.small.sha256,
		"1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
	);
});

test("admits only the exact pinned turbo tuple above the ordinary 512 MiB setup limit", async (t) =>
	fixture(async (input) => {
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (url) => {
			assert.equal(url, turbo.url);
			requests++;
			return new Response(null, { status: 503 });
		});
		const candidate = { ...turbo, file: input.file };
		for (const change of [
			{ sha256: "a".repeat(64) },
			{ size: turbo.size + 1 },
			{ size: turbo.size - 1 },
			{
				url: turbo.url.replace(
					"5359861c739e955e79d9a303bcbc70fb988958b1",
					"main",
				),
			},
			{ url: VAD_MODEL.url },
		])
			await assert.rejects(
				ensureModel({ ...candidate, ...change }),
				/ASR_MODEL_SETUP_INVALID/,
			);
		assert.equal(requests, 0);
		await assert.rejects(ensureModel(candidate), /ASR_MODEL_DOWNLOAD_FAILED/);
		assert.equal(requests, 1);
		await assert.rejects(stat(input.file), { code: "ENOENT" });
	}));
