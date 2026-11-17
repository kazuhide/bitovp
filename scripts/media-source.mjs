#!/usr/bin/env node
/** Reuse only the complete official media input pinned by the media smoke test. */
import assert from "node:assert/strict";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { failureLines, isEntryPoint } from "./gate-report.mjs";
import {
	downloadArchive,
	extractSource,
	MAX_BYTES,
	SOURCE_SHA,
	verifySource,
} from "./media-smoke.mjs";

export function sourcePath(cache) {
	assert(
		typeof cache === "string" && isAbsolute(cache),
		"Media source cache must be absolute",
	);
	return join(resolve(cache), `${SOURCE_SHA}.mp4`);
}
function cacheDirectory(cache) {
	const stat = lstatSync(cache);
	assert(
		stat.isDirectory() && !stat.isSymbolicLink(),
		"Media source cache must be a regular directory",
	);
	return stat;
}
async function checkedSource(file, verify, signal) {
	signal.throwIfAborted();
	const before = lstatSync(file, { bigint: true });
	assert(
		before.isFile() && !before.isSymbolicLink(),
		"Cached media source must be a regular file",
	);
	assert(
		before.size > 0n && before.size <= BigInt(MAX_BYTES),
		"Invalid source size",
	);
	const canonical = await verify(file);
	assert.equal(
		canonical,
		realpathSync(file),
		"Source verifier returned another path",
	);
	const after = lstatSync(file, { bigint: true });
	// Publishing/removing a hard link changes nlink and ctime without changing bytes.
	for (const key of ["dev", "ino", "size", "mtimeNs"])
		assert.equal(after[key], before[key], "Source changed during verification");
	assert(
		after.isFile() && !after.isSymbolicLink(),
		"Cached media source must remain a regular file",
	);
	signal.throwIfAborted();
}

export async function prepareMediaSource(
	cache,
	{
		signal = new AbortController().signal,
		download = downloadArchive,
		extract = (archive, output, currentSignal) =>
			extractSource(archive, output, undefined, undefined, currentSignal),
		verify = verifySource,
	} = {},
) {
	const source = sourcePath(cache);
	cache = resolve(cache);
	signal.throwIfAborted();
	try {
		mkdirSync(cache, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const directory = cacheDirectory(cache);
	if (lstatSync(source, { throwIfNoEntry: false })) {
		await checkedSource(source, verify, signal);
		return { source, status: "hit" };
	}
	const stage = mkdtempSync(join(cache, ".partial-"));
	try {
		const archive = join(stage, "source.zip");
		const candidate = join(stage, "source.mp4");
		await download(archive, signal);
		signal.throwIfAborted();
		await extract(archive, candidate, signal);
		await checkedSource(candidate, verify, signal);
		const current = cacheDirectory(cache);
		assert(
			current.dev === directory.dev && current.ino === directory.ino,
			"Media source cache changed during preparation",
		);
		let status = "downloaded";
		try {
			// Atomic no-overwrite publication on the same filesystem.
			linkSync(candidate, source);
			unlinkSync(candidate);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			status = "winner";
		}
		await checkedSource(source, verify, signal);
		return { source, status };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export async function main(args = process.argv.slice(2), options = {}) {
	assert(
		args.length === 2 && args[0] === "--cache",
		"Usage: media-source.mjs --cache <absolute directory>",
	);
	const result = await prepareMediaSource(args[1], options);
	console.log(`Media source: ${result.status}; SHA-256 ${SOURCE_SHA}`);
	return result;
}
if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			controller.abort();
			process.exitCode = 1;
		});
	main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
		console.error("Verified media source preparation failed.");
		for (const line of failureLines(error)) console.error(line);
		process.exitCode = 1;
	});
}
