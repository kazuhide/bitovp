import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { MAX_BYTES, SOURCE_SHA } from "./media-smoke.mjs";
import { prepareMediaSource, sourcePath } from "./media-source.mjs";

const fixture = Buffer.from("small fake media input for cache tests");
const fixtureHash = createHash("sha256").update(fixture).digest("hex");
const script = resolve(import.meta.dirname, "media-source.mjs");
function temporary(t) {
	const parent = mkdtempSync(join(tmpdir(), "bitovp-media-source-test-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	return parent;
}
function cacheIn(t) {
	const cache = join(temporary(t), "cache");
	mkdirSync(cache);
	return cache;
}
async function verify(file) {
	assert.equal(
		createHash("sha256").update(readFileSync(file)).digest("hex"),
		fixtureHash,
		"fixture checksum mismatch",
	);
	return realpathSync(file);
}
function fakeMiss(options = {}) {
	return {
		download: async (archive) => {
			writeFileSync(archive, "fake archive", { flag: "wx" });
		},
		extract: async (_archive, output) => {
			writeFileSync(output, fixture, { flag: "wx" });
		},
		verify,
		...options,
	};
}
const neverDownload = async () => {
	throw new Error("unexpected network");
};

test("a verified cache hit performs no download or extraction", async (t) => {
	const cache = cacheIn(t);
	writeFileSync(sourcePath(cache), fixture);
	const result = await prepareMediaSource(cache, {
		download: neverDownload,
		extract: neverDownload,
		verify,
	});
	assert.deepEqual(result, { source: sourcePath(cache), status: "hit" });
	assert.equal(lstatSync(result.source).nlink, 1);
	assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
});

test("corrupt, empty, oversized, directory and symbolic-link entries fail without replacing them", async (t) => {
	for (const kind of [
		"corrupt",
		"empty",
		"oversized",
		"directory",
		"symlink",
	]) {
		const cache = cacheIn(t);
		const output = sourcePath(cache);
		if (kind === "directory") mkdirSync(output);
		else if (kind === "symlink") {
			const target = join(dirname(cache), "original");
			writeFileSync(target, fixture);
			symlinkSync(target, output);
		} else {
			writeFileSync(output, kind === "empty" ? "" : "partial");
			if (kind === "oversized") truncateSync(output, MAX_BYTES + 1);
		}
		const before = lstatSync(output);
		await assert.rejects(
			prepareMediaSource(cache, {
				download: neverDownload,
				extract: neverDownload,
				verify,
			}),
		);
		assert.equal(lstatSync(output).ino, before.ino);
		assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
	}
});

test("cache directory links and relative paths are rejected before any acquisition", async (t) => {
	const parent = temporary(t);
	const target = join(parent, "target");
	mkdirSync(target);
	const linked = join(parent, "linked");
	symlinkSync(target, linked);
	await assert.rejects(
		prepareMediaSource(linked, fakeMiss()),
		/regular directory/,
	);
	await assert.rejects(prepareMediaSource("relative", fakeMiss()), /absolute/);
	assert.deepEqual(readdirSync(target), []);
});

test("a miss verifies private input before atomic publication and removes its staging link", async (t) => {
	const cache = cacheIn(t);
	const output = sourcePath(cache);
	const seen = [];
	const result = await prepareMediaSource(
		cache,
		fakeMiss({
			download: async (archive) => {
				assert.equal(lstatSync(dirname(archive)).mode & 0o777, 0o700);
				seen.push("download");
				writeFileSync(archive, "fake archive", { flag: "wx" });
			},
			extract: async (archive, file) => {
				assert.equal(readFileSync(archive, "utf8"), "fake archive");
				seen.push("extract");
				writeFileSync(file, fixture, { flag: "wx" });
			},
			verify: async (file) => {
				if (file !== output) assert.equal(existsSync(output), false);
				else assert.equal(lstatSync(output).nlink, 1);
				seen.push(file === output ? "verify-published" : "verify-private");
				return verify(file);
			},
		}),
	);
	assert.deepEqual(seen, [
		"download",
		"extract",
		"verify-private",
		"verify-published",
	]);
	assert.deepEqual(result, { source: output, status: "downloaded" });
	assert.deepEqual(readFileSync(output), fixture);
	assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
	assert.equal(lstatSync(output).nlink, 1);
});

test("download, extraction, digest and cancellation failures clean only owned partials", async (t) => {
	for (const kind of ["download", "extract", "digest", "abort"]) {
		const cache = cacheIn(t);
		const untouched = join(cache, ".partial-other-job");
		mkdirSync(untouched);
		writeFileSync(join(untouched, "keep"), "other job");
		const controller = new AbortController();
		const options = fakeMiss({ signal: controller.signal });
		if (kind === "download" || kind === "abort")
			options.download = async (archive) => {
				writeFileSync(archive, "partial archive");
				if (kind === "abort") controller.abort();
				else throw new Error("HTTP 403 fixture");
			};
		if (kind === "extract")
			options.extract = async (_archive, output) => {
				writeFileSync(output, "partial extraction");
				throw new Error("extraction fixture");
			};
		if (kind === "digest")
			options.extract = async (_archive, output) => {
				writeFileSync(output, "wrong media");
			};
		await assert.rejects(prepareMediaSource(cache, options));
		assert.deepEqual(readdirSync(cache), [".partial-other-job"]);
		assert.equal(readFileSync(join(untouched, "keep"), "utf8"), "other job");
	}
});

test("source replacement during verification is rejected", async (t) => {
	const cache = cacheIn(t);
	const output = sourcePath(cache);
	writeFileSync(output, fixture);
	await assert.rejects(
		prepareMediaSource(cache, {
			download: neverDownload,
			verify: async (file) => {
				const checked = await verify(file);
				renameSync(file, `${file}.original`);
				writeFileSync(file, fixture);
				return checked;
			},
		}),
		/changed during verification/,
	);
});

test("a concurrent publisher changing only hard-link metadata does not invalidate verified bytes", async (t) => {
	const cache = cacheIn(t);
	const output = sourcePath(cache);
	writeFileSync(output, fixture);
	const result = await prepareMediaSource(cache, {
		download: neverDownload,
		verify: async (file) => {
			const checked = await verify(file);
			const otherLink = join(cache, "private-publisher-link");
			linkSync(file, otherLink);
			unlinkSync(otherLink);
			return checked;
		},
	});
	assert.equal(result.status, "hit");
	assert.equal(lstatSync(output).nlink, 1);
	assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
});

test("concurrent publishers verify the winner and leave one complete unlinked cache file", async (t) => {
	const cache = cacheIn(t);
	let arrivals = 0;
	let release;
	const ready = new Promise((accept) => {
		release = accept;
	});
	const options = fakeMiss({
		download: async (archive) => {
			writeFileSync(archive, "fake archive", { flag: "wx" });
			arrivals += 1;
			if (arrivals === 2) release();
			await ready;
		},
	});
	const results = await Promise.all([
		prepareMediaSource(cache, options),
		prepareMediaSource(cache, options),
	]);
	assert.deepEqual(results.map((result) => result.status).sort(), [
		"downloaded",
		"winner",
	]);
	assert(results.every((result) => result.source === sourcePath(cache)));
	assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
	assert.equal(lstatSync(sourcePath(cache)).nlink, 1);
	await verify(sourcePath(cache));
});

test("a corrupt concurrent winner fails and is never silently replaced", async (t) => {
	const cache = cacheIn(t);
	const output = sourcePath(cache);
	await assert.rejects(
		prepareMediaSource(
			cache,
			fakeMiss({
				extract: async (_archive, file) => {
					writeFileSync(file, fixture);
					writeFileSync(output, "corrupt winner", { flag: "wx" });
				},
			}),
		),
		/checksum/,
	);
	assert.equal(readFileSync(output, "utf8"), "corrupt winner");
	assert.deepEqual(readdirSync(cache), [`${SOURCE_SHA}.mp4`]);
});

test("the actual CLI keeps the production digest pinned and never downloads over corruption", (t) => {
	const cache = cacheIn(t);
	writeFileSync(sourcePath(cache), fixture);
	const preload = join(dirname(cache), "no-network.mjs");
	writeFileSync(
		preload,
		'globalThis.fetch = async () => { throw new Error("unexpected-network-marker"); };',
	);
	const result = spawnSync(
		process.execPath,
		["--import", preload, script, "--cache", cache],
		{ encoding: "utf8", timeout: 10000 },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Source checksum mismatch/);
	assert.doesNotMatch(result.stderr, /unexpected-network-marker/);
	assert.deepEqual(readFileSync(sourcePath(cache)), fixture);
});

test("the actual CLI uses only the official origin once and cleans a failed miss", (t) => {
	const cache = cacheIn(t);
	const requests = join(dirname(cache), "requests.jsonl");
	const preload = join(dirname(cache), "fake-origin.mjs");
	writeFileSync(
		preload,
		`import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
 appendFileSync(${JSON.stringify(requests)}, JSON.stringify({url,redirect:options.redirect})+"\\n");
 return {ok:false,status:403};
};`,
	);
	const result = spawnSync(
		process.execPath,
		["--import", preload, script, "--cache", cache],
		{ encoding: "utf8", timeout: 10000 },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Official source download failed: HTTP 403/);
	assert.deepEqual(
		readFileSync(requests, "utf8").trim().split("\n").map(JSON.parse),
		[
			{
				url: "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip",
				redirect: "error",
			},
		],
	);
	assert.deepEqual(readdirSync(cache), []);
});

test("the actual CLI requires its exact cache option and an absolute path", (t) => {
	const cache = join(temporary(t), "unused");
	for (const args of [
		[],
		["--cache"],
		["--source", cache],
		["--cache", "relative"],
		["--cache", cache, "extra"],
	]) {
		const result = spawnSync(process.execPath, [script, ...args], {
			encoding: "utf8",
			timeout: 10000,
		});
		assert.equal(result.status, 1);
	}
	assert.equal(existsSync(cache), false);
});
