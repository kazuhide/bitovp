/** Explicit public setup only; inference modules never access the network. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asrModelProfiles from "../native/asr-model-profiles.json" with {
	type: "json",
};

export const ASR_MODELS = Object.freeze(
	Object.fromEntries(
		Object.entries(asrModelProfiles).map(([name, profile]) => [
			name,
			Object.freeze(profile),
		]),
	),
);
export const BASE_MODEL = Object.freeze({
	url: ASR_MODELS.base.url,
	size: ASR_MODELS.base.size,
	sha256: ASR_MODELS.base.sha256,
});
export const VAD_MODEL = Object.freeze({
	url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
	size: 885098,
	sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
	fileName: "ggml-silero-v6.2.0.bin",
});
async function verify(file, size, sha256, signal) {
	const facts = await stat(file);
	if (!facts.isFile() || facts.size !== size)
		throw new Error("ASR_MODEL_IDENTITY_MISMATCH");
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(file)) {
		signal?.throwIfAborted();
		hash.update(bytes);
	}
	if (hash.digest("hex") !== sha256)
		throw new Error("ASR_MODEL_IDENTITY_MISMATCH");
}
export async function ensureModel({ file, url, size, sha256 }, signal) {
	signal?.throwIfAborted();
	if (
		!isAbsolute(file) ||
		(!url.startsWith("https://huggingface.co/ggerganov/whisper.cpp/resolve/") &&
			url !== VAD_MODEL.url) ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		(size > 512 * 1024 * 1024 &&
			!Object.values(ASR_MODELS).some(
				(profile) =>
					profile.url === url &&
					profile.size === size &&
					profile.sha256 === sha256,
			)) ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		throw new Error("ASR_MODEL_SETUP_INVALID");
	try {
		await verify(file, size, sha256, signal);
		return { file, size, sha256, status: "preserved" };
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.partial`;
	try {
		const response = await fetch(url, {
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
				: AbortSignal.timeout(10 * 60_000),
		});
		if (!response.ok || !response.body)
			throw new Error("ASR_MODEL_DOWNLOAD_FAILED");
		const declared = response.headers.get("content-length");
		if (declared && Number(declared) !== size) {
			await response.body.cancel();
			throw new Error("ASR_MODEL_IDENTITY_MISMATCH");
		}
		const handle = await open(temporary, "wx", 0o600),
			hash = createHash("sha256");
		let bytes = 0;
		try {
			for await (const chunk of response.body) {
				signal?.throwIfAborted();
				bytes += chunk.length;
				if (bytes > size) throw new Error("ASR_MODEL_IDENTITY_MISMATCH");
				hash.update(chunk);
				await handle.writeFile(chunk);
			}
		} finally {
			await handle.close();
		}
		if (bytes !== size || hash.digest("hex") !== sha256)
			throw new Error("ASR_MODEL_IDENTITY_MISMATCH");
		await chmod(temporary, 0o444);
		try {
			await link(temporary, file);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			await verify(file, size, sha256, signal);
		}
		return { file, size, sha256, status: "ready" };
	} finally {
		await rm(temporary, { force: true });
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	ensureModel({
		...BASE_MODEL,
		file: resolve(process.argv[2] ?? "models/ggml-base.bin"),
	})
		.then((result) => console.log(JSON.stringify(result)))
		.catch(() => {
			console.error("ASR_MODEL_SETUP_FAILED");
			process.exitCode = 1;
		});
}
