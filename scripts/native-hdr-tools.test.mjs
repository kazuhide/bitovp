import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { command } from "./media-smoke.mjs";
import {
	buildTimingObserver,
	cacheKey,
	HDR_CACHE_INPUTS,
	parseOptions,
	prepareHdr,
} from "./native-hdr-tools.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const models = [
	"hdr_vmaf_v1.1.8_3d0h_2160.json",
	"hdr_vmaf_v1.1.8_1d5h_2160.json",
	"hdr_vmaf_v1.1.8_hfr_3d0h_2160.json",
	"hdr_vmaf_v1.1.8_hfr_1d5h_2160.json",
].sort();
const version = "n8.1.3-34-ga35157abb9-hdr1";

function fixture() {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "hdr-cache-test-")),
	);
	const root = join(directory, "source");
	mkdirSync(root);
	for (const file of HDR_CACHE_INPUTS) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), `${file}\n`);
	}
	writeFileSync(
		join(root, "Dockerfile"),
		'ARG FFMPEG_VER="n8.1.3-34-ga35157abb9"\n',
	);
	writeFileSync(
		join(root, "docker/hdr-vmaf-models.sha256"),
		models.map((name) => `${hash(name)}  ${name}\n`).join(""),
	);
	writeFileSync(
		join(root, "docker/hdr-ffmpeg-patches.sha256"),
		["ffmpeg-hdr-wrap.patch", "ffmpeg-hdr-colorimetry.patch"]
			.map(
				(name) =>
					`${hash(readFileSync(join(root, "docker", name)))}  ${name}\n`,
			)
			.join(""),
	);
	const calls = [];
	const notes = [];
	const cache = join(directory, "cache");
	const makeBuild = (target) => {
		for (const name of [
			"bin",
			"model",
			"share/licenses/ffmpeg",
			"share/hdr-build-proof",
		])
			mkdirSync(join(target, name), { recursive: true });
		for (const binary of ["ffmpeg-hdr", "ffprobe-hdr"])
			writeFileSync(join(target, "bin", binary), `fake-${binary}`, {
				mode: 0o755,
			});
		for (const name of models) writeFileSync(join(target, "model", name), name);
		cpSync(
			join(root, "docker/hdr-vmaf-models.sha256"),
			join(target, "model/hdr-vmaf-models.sha256"),
		);
		writeFileSync(join(target, "share/licenses/ffmpeg/LICENSE"), "license");
		writeFileSync(
			join(target, "share/hdr-build-proof/receipt.json"),
			"old-build-receipt",
		);
	};
	const execute = async (binary, args, options) => {
		calls.push({ binary, args, options });
		assert(!Object.hasOwn(options.env, "PRIVATE_SENTINEL"));
		if (binary === "docker") {
			assert.deepEqual(args.slice(0, 5), [
				"--host",
				"unix:///var/run/docker.sock",
				"build",
				"--pull",
				"--progress=plain",
			]);
			assert.equal(args[args.indexOf("--target") + 1], "ffmpeg-hdr");
			makeBuild(
				args[args.indexOf("--output") + 1].replace("type=local,dest=", ""),
			);
			return "";
		}
		if (binary === "sh") {
			assert.equal(args[0], join(root, "docker/hdr-build-proof.sh"));
			assert(
				!existsSync(args[3]),
				"fresh proof cannot reuse an earlier receipt directory",
			);
			mkdirSync(args[3]);
			writeFileSync(join(args[3], "receipt.json"), "fresh-proof");
			return "";
		}
		return `${binary.endsWith("ffprobe-hdr") ? "ffprobe" : "ffmpeg"} version ${version} Copyright`;
	};
	const run = (name, extra = {}) =>
		prepareHdr({
			root,
			cache,
			target: join(directory, name),
			platform: "linux",
			arch: "x64",
			env: { PATH: process.env.PATH, PRIVATE_SENTINEL: "must-not-escape" },
			execute,
			notify: (line) => notes.push(line),
			...extra,
		});
	return {
		directory,
		root,
		cache,
		calls,
		notes,
		run,
		execute,
		makeBuild,
		dispose: () => rmSync(directory, { recursive: true, force: true }),
	};
}

test("HDR source builds branch before SDR configuration or compilation", () => {
	const file = readFileSync(join(ROOT, "Dockerfile"), "utf8");
	assert.match(
		file,
		/FROM ffmpeg-source AS ffmpeg-build\nCOPY --from=ffmpeg-vmaf/,
	);
	assert.match(file, /FROM ffmpeg-source AS ffmpeg-hdr-build/);
	const source = file.slice(
		file.indexOf("FROM ffmpeg-toolchain AS ffmpeg-source"),
		file.indexOf("FROM ffmpeg-source AS ffmpeg-build"),
	);
	assert(!source.includes("COPY --from=ffmpeg-vmaf"));
	assert(!source.includes("./configure --prefix=/opt/ffmpeg"));
	assert(!source.includes("make install"));
	assert(!file.includes("make distclean"));
});

test("the current checked-in HDR patch and model manifests are accepted before build", async () => {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "hdr-current-pins-")),
	);
	let called = false;
	try {
		await assert.rejects(
			prepareHdr({
				target: join(directory, "output"),
				platform: "linux",
				execute: async () => {
					called = true;
					throw new Error("build boundary");
				},
				notify: () => {},
			}),
			/build boundary/,
		);
		assert(called);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("cold HDR cache seeds only proven outputs; every hit reruns the current proof", async () => {
	const f = fixture();
	try {
		const cold = await f.run("cold");
		const warm = await f.run("warm");
		assert.equal(cold.cache, "miss");
		assert.equal(warm.cache, "hit");
		assert.equal(warm.key, cold.key);
		assert.equal(f.calls.filter((call) => call.binary === "docker").length, 1);
		assert.equal(f.calls.filter((call) => call.binary === "sh").length, 2);
		assert.deepEqual(
			readFileSync(join(f.directory, "cold/SHA256SUMS")),
			readFileSync(join(f.directory, "warm/SHA256SUMS")),
		);
		assert.deepEqual(readdirSync(f.cache), [cold.key]);
		assert(f.notes.some((line) => /HDR native cache: status=hit/.test(line)));
	} finally {
		f.dispose();
	}
});

test("every native input and the host architecture changes the exact cache key", () => {
	const f = fixture();
	try {
		const before = cacheKey(f.root, "linux", "x64");
		for (const file of HDR_CACHE_INPUTS) {
			const path = join(f.root, file),
				bytes = readFileSync(path);
			writeFileSync(path, Buffer.concat([bytes, Buffer.from("changed")]));
			assert.notEqual(cacheKey(f.root, "linux", "x64"), before, file);
			writeFileSync(path, bytes);
		}
		assert.notEqual(cacheKey(f.root, "linux", "arm64"), before);
		assert.notEqual(cacheKey(f.root, "darwin", "x64"), before);
	} finally {
		f.dispose();
	}
});

for (const variant of [
	"binary",
	"extra",
	"missing",
	"symlink",
	"manifest",
	"model",
	"model-manifest",
	"executable",
	"empty-directory",
	"hardlink",
	"special-file",
	"missing-checksums",
	"duplicate-checksums",
]) {
	test(`damaged HDR cache ${variant} fails without rebuilding or running proof`, async () => {
		const f = fixture();
		try {
			const seeded = await f.run("cold");
			const entry = join(f.cache, seeded.key);
			if (variant === "binary")
				writeFileSync(join(entry, "bin/ffmpeg-hdr"), "bad");
			if (variant === "extra") writeFileSync(join(entry, "unexpected"), "bad");
			if (variant === "missing") rmSync(join(entry, "bin/ffprobe-hdr"));
			if (variant === "symlink") {
				rmSync(join(entry, "bin/ffmpeg-hdr"));
				symlinkSync(
					join(f.directory, "cold/bin/ffmpeg-hdr"),
					join(entry, "bin/ffmpeg-hdr"),
				);
			}
			if (variant === "manifest")
				writeFileSync(
					join(entry, "SHA256SUMS"),
					`${hash("x")}  ../../outside\n`,
				);
			if (variant === "model")
				writeFileSync(join(entry, "model", models[0]), "bad");
			if (variant === "model-manifest")
				writeFileSync(join(entry, "model/hdr-vmaf-models.sha256"), "bad");
			if (variant === "executable")
				chmodSync(join(entry, "bin/ffmpeg-hdr"), 0o644);
			if (variant === "empty-directory") mkdirSync(join(entry, "share/empty"));
			if (variant === "hardlink") {
				rmSync(join(entry, "bin/ffmpeg-hdr"));
				linkSync(
					join(f.directory, "cold/bin/ffmpeg-hdr"),
					join(entry, "bin/ffmpeg-hdr"),
				);
			}
			if (variant === "special-file") {
				const result = spawnSync("mkfifo", [join(entry, "share/fifo")]);
				assert.equal(result.status, 0);
			}
			if (variant === "missing-checksums") rmSync(join(entry, "SHA256SUMS"));
			if (variant === "duplicate-checksums") {
				const list = readFileSync(join(entry, "SHA256SUMS"), "utf8");
				writeFileSync(
					join(entry, "SHA256SUMS"),
					`${list}${list.split("\n")[0]}\n`,
				);
			}
			const count = f.calls.length;
			await assert.rejects(f.run("bad"));
			assert.equal(f.calls.length, count);
			assert(!existsSync(join(f.directory, "bad")));
			assert.deepEqual(readdirSync(f.cache), [seeded.key]);
		} finally {
			f.dispose();
		}
	});
}

test("proof failure on a cache hit cannot accept an old receipt", async () => {
	const f = fixture();
	try {
		const seed = await f.run("cold");
		await assert.rejects(
			f.run("bad", {
				execute: (binary, args, options) =>
					binary === "sh"
						? Promise.reject(new Error("proof failed"))
						: f.execute(binary, args, options),
			}),
		);
		assert(!existsSync(join(f.directory, "bad")));
		assert.deepEqual(readdirSync(f.cache), [seed.key]);
	} finally {
		f.dispose();
	}
});

test("an input change causes a new build; abandoned partial entries are never reused or removed", async () => {
	const f = fixture();
	try {
		const old = await f.run("old");
		const abandoned = join(f.cache, "partial-abandoned");
		mkdirSync(abandoned);
		writeFileSync(join(abandoned, "foreign"), "preserve");
		writeFileSync(
			join(f.root, "docker/hdr-build-proof.py"),
			"current-proof-v2",
		);
		const fresh = await f.run("new");
		assert.notEqual(old.key, fresh.key);
		assert.equal(fresh.cache, "miss");
		assert.equal(f.calls.filter((call) => call.binary === "docker").length, 2);
		assert.equal(readFileSync(join(abandoned, "foreign"), "utf8"), "preserve");
		assert.deepEqual(
			readdirSync(f.cache).sort(),
			[old.key, fresh.key, "partial-abandoned"].sort(),
		);
	} finally {
		f.dispose();
	}
});

test("wrong binary version and source patch mismatch fail before the fresh proof", async () => {
	for (const variant of ["version", "patch"]) {
		const f = fixture();
		try {
			if (variant === "patch")
				writeFileSync(
					join(f.root, "docker/ffmpeg-hdr-wrap.patch"),
					"unverified-patch",
				);
			await assert.rejects(
				f.run("bad", {
					execute: (binary, args, options) =>
						binary.endsWith("ffmpeg-hdr")
							? Promise.resolve("ffmpeg version old Copyright")
							: f.execute(binary, args, options),
				}),
			);
			assert.equal(f.calls.filter((call) => call.binary === "sh").length, 0);
			assert(!existsSync(join(f.directory, "bad")));
			assert(!existsSync(f.cache));
		} finally {
			f.dispose();
		}
	}
});

test("build and fresh-proof failures never publish a partial cache entry", async () => {
	for (const failed of ["docker", "sh"]) {
		const f = fixture();
		try {
			await assert.rejects(
				f.run("failed", {
					execute: (binary, args, options) =>
						binary === failed
							? Promise.reject(new Error("failed"))
							: f.execute(binary, args, options),
				}),
			);
			assert(!existsSync(join(f.directory, "failed")));
			assert(!existsSync(f.cache) || readdirSync(f.cache).length === 0);
		} finally {
			f.dispose();
		}
	}
});

test("concurrent seeds publish one whole entry and remove only their own partial directories", async () => {
	const f = fixture();
	try {
		const values = await Promise.all([f.run("one"), f.run("two")]);
		assert.deepEqual(readdirSync(f.cache), [values[0].key]);
		assert.equal(values[0].key, values[1].key);
		await f.run("three");
	} finally {
		f.dispose();
	}
});

test("abort terminates the real build subprocess and leaves no target or cache entry", async () => {
	const f = fixture();
	const controller = new AbortController();
	const ready = join(f.directory, "ready");
	try {
		const pending = f.run("aborted", {
			signal: controller.signal,
			execute: (binary, args, options) =>
				binary === "docker"
					? command(
							process.execPath,
							[
								"-e",
								`process.on("SIGTERM",()=>process.exit(0));require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000)`,
							],
							options,
						)
					: f.execute(binary, args, options),
		});
		while (!existsSync(ready))
			await new Promise((accept) => setTimeout(accept, 10));
		controller.abort();
		await assert.rejects(pending);
		assert(!existsSync(join(f.directory, "aborted")));
		assert(!existsSync(f.cache) || readdirSync(f.cache).length === 0);
		assert(existsSync(ready));
	} finally {
		controller.abort();
		f.dispose();
	}
});

test("unsafe CLI arguments and destinations are refused before a build", async () => {
	for (const args of [
		[],
		["--unknown", "private"],
		["--cache"],
		["--cache", "a", "--cache", "b", "out"],
		["out", "extra"],
	])
		assert.throws(() => parseOptions(args));
	assert.deepEqual(parseOptions(["--cache", "/tmp/cache", "/tmp/out"]), {
		cache: "/tmp/cache",
		target: "/tmp/out",
	});
	const f = fixture();
	try {
		for (const target of [
			"relative",
			f.root,
			join(f.root, "output"),
			join(f.cache, "nested"),
		])
			await assert.rejects(f.run("unused", { target }));
		assert.equal(f.calls.length, 0);
	} finally {
		f.dispose();
	}
});

test("BuildKit timing receipts discard all arbitrary log text", () => {
	const rows = [];
	const observe = buildTimingObserver((line) => rows.push(line));
	observe("#4 [ffmpeg-source 2/8] RUN PRIVATE_SENTINEL\n#4 DONE 1.");
	observe("25s\n#5 [SECRET_STAGE 1/2] private\n#5 DONE 9.0s\n#6 DONE 8.0s\n");
	assert.deepEqual(rows, [
		"HDR build step: stage=ffmpeg-source; step=2; elapsedMs=1250",
	]);
	assert(!rows.join("\n").includes("PRIVATE"));
});
