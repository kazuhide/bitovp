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
import { StringDecoder } from "node:string_decoder";
import {
	asFailure,
	atStep,
	failureLines,
	GateFailure,
	inStep,
	isEntryPoint,
	outputTail,
	withLaterFailure,
} from "./gate-report.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SOCKET = "unix:///var/run/docker.sock";
const LABEL = "io.bitovp.media-smoke";
const SOURCE_SHA =
	"f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508";
const SOURCE_URL =
	"https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip";
const MAX_BYTES = 90 * 1024 * 1024;
// Required tests per fixture, subtests included, in execution order. A fixture
// that is missing, repeated, skipped in part or short of its count fails the
// media check; a deliberate change to a fixture's tests updates its count here.
export const FIXTURES = Object.freeze({
	"src/library-editing/hls-preparation.media.ts": 3,
	"src/library-editing/normalization.media.ts": 8,
	"src/library-editing/normalization-untagged-color.media.ts": 1,
	"src/library-editing/render.media.ts": 5,
	"src/library-editing/render-movie-clock.media.ts": 17,
	"src/vmaf/reference-preparation.media.ts": 2,
});
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
		const diagnostics = outputTail();
		const decoder = new StringDecoder("utf8");
		let bytes = 0;
		let stopped = "";
		let cancelled = false;
		let killTimer;
		const kill = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {
				child.kill(signal);
			}
		};
		const stop = (reason) => {
			if (stopped) return;
			stopped = reason;
			kill("SIGTERM");
			killTimer ??= setTimeout(() => kill("SIGKILL"), 5_000);
		};
		const limit = options.timeout ?? 60_000;
		const timer = setTimeout(
			() => stop(`was stopped at its ${limit / 1000} second limit`),
			limit,
		);
		const abort = () => {
			cancelled = true;
			stop("was cancelled");
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		for (const [stream, capture] of [
			[child.stdout, true],
			[child.stderr, false],
		])
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 32 * 1024 * 1024) stop("exceeded its output limit");
				if (capture && options.capture !== false) {
					output += chunk.toString();
					if (output.length > 1024 * 1024) stop("exceeded its result limit");
				}
				if (!capture) {
					const text = decoder.write(chunk);
					options.diagnostics?.(text);
					diagnostics.add(text);
				}
			});
		const finish = (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			if (code === 0 && !stopped) accept(output.trim());
			// The message stays fixed. The end of the child's diagnostics travels
			// beside it and is printed only by the final failure report.
			else
				reject(
					new GateFailure(
						cancelled
							? "Media validation command cancelled"
							: "Media validation command failed",
						{
							details: stopped && !cancelled ? [`The command ${stopped}`] : [],
							diagnostics: diagnostics.text(),
						},
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

/** Fetches the official archive; `request` is replaceable for tests. */
export async function downloadArchive(archive, signal, request = fetch) {
	try {
		const response = await request(SOURCE_URL, {
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
		});
		assert(
			response.ok && response.body,
			`Official source download failed: HTTP ${response.status}`,
		);
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
	} catch (error) {
		if (error instanceof assert.AssertionError) throw error;
		// A network or file failure states its kind in a code, not a fixed message.
		const kind = [error?.cause?.code, error?.code, error?.name].find(
			(value) => typeof value === "string" && value !== "",
		);
		throw new GateFailure("Official source download failed", {
			details: [kind ?? "unknown failure"],
		});
	}
}

async function downloadSource(directory, signal) {
	const archive = join(directory, "source.zip");
	await downloadArchive(archive, signal);
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
		"--env",
		"BITOVP_HLS_NATIVE_OUT=/work/hls-gates",
		"--env",
		"BITOVP_HLS_FFMPEG=/usr/local/bin/ffmpeg",
		"--env",
		"BITOVP_HLS_FFPROBE=/usr/local/bin/ffprobe",
		"--tmpfs",
		`/work:rw,size=256m,uid=${uid},gid=${gid},mode=700`,
		"--mount",
		`type=bind,source=${source},target=/input/source.mp4,readonly`,
		"--entrypoint",
		"/bin/sh",
		resourceName(state.id),
		"-c",
		"sh scripts/editing-media.sh >&2 && exec node /app/apps/worker/node_modules/tsx/dist/cli.mjs /app/apps/worker/src/testing/media-smoke.ts",
	];
}

const COUNTS = ["tests", "passed", "failed", "cancelled", "skipped", "todo"];
// What a fixture's reporter must print: the test runner's own counts, and how
// many files declared no test (the runner counts such a file as a passed test).
const TOTALS = [...COUNTS, "emptyFiles"];

/**
 * Accounts for every media fixture from the container log: the shell loop
 * names each fixture before it starts and the fixture's reporter prints the
 * test runner's own totals when it ends.
 */
export function fixtureAccount(required = FIXTURES) {
	const runs = [];
	let pending = "";
	let unowned = 0;
	const read = (line) => {
		const fixture = /^media fixture: (\S+)$/.exec(line);
		if (fixture) runs.push({ name: fixture[1], reports: 0 });
		const totals = /^media fixture totals: (\{.*\})$/.exec(line);
		if (!totals) return;
		const run = runs.at(-1);
		if (!run) {
			unowned += 1;
			return;
		}
		// One process reports once. The first totals stand; a second report
		// fails the fixture instead of replacing them.
		run.reports += 1;
		if (run.reports > 1) return;
		try {
			const counts = JSON.parse(totals[1]);
			if (TOTALS.every((key) => Number.isSafeInteger(counts?.[key])))
				run.counts = counts;
		} catch {}
	};
	const flush = () => {
		read(pending.trimEnd());
		pending = "";
	};
	const describe = ({ name, counts, reports }) => {
		if (!counts)
			return `${name}: ${reports ? "reported unreadable totals" : "did not finish"}`;
		const others = ["failed", "cancelled", "skipped", "todo"]
			.filter((key) => counts[key] !== 0)
			.map((key) => `, ${counts[key]} ${key}`);
		if (counts.emptyFiles !== 0) others.push(", the file declares no test");
		if (reports !== 1) others.push(`, totals reported ${reports} times`);
		return `${name}: ${counts.passed} of ${counts.tests} tests passed${others.join("")}`;
	};
	return {
		accept(text) {
			const lines = (pending + text).split("\n");
			pending = lines.pop();
			for (const line of lines) read(line.trimEnd());
		},
		/** What ran before a failure, for the failure report. */
		progress() {
			flush();
			const started = new Set(runs.map((run) => run.name));
			const waiting = Object.keys(required).filter(
				(name) => !started.has(name),
			);
			return [
				...runs.map(describe),
				...(waiting.length ? [`not started: ${waiting.join(", ")}`] : []),
			];
		},
		/** Throws unless every required fixture ran once and passed all its tests. */
		finish() {
			flush();
			const problems = [];
			for (const [name, tests] of Object.entries(required)) {
				const matches = runs.filter((run) => run.name === name);
				if (matches.length !== 1) {
					problems.push(`${name}: ran ${matches.length} times, required once`);
					continue;
				}
				const { counts, reports } = matches[0];
				const complete =
					reports === 1 &&
					counts?.tests === tests &&
					counts.passed === tests &&
					TOTALS.slice(2).every((key) => counts[key] === 0);
				if (!complete)
					problems.push(`${describe(matches[0])}; ${tests} passed required`);
			}
			for (const { name } of runs)
				if (!Object.hasOwn(required, name))
					problems.push(`${name}: not a required media fixture`);
			if (unowned)
				problems.push(`totals reported before a fixture was named: ${unowned}`);
			if (problems.length)
				throw new GateFailure("Media fixtures did not all run and pass", {
					details: problems,
				});
			return {
				files: runs.length,
				tests: Object.values(required).reduce((sum, count) => sum + count, 0),
			};
		},
	};
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
		"Unexpected media summary fields",
	);
	for (const [key, expected] of Object.entries({
		version: 1,
		videoFrames: 240,
		hlsSegments: 5,
		dashSegments: 5,
		decodedPresentations: 3,
		vmafFrames: 240,
	}))
		assert.equal(
			summary[key],
			expected,
			`Incomplete media validation: ${key} must be ${expected}`,
		);
	assert.deepEqual(
		Object.keys(summary.means).sort(),
		["degraded", "encoded", "self"],
		"Unexpected VMAF comparisons in the media summary",
	);
	assert(
		Object.values(summary.means).every(
			(value) =>
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= 0 &&
				value <= 100,
		),
		"VMAF means must be numbers from 0 to 100",
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
		// Replaceable for tests; the official source cannot be reproduced there.
		verify = verifySource,
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
	// Names the part that failed in the final report.
	let step = "creating private scratch files";
	let failure;
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
		step = "verifying the official source";
		notify("Media check: verifying the official source");
		const asset = await verify(
			source ?? (await downloadSource(directory, signal)),
		);
		assert(!signal.aborted, "Media check cancelled");
		state.imageRequested = true;
		save();
		step = "building the worker image";
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
		step = "running the media fixtures, then packaging and scoring offline";
		notify(
			"Media check: testing preparation/rendering, then packaging and scoring offline",
		);
		const account = fixtureAccount();
		let raw;
		try {
			raw = await docker(containerArguments(state, asset), clean, execute, {
				timeout: 420_000,
				signal,
				diagnostics: account.accept,
			});
		} catch (error) {
			if (error instanceof GateFailure)
				error.details = [...error.details, ...account.progress()];
			throw error;
		}
		step = "checking the media fixture totals";
		const fixtures = account.finish();
		step = "checking the packaging and scoring summary";
		const summary = validateSummary(raw);
		assert(!signal.aborted, "Media check cancelled");
		step = "verifying that the source is unchanged";
		await verify(asset);
		notify(
			`Media fixtures passed: ${fixtures.files} files, ${fixtures.tests} tests, 0 skipped`,
		);
		notify(
			`Media passed: ${summary.videoFrames} video frames; HLS/DASH each ${summary.hlsSegments} x 48 frames; ${summary.decodedPresentations} complete audio/video decodes; ${summary.vmafFrames} VMAF frames per comparison`,
		);
		notify(
			`VMAF means: self=${summary.means.self.toFixed(3)}, encoded=${summary.means.encoded.toFixed(3)}, degraded=${summary.means.degraded.toFixed(3)}`,
		);
	} catch (error) {
		failure = atStep(asFailure(error), step);
	}
	// Cleanup runs on every path. When it fails too, the report keeps the first
	// failure and adds the cleanup failure after it.
	try {
		await inStep("removing the owned image, container and scratch files", () =>
			cleanupFixture(state, execute, env),
		);
	} catch (error) {
		throw failure ? withLaterFailure(failure, error) : error;
	}
	if (saved) rmSync(stateFile, { force: true });
	notify("Media fixture: owned image, container and scratch files removed");
	if (failure) throw failure;
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

if (isEntryPoint(import.meta.url)) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			// Cleanup commands retain their own timeouts and do not use this signal.
			controller.abort();
			process.exitCode = 1;
		});
	main(controller.signal).catch((error) => {
		console.error(
			"Offline media validation failed; source, media checks or owned cleanup did not complete.",
		);
		for (const line of failureLines(error)) console.error(line);
		process.exitCode = 1;
	});
}
