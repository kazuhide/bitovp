import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SOCKET = "unix:///var/run/docker.sock";
const LABEL = "io.bitovp.media-smoke";
const SOURCE_SHA =
	"f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508";
const SOURCE_URL =
	"https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip";
const MAX_BYTES = 90 * 1024 * 1024;
const resourceName = (id) => `bitovp-media-${id}`;
const inside = (parent, path) => {
	const child = relative(parent, path);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
};

export function childEnvironment(env, directory) {
	assert(
		!env.DOCKER_HOST || env.DOCKER_HOST === SOCKET,
		"Only the local Docker socket is supported",
	);
	assert(!env.DOCKER_CONTEXT, "Unset DOCKER_CONTEXT for media validation");
	const clean = {};
	for (const key of ["PATH", "LANG", "LC_ALL"])
		if (env[key]) clean[key] = env[key];
	return {
		...clean,
		DOCKER_CONFIG: join(directory, "docker-config"),
		TMPDIR: join(directory, "tmp"),
	};
}

export function dockerConfiguration(
	platform = process.platform,
	exists = existsSync,
) {
	const plugins = "/Applications/Docker.app/Contents/Resources/cli-plugins";
	// Keep registry credentials isolated while supporting Docker Desktop's plugins.
	return platform === "darwin" && exists(join(plugins, "docker-buildx"))
		? { cliPluginsExtraDirs: [plugins] }
		: {};
}

export async function command(binary, args, options = {}) {
	return new Promise((accept, reject) => {
		assert(!options.signal?.aborted, "Media validation was cancelled");
		const child = spawn(binary, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let bytes = 0;
		let stopped = false;
		let cancelled = false;
		let killTimer;
		const kill = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {
				child.kill(signal);
			}
		};
		const stop = () => {
			if (stopped) return;
			stopped = true;
			kill("SIGTERM");
			killTimer ??= setTimeout(() => kill("SIGKILL"), 5_000);
		};
		const timer = setTimeout(stop, options.timeout ?? 60_000);
		const abort = () => {
			cancelled = true;
			stop();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		for (const [stream, capture] of [
			[child.stdout, true],
			[child.stderr, false],
		])
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 32 * 1024 * 1024) stop();
				if (capture && options.capture !== false) {
					output += chunk.toString();
					if (output.length > 1024 * 1024) stop();
				}
			});
		const finish = (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			if (code === 0 && !stopped) accept(output.trim());
			else
				reject(
					new Error(
						cancelled
							? "Media validation command cancelled"
							: "Media validation command failed",
					),
				);
		};
		child.once("error", () => finish(-1));
		child.once("close", finish);
	});
}

export async function verifySource(path, maximum = MAX_BYTES) {
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical);
	assert(
		stat.isFile() && stat.size > 0 && stat.size <= maximum,
		"Invalid source size",
	);
	assert(!/[,\r\n]/.test(canonical), "Unsupported source path");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(canonical)) {
		bytes += chunk.length;
		assert(bytes <= maximum, "Invalid source size");
		hash.update(chunk);
	}
	assert.equal(hash.digest("hex"), SOURCE_SHA, "Source checksum mismatch");
	return canonical;
}

// Read one known member into a fixed output path; never extract archive paths.
const EXTRACT = `import os,pathlib,stat,sys,zipfile
archive,output=sys.argv[1:]
limit=90*1024*1024
with zipfile.ZipFile(archive) as z:
 infos=z.infolist()
 assert 0<len(infos)<=16
 names=[i.filename for i in infos]
 assert len(names)==len(set(names))
 assert sum(i.file_size for i in infos)<=limit
 for i in infos:
  p=pathlib.PurePosixPath(i.filename)
  assert not p.is_absolute() and '..' not in p.parts and '\\\\' not in i.filename and ':' not in i.filename
  assert not stat.S_ISLNK(i.external_attr>>16) and not i.flag_bits&1
  assert i.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)
 matches=[i for i in infos if i.filename=='BigBuckBunny_320x180.mp4']
 assert len(matches)==1 and 0<matches[0].file_size<=limit
 with z.open(matches[0]) as source,open(output,'xb') as target:
  total=0
  while chunk:=source.read(65536):
   total+=len(chunk)
   assert total<=limit
   target.write(chunk)
  assert total==matches[0].file_size
 os.chmod(output,0o644)
`;

export async function extractSource(
	archive,
	output,
	execute = command,
	env = process.env,
	signal,
) {
	await execute("python3", ["-I", "-c", EXTRACT, archive, output], {
		env: { PATH: env.PATH, LANG: "C.UTF-8" },
		timeout: 30_000,
		capture: false,
		signal,
	});
}

async function downloadSource(directory, signal) {
	const archive = join(directory, "source.zip");
	const response = await fetch(SOURCE_URL, {
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
	});
	assert(response.ok && response.body, "Official source download failed");
	assert(
		Number(response.headers.get("content-length") ?? 0) <= MAX_BYTES,
		"Official source archive is too large",
	);
	const file = await open(archive, "wx", 0o600);
	let bytes = 0;
	try {
		for await (const chunk of response.body) {
			bytes += chunk.length;
			assert(bytes <= MAX_BYTES, "Official source archive is too large");
			await file.write(chunk);
		}
	} finally {
		await file.close();
	}
	const source = join(directory, "source.mp4");
	await extractSource(archive, source, command, process.env, signal);
	return source;
}

export function containerArguments(state, source) {
	assert(/^[a-f0-9]{32}$/.test(state.id), "Invalid media fixture identity");
	assert(
		isAbsolute(source) && !/[,\r\n]/.test(source),
		"Unsupported source path",
	);
	const uid = process.getuid();
	const gid = process.getgid();
	return [
		"run",
		"--name",
		resourceName(state.id),
		"--label",
		`${LABEL}=${state.id}`,
		"--network",
		"none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--cpus=2",
		"--memory=1g",
		"--pids-limit=64",
		"--user",
		`${uid}:${gid}`,
		"--env",
		"TMPDIR=/work",
		"--tmpfs",
		`/work:rw,size=256m,uid=${uid},gid=${gid},mode=700`,
		"--mount",
		`type=bind,source=${source},target=/input/source.mp4,readonly`,
		"--entrypoint",
		"node",
		resourceName(state.id),
		"/app/apps/worker/node_modules/tsx/dist/cli.mjs",
		"/app/apps/worker/src/testing/media-smoke.ts",
	];
}

export function validateSummary(raw) {
	assert(
		typeof raw === "string" && raw.length <= 10_000,
		"Invalid media summary",
	);
	const summary = JSON.parse(raw);
	assert.deepEqual(
		Object.keys(summary).sort(),
		[
			"version",
			"videoFrames",
			"hlsSegments",
			"dashSegments",
			"decodedPresentations",
			"vmafFrames",
			"means",
		].sort(),
	);
	for (const [key, expected] of Object.entries({
		version: 1,
		videoFrames: 240,
		hlsSegments: 5,
		dashSegments: 5,
		decodedPresentations: 3,
		vmafFrames: 240,
	}))
		assert.equal(summary[key], expected, "Incomplete media validation");
	assert.deepEqual(Object.keys(summary.means).sort(), [
		"degraded",
		"encoded",
		"self",
	]);
	assert(
		Object.values(summary.means).every(
			(value) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= 0 &&
				value <= 100,
		),
	);
	return summary;
}

async function docker(args, env, execute = command, options = {}) {
	return execute("docker", ["--host", SOCKET, ...args], { env, ...options });
}

export async function cleanupFixture(
	state,
	execute = command,
	env = process.env,
) {
	assert(/^[a-f0-9]{32}$/.test(state.id), "Invalid media fixture identity");
	assert(
		typeof state.containerRequested === "boolean" &&
			typeof state.imageRequested === "boolean",
		"Invalid media fixture state",
	);
	const clean = childEnvironment(env, state.directory);
	for (const [requested, kind] of [
		[state.containerRequested, "container"],
		[state.imageRequested, "image"],
	]) {
		if (!requested) continue;
		const absent = async () => {
			const filter =
				kind === "container"
					? `name=^/${resourceName(state.id)}$`
					: `reference=${resourceName(state.id)}`;
			const args =
				kind === "container" ? ["container", "ls", "--all"] : ["image", "ls"];
			return (
				(await docker(
					[...args, "--filter", filter, "--format", "{{.ID}}"],
					clean,
					execute,
				)) === ""
			);
		};
		let labels;
		try {
			labels = JSON.parse(
				await docker(
					[
						kind,
						"inspect",
						"--format",
						"{{json .Config.Labels}}",
						resourceName(state.id),
					],
					clean,
					execute,
				),
			);
		} catch {
			assert(await absent(), "Unable to establish media fixture ownership");
			continue;
		}
		assert.equal(
			labels?.[LABEL],
			state.id,
			"Media fixture ownership label does not match",
		);
		await docker(
			kind === "container"
				? ["container", "rm", "--force", "--volumes", resourceName(state.id)]
				: ["image", "rm", resourceName(state.id)],
			clean,
			execute,
		);
		assert(await absent(), "Owned media fixture cleanup did not complete");
	}
	if (existsSync(state.directory)) {
		assert(
			basename(state.directory).startsWith("bitovp-media-") &&
				!inside(realpathSync(ROOT), state.directory),
			"Invalid media fixture directory",
		);
		const stat = lstatSync(state.directory);
		assert(
			stat.isDirectory() &&
				stat.uid === process.getuid() &&
				realpathSync(state.directory) === resolve(state.directory) &&
				!(stat.mode & 0o077),
			"Invalid media fixture directory ownership",
		);
		assert(
			lstatSync(join(state.directory, ".owner")).isFile(),
			"Media ownership marker must be a regular file",
		);
		assert.equal(
			readFileSync(join(state.directory, ".owner"), "utf8"),
			state.id,
			"Media directory ownership does not match",
		);
		rmSync(state.directory, { recursive: true });
	}
}

export async function runFixture(
	{
		source,
		statePath,
		signal = new AbortController().signal,
		env = process.env,
		notify = console.log,
	} = {},
	execute = command,
) {
	childEnvironment(env, "/tmp");
	if (statePath)
		assert(
			isAbsolute(statePath) &&
				!inside(ROOT, statePath) &&
				!existsSync(statePath),
			"State file must be new and outside the checkout",
		);
	const directory = realpathSync(
		mkdtempSync(join(realpathSync("/tmp"), "bitovp-media-")),
	);
	const state = {
		id: randomBytes(16).toString("hex"),
		directory,
		imageRequested: false,
		containerRequested: false,
	};
	const stateFile = statePath ?? join(directory, "state.json");
	writeFileSync(join(directory, ".owner"), state.id, {
		mode: 0o600,
		flag: "wx",
	});
	for (const path of ["tmp", "docker-config"])
		mkdirSync(join(directory, path), { mode: 0o700 });
	const clean = childEnvironment(env, directory);
	const save = () =>
		writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
	let saved = false;
	try {
		writeFileSync(stateFile, JSON.stringify(state), {
			mode: 0o600,
			flag: "wx",
		});
		saved = true;
		writeFileSync(
			join(directory, "docker-config", "config.json"),
			JSON.stringify(dockerConfiguration()),
			{ mode: 0o600, flag: "wx" },
		);
		notify("Media check: verifying the official source");
		const asset = await verifySource(
			source ?? (await downloadSource(directory, signal)),
		);
		assert(!signal.aborted, "Media check cancelled");
		state.imageRequested = true;
		save();
		notify("Media check: building the worker image");
		await docker(
			[
				"build",
				"--pull",
				"--label",
				`${LABEL}=${state.id}`,
				"--tag",
				resourceName(state.id),
				"--file",
				"Dockerfile",
				".",
			],
			clean,
			execute,
			{ cwd: ROOT, timeout: 900_000, capture: false, signal },
		);
		assert(!signal.aborted, "Media check cancelled");
		const imageId = await docker(
			["image", "inspect", "--format", "{{.Id}}", resourceName(state.id)],
			clean,
			execute,
			{ signal },
		);
		assert(
			/^sha256:[a-f0-9]{64}$/.test(imageId),
			"Invalid worker image identity",
		);
		notify(`Worker image built: ${imageId}`);
		state.containerRequested = true;
		save();
		notify("Media check: encoding, packaging, decoding and scoring offline");
		const summary = validateSummary(
			await docker(containerArguments(state, asset), clean, execute, {
				timeout: 180_000,
				signal,
			}),
		);
		assert(!signal.aborted, "Media check cancelled");
		await verifySource(asset);
		notify(
			`Media passed: ${summary.videoFrames} video frames; HLS/DASH each ${summary.hlsSegments} x 48 frames; ${summary.decodedPresentations} complete audio/video decodes; ${summary.vmafFrames} VMAF frames per comparison`,
		);
		notify(
			`VMAF means: self=${summary.means.self.toFixed(3)}, encoded=${summary.means.encoded.toFixed(3)}, degraded=${summary.means.degraded.toFixed(3)}`,
		);
	} finally {
		await cleanupFixture(state, execute, env);
		if (saved) rmSync(stateFile, { force: true });
		notify("Media fixture: owned image, container and scratch files removed");
	}
}

async function main(signal) {
	const args = process.argv.slice(2);
	const cleanup = args[0] === "--cleanup";
	if (cleanup) args.shift();
	const options = {};
	for (let index = 0; index < args.length; index += 2) {
		assert(
			["--source", "--state-file"].includes(args[index]) &&
				args[index + 1] &&
				!options[args[index]],
			"Unknown or duplicate media option",
		);
		options[args[index]] = args[index + 1];
	}
	if (cleanup) {
		const path = options["--state-file"];
		assert(
			path && !options["--source"] && isAbsolute(path) && !inside(ROOT, path),
			"Cleanup requires an external state file",
		);
		if (!existsSync(path)) return;
		const stat = lstatSync(path);
		assert(stat.isFile() && !(stat.mode & 0o077), "State file must be private");
		await cleanupFixture(JSON.parse(readFileSync(path, "utf8")));
		rmSync(path);
	} else
		await runFixture({
			source: options["--source"],
			statePath: options["--state-file"],
			signal,
		});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			// Cleanup commands retain their own timeouts and do not use this signal.
			controller.abort();
			process.exitCode = 1;
		});
	main(controller.signal).catch(() => {
		console.error(
			"Offline media validation failed; source, media checks or owned cleanup did not complete.",
		);
		process.exitCode = 1;
	});
}
