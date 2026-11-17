// Keep only the Dockerfile's pinned HDR native output, never an application
// image. A cache entry's own checksums detect damage, not a malicious writer;
// the workflows retain the same unprivileged branch scope as the SDR cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { childEnvironment, command } from "./media-smoke.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const HDR_CACHE_INPUTS = Object.freeze([
	"Dockerfile",
	".dockerignore",
	"docker/ffmpeg-hdr-wrap.patch",
	"docker/ffmpeg-hdr-colorimetry.patch",
	"docker/hdr-ffmpeg-patches.sha256",
	"docker/hdr-vmaf-models.sha256",
	"docker/hdr-build-proof.sh",
	"docker/hdr-build-proof.py",
	"scripts/native-hdr-tools.mjs",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = (path) => {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
};
const inside = (root, path) => {
	const child = relative(root, path);
	return (
		child === "" ||
		(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
	);
};

export function cacheKey(
	root = ROOT,
	platform = process.platform,
	arch = process.arch,
) {
	return digest(
		[
			"ffmpeg-hdr-v1",
			platform,
			arch,
			...HDR_CACHE_INPUTS.map(
				(file) => `${digest(readFileSync(join(root, file)))}  ${file}`,
			),
		].join("\n"),
	);
}

function checksums(text, comments = false) {
	assert(text.endsWith("\n"), "HDR checksum list is incomplete");
	const rows = text
		.trimEnd()
		.split("\n")
		.filter((line) => !(comments && line.startsWith("#")))
		.map((line) => {
			const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._/-]+)$/.exec(line);
			assert(
				match &&
					!match[2].startsWith("/") &&
					match[2]
						.split("/")
						.every((part) => part && part !== "." && part !== ".."),
				"Invalid HDR checksum entry",
			);
			return [match[2], match[1]];
		});
	assert.equal(
		new Set(rows.map(([name]) => name)).size,
		rows.length,
		"Duplicate HDR checksum entry",
	);
	return new Map(rows);
}

function pins(root) {
	const patches = checksums(
		readFileSync(join(root, "docker/hdr-ffmpeg-patches.sha256"), "utf8"),
		true,
	);
	assert.deepEqual([...patches.keys()].sort(), [
		"ffmpeg-hdr-colorimetry.patch",
		"ffmpeg-hdr-wrap.patch",
	]);
	for (const [name, expected] of patches)
		assert.equal(
			digest(readFileSync(join(root, "docker", name))),
			expected,
			"HDR patch checksum differs",
		);
	const models = checksums(
		readFileSync(join(root, "docker/hdr-vmaf-models.sha256"), "utf8"),
		true,
	);
	assert.deepEqual([...models.keys()].sort(), [
		"hdr_vmaf_v1.1.8_1d5h_2160.json",
		"hdr_vmaf_v1.1.8_3d0h_2160.json",
		"hdr_vmaf_v1.1.8_hfr_1d5h_2160.json",
		"hdr_vmaf_v1.1.8_hfr_3d0h_2160.json",
	]);
	return models;
}

function files(directory) {
	assert(
		lstatSync(directory).isDirectory() && realpathSync(directory) === directory,
		"HDR directory must be canonical",
	);
	const names = [];
	const visit = (parent, prefix) => {
		const children = readdirSync(parent).sort();
		assert(children.length > 0, "HDR output holds an empty directory");
		for (const child of children) {
			assert(
				/^[A-Za-z0-9._-]+$/.test(child) && child !== "." && child !== "..",
				"Unexpected HDR output name",
			);
			const name = prefix + child,
				path = join(parent, child),
				stat = lstatSync(path);
			if (stat.isDirectory()) visit(path, `${name}/`);
			else {
				assert(
					stat.isFile() && stat.nlink === 1,
					"HDR output must contain only regular, unlinked files",
				);
				if (name !== "SHA256SUMS") names.push(name);
			}
		}
	};
	visit(directory, "");
	return names.sort();
}

function verify(directory, root, manifest = true) {
	const names = files(directory);
	assert.deepEqual(
		readdirSync(directory).sort(),
		manifest
			? ["SHA256SUMS", "bin", "model", "share"]
			: ["bin", "model", "share"],
	);
	assert.deepEqual(readdirSync(join(directory, "bin")).sort(), [
		"ffmpeg-hdr",
		"ffprobe-hdr",
	]);
	assert.deepEqual(readdirSync(join(directory, "share")).sort(), [
		"hdr-build-proof",
		"licenses",
	]);
	const models = pins(root);
	assert.deepEqual(
		readdirSync(join(directory, "model")).sort(),
		[...models.keys(), "hdr-vmaf-models.sha256"].sort(),
	);
	assert.deepEqual(
		readFileSync(join(directory, "model/hdr-vmaf-models.sha256")),
		readFileSync(join(root, "docker/hdr-vmaf-models.sha256")),
		"HDR model manifest differs from current sources",
	);
	for (const [name, expected] of models)
		assert.equal(
			digest(readFileSync(join(directory, "model", name))),
			expected,
			"HDR model checksum differs",
		);
	for (const name of ["ffmpeg-hdr", "ffprobe-hdr"])
		assert(
			lstatSync(join(directory, "bin", name)).mode & 0o111,
			"HDR binary is not executable",
		);
	if (manifest) {
		const expected = checksums(
			readFileSync(join(directory, "SHA256SUMS"), "utf8"),
		);
		assert.deepEqual(
			[...expected.keys()],
			names,
			"HDR checksum census differs",
		);
		for (const [name, checksum] of expected)
			assert.equal(
				digest(readFileSync(join(directory, name))),
				checksum,
				"HDR cache checksum differs",
			);
	}
	return names;
}

function destination(path, root) {
	assert(
		typeof path === "string" &&
			isAbsolute(path) &&
			/^[A-Za-z0-9/._-]+$/.test(path),
		"HDR output path must be an absolute plain path",
	);
	assert(![".", ".."].includes(basename(path)), "Invalid HDR output path");
	const canonical = join(realpathSync(dirname(path)), basename(path));
	assert(
		!inside(realpathSync(root), canonical),
		"HDR output must be outside the checkout",
	);
	if (exists(canonical))
		assert(
			lstatSync(canonical).isDirectory() &&
				realpathSync(canonical) === canonical,
			"HDR output directory must not be a symlink",
		);
	return canonical;
}

function copyOutput(source, target) {
	assert.deepEqual(
		readdirSync(target),
		[],
		"HDR copy destination must be empty",
	);
	for (const name of readdirSync(source))
		cpSync(join(source, name), join(target, name), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
}

const BUILD_STAGES = new Set([
	"ffmpeg-toolchain",
	"ffmpeg-source",
	"ffmpeg-zlib",
	"ffmpeg-tls",
	"ffmpeg-text",
	"ffmpeg-codecs",
	"ffmpeg-vmaf",
	"ffmpeg-build",
	"ffmpeg-hdr-vmaf",
	"ffmpeg-hdr-build",
	"ffmpeg-hdr",
]);
export function buildTimingObserver(notify) {
	let pending = "";
	const stages = new Map();
	return (chunk) => {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop().slice(-1024);
		for (const line of lines) {
			const start = /^#([0-9]+) \[([a-z0-9-]+) ([0-9]+)\/[0-9]+\]/.exec(line);
			if (start && BUILD_STAGES.has(start[2]))
				stages.set(start[1], { name: start[2], step: start[3] });
			const done = /^#([0-9]+) DONE ([0-9]+(?:\.[0-9]+)?)s$/.exec(line);
			if (done && stages.has(done[1])) {
				const stage = stages.get(done[1]);
				stages.delete(done[1]);
				notify(
					`HDR build step: stage=${stage.name}; step=${stage.step}; elapsedMs=${Math.round(Number(done[2]) * 1000)}`,
				);
			}
		}
	};
}

export async function prepareHdr({
	root = ROOT,
	target,
	cache,
	platform = process.platform,
	arch = process.arch,
	env = process.env,
	signal,
	execute = command,
	notify = console.log,
} = {}) {
	const started = performance.now();
	assert.equal(platform, "linux", "The image HDR programs run on Linux only");
	target = destination(target, root);
	assert(!exists(target), "HDR target must be new");
	if (cache) {
		cache = destination(cache, root);
		assert(
			!inside(cache, target) && !inside(target, cache),
			"HDR target and cache must be separate",
		);
	}
	pins(root);
	const key = cacheKey(root, platform, arch),
		entry = cache && join(cache, key);
	const hit = entry && exists(entry);
	if (hit) verify(entry, root);
	assert(!signal?.aborted, "HDR preparation cancelled");
	const work = realpathSync(mkdtempSync(join(dirname(target), "bitovp-hdr-")));
	let partial;
	let created = false,
		completed = false;
	try {
		for (const name of ["tmp", "docker-config"])
			mkdirSync(join(work, name), { mode: 0o700 });
		writeFileSync(join(work, "docker-config/config.json"), "{}\n", {
			mode: 0o600,
		});
		const clean = childEnvironment(env, work);
		const run = (binary, args, options = {}) =>
			execute(binary, args, { cwd: root, env: clean, signal, ...options });
		mkdirSync(target, { mode: 0o700 });
		created = true;
		if (hit) copyOutput(entry, target);
		else {
			await run(
				"docker",
				[
					"--host",
					"unix:///var/run/docker.sock",
					"build",
					"--pull",
					"--progress=plain",
					"--file",
					join(root, "Dockerfile"),
					"--target",
					"ffmpeg-hdr",
					"--output",
					`type=local,dest=${target}`,
					root,
				],
				{
					// Same source-build budget as the existing smoke image builds.
					timeout: 1_800_000,
					capture: false,
					diagnostics: buildTimingObserver(notify),
				},
			);
			const names = verify(target, root, false);
			writeFileSync(
				join(target, "SHA256SUMS"),
				names
					.map(
						(name) => `${digest(readFileSync(join(target, name)))}  ${name}\n`,
					)
					.join(""),
				{ mode: 0o600, flag: "wx" },
			);
		}
		verify(target, root);
		const version = /^ARG FFMPEG_VER="([A-Za-z0-9.-]+)"$/m.exec(
			readFileSync(join(root, "Dockerfile"), "utf8"),
		)?.[1];
		assert(version, "Dockerfile must pin the FFmpeg version");
		for (const name of ["ffmpeg", "ffprobe"]) {
			const actual = await run(join(target, "bin", `${name}-hdr`), [
				"-hide_banner",
				"-version",
			]);
			assert(
				actual.startsWith(`${name} version ${version}-hdr1 `),
				"HDR binary version differs from current sources",
			);
		}
		const proofStarted = performance.now();
		// Seven cases have 120s each, HLG conversion has 30s; allow one 30s
		// startup margin. The current proof runs even when the cache is a hit.
		await run(
			"sh",
			[
				join(root, "docker/hdr-build-proof.sh"),
				join(target, "bin/ffmpeg-hdr"),
				join(target, "model"),
				join(work, "proof"),
			],
			{ timeout: 7 * 120_000 + 30_000 + 30_000 },
		);
		const proofMs = Math.round(performance.now() - proofStarted);
		assert(!signal?.aborted, "HDR preparation cancelled");
		verify(target, root);
		if (entry && !hit) {
			mkdirSync(cache, { recursive: true, mode: 0o700 });
			partial = mkdtempSync(join(cache, "partial-"));
			copyOutput(target, partial);
			verify(partial, root);
			try {
				renameSync(partial, entry);
				partial = undefined;
			} catch (error) {
				if (!exists(entry)) throw error;
				verify(entry, root);
			}
		}
		const result = {
			key,
			cache: hit ? "hit" : "miss",
			elapsedMs: Math.round(performance.now() - started),
			proofMs,
		};
		notify(
			`HDR native cache: status=${result.cache}; elapsedMs=${result.elapsedMs}; proofMs=${result.proofMs}`,
		);
		completed = true;
		return result;
	} finally {
		if (partial) rmSync(partial, { recursive: true });
		if (created && !completed) rmSync(target, { recursive: true });
		rmSync(work, { recursive: true });
	}
}

export function parseOptions(args) {
	const options = {};
	if (args[0] === "--cache") {
		assert(
			args.length === 3 && args[1] && !args[1].startsWith("-"),
			"usage: native-hdr-tools.mjs [--cache <directory>] <new directory>",
		);
		options.cache = args[1];
		args = args.slice(2);
	}
	assert(
		args.length === 1 && args[0] && !args[0].startsWith("-"),
		"usage: native-hdr-tools.mjs [--cache <directory>] <new directory>",
	);
	return { ...options, target: args[0] };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		await prepareHdr({
			...parseOptions(process.argv.slice(2)),
			signal: controller.signal,
		});
	} catch {
		console.error(
			"HDR native preparation failed; no private command output was published",
		);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}
