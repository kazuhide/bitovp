/** Explicit setup only. Job execution never imports this downloader. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../native/caption-alignment-model.json" with {
	type: "json",
};

async function verify(path, pin, signal) {
	const facts = await lstat(path);
	if (!facts.isFile() || facts.size !== pin.size)
		throw Error("CAPTION_ALIGNMENT_MODEL_MISMATCH");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		signal?.throwIfAborted();
		hash.update(chunk);
	}
	if (hash.digest("hex") !== pin.sha256)
		throw Error("CAPTION_ALIGNMENT_MODEL_MISMATCH");
}
export async function ensureAlignmentFile(
	directory,
	pin,
	signal,
	fetcher = fetch,
) {
	signal?.throwIfAborted();
	if (
		!isAbsolute(directory) ||
		pin.name === "." ||
		pin.name === ".." ||
		!/^[a-zA-Z0-9_.-]+$/.test(pin.name) ||
		!Number.isSafeInteger(pin.size) ||
		pin.size < 1 ||
		pin.size > 2_000_000_000 ||
		!/^[a-f0-9]{64}$/.test(pin.sha256)
	)
		throw Error("CAPTION_ALIGNMENT_SETUP_INVALID");
	await mkdir(directory, { recursive: true, mode: 0o755 });
	if (!(await lstat(directory)).isDirectory())
		throw Error("CAPTION_ALIGNMENT_SETUP_INVALID");
	const path = join(directory, pin.name);
	try {
		await verify(path, pin, signal);
		return "preserved";
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporary = join(directory, `.${pin.name}.${randomUUID()}.partial`);
	try {
		const response = await fetcher(
			`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${pin.name}`,
			{
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)])
					: AbortSignal.timeout(20 * 60_000),
			},
		);
		if (!response.ok || !response.body)
			throw Error("CAPTION_ALIGNMENT_DOWNLOAD_FAILED");
		const length = response.headers.get("content-length");
		if (length && Number(length) !== pin.size) {
			await response.body.cancel();
			throw Error("CAPTION_ALIGNMENT_MODEL_MISMATCH");
		}
		const handle = await open(temporary, "wx", 0o600);
		let bytes = 0;
		const hash = createHash("sha256");
		try {
			for await (const chunk of response.body) {
				signal?.throwIfAborted();
				bytes += chunk.length;
				if (bytes > pin.size) throw Error("CAPTION_ALIGNMENT_MODEL_MISMATCH");
				hash.update(chunk);
				await handle.writeFile(chunk);
			}
		} finally {
			await handle.close();
		}
		if (bytes !== pin.size || hash.digest("hex") !== pin.sha256)
			throw Error("CAPTION_ALIGNMENT_MODEL_MISMATCH");
		await chmod(temporary, 0o444);
		try {
			await link(temporary, path);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			await verify(path, pin, signal);
		}
		return "ready";
	} finally {
		await rm(temporary, { force: true });
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const directory = resolve(
		process.argv[2] ??
			"output/editing-preview/models/qwen3-forced-aligner-0.6b",
	);
	(async () => {
		for (const pin of manifest.files) await ensureAlignmentFile(directory, pin);
		console.log(
			JSON.stringify({
				status: "ready",
				directory,
				revision: manifest.revision,
				files: manifest.files.length,
			}),
		);
	})().catch(() => {
		console.error("CAPTION_ALIGNMENT_SETUP_FAILED");
		process.exitCode = 1;
	});
}
