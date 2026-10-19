import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	childEnvironment,
	cleanupFixture,
	command,
	containerArguments,
	dockerConfiguration,
	extractSource,
	runFixture,
	validateSummary,
	verifySource,
} from "./media-smoke.mjs";

for (const signal of ["SIGINT", "SIGTERM"])
	test(`a first ${signal} during ownership inspection allows every cleanup command to finish`, {
		timeout: 10_000,
	}, async () => {
		const directory = mkdtempSync(join(tmpdir(), "media-signal-test-"));
		const scratch = mkdtempSync(
			join(realpathSync(tmpdir()), "bitovp-media-signal-"),
		);
		const id = "c".repeat(32);
		const statePath = join(directory, "state.json");
		const resources = join(directory, "resources.json");
		const ready = join(directory, "ready");
		const acknowledged = join(directory, "acknowledged");
		const release = join(directory, "release");
		const bin = join(directory, "bin");
		mkdirSync(bin, { mode: 0o700 });
		writeFileSync(join(scratch, ".owner"), id, { mode: 0o600 });
		writeFileSync(
			statePath,
			JSON.stringify({
				id,
				directory: scratch,
				imageRequested: true,
				containerRequested: true,
			}),
			{ mode: 0o600 },
		);
		writeFileSync(resources, JSON.stringify({ container: true, image: true }));
		const preload = join(directory, "acknowledge.mjs");
		writeFileSync(
			preload,
			`import fs from 'node:fs'; process.on(${JSON.stringify(signal)},()=>setImmediate(()=>fs.writeFileSync(${JSON.stringify(acknowledged)},'ready')));`,
		);
		writeFileSync(
			join(bin, "docker"),
			`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2), kind=args[2], operation=args[3];
const file=${JSON.stringify(resources)}, release=${JSON.stringify(release)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const finish=()=>{if(!state[kind])process.exit(1);process.stdout.write(JSON.stringify({'io.bitovp.media-smoke':${JSON.stringify(id)}}));};
if(operation==='inspect'&&kind==='container') {
 fs.writeFileSync(${JSON.stringify(ready)},'ready');
 const timeout=setTimeout(()=>process.exit(2),4000);
 const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);clearTimeout(timeout);finish();}},5);
} else if(operation==='inspect') finish();
else if(operation==='rm'){state[kind]=false;fs.writeFileSync(file,JSON.stringify(state));}
else if(operation==='ls'&&state[kind])process.stdout.write('owned');
`,
			{ mode: 0o700 },
		);
		const child = spawn(
			process.execPath,
			[
				"--import",
				preload,
				join(import.meta.dirname, "media-smoke.mjs"),
				"--cleanup",
				"--state-file",
				statePath,
			],
			{ env: { PATH: bin }, stdio: "ignore" },
		);
		const exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const waitFor = async (path) => {
			for (let attempt = 0; attempt < 600 && !existsSync(path); attempt++)
				await delay(5);
			assert(
				existsSync(path),
				"The harmless cleanup child did not reach its barrier",
			);
		};
		try {
			await waitFor(ready);
			assert(child.kill(signal));
			await waitFor(acknowledged);
			writeFileSync(release, "continue");
			assert.equal(await exited, 1);
			assert.deepEqual(JSON.parse(readFileSync(resources, "utf8")), {
				container: false,
				image: false,
			});
			assert.equal(existsSync(scratch), false);
			assert.equal(existsSync(statePath), false);
		} finally {
			writeFileSync(release, "continue");
			child.kill("SIGKILL");
			await exited;
			rmSync(scratch, { recursive: true, force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	});

test("Docker Desktop plugin discovery does not import user registry configuration", () => {
	assert.deepEqual(
		dockerConfiguration("linux", () => true),
		{},
	);
	assert.deepEqual(
		dockerConfiguration("darwin", () => false),
		{},
	);
	assert.deepEqual(
		dockerConfiguration("darwin", () => true),
		{
			cliPluginsExtraDirs: [
				"/Applications/Docker.app/Contents/Resources/cli-plugins",
			],
		},
	);
});

test("timeout and cancellation stop a real child without exposing its diagnostics", async () => {
	for (const [options, message] of [
		[() => ({ timeout: 30 }), "Media validation command failed"],
		[
			() => ({ timeout: 200, signal: AbortSignal.timeout(30) }),
			"Media validation command cancelled",
		],
	]) {
		await assert.rejects(
			command(
				process.execPath,
				[
					"-e",
					"process.stderr.write('discard this diagnostic');setInterval(()=>{},1000)",
				],
				{ env: {}, ...options() },
			),
			(error) => error.message === message,
		);
	}
});

test("only a local Docker socket and allowlisted child environment are accepted", () => {
	const clean = childEnvironment(
		{ PATH: "/bin", DATABASE_URL: "discard", AWS_SECRET_ACCESS_KEY: "discard" },
		"/private/scratch",
	);
	assert.equal(clean.PATH, "/bin");
	assert.equal(clean.DATABASE_URL, undefined);
	assert.equal(clean.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(clean.DOCKER_CONFIG, "/private/scratch/docker-config");
	assert.throws(() =>
		childEnvironment(
			{ DOCKER_HOST: "tcp://127.0.0.1:2375" },
			"/private/scratch",
		),
	);
	assert.throws(() =>
		childEnvironment({ DOCKER_CONTEXT: "other" }, "/private/scratch"),
	);
});

test("media execution is offline, read-only and bounded without mounting the source tree", () => {
	const args = containerArguments(
		{ id: "a".repeat(32) },
		"/private/source.mp4",
	);
	assert(args.includes("--read-only"));
	assert(args.includes("none"));
	assert(args.includes("--cap-drop=ALL"));
	assert(args.includes("--memory=1g"));
	assert(args.includes("--cpus=2"));
	assert(args.includes("--pids-limit=64"));
	assert(
		args.includes(
			"type=bind,source=/private/source.mp4,target=/input/source.mp4,readonly",
		),
	);
	assert(!args.some((arg) => arg.includes("target=/app")));
	assert.throws(() =>
		containerArguments({ id: "a".repeat(32) }, "/private/a,b.mp4"),
	);
});

test("a corrupt or oversized source is rejected before media processing", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-source-test-"));
	try {
		const source = join(directory, "source.mp4");
		writeFileSync(source, "corrupt source");
		await assert.rejects(verifySource(source), /checksum/);
		await assert.rejects(verifySource(source, 1), /size/);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("source failure removes private state without starting Docker or deleting the original", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-failure-test-"));
	try {
		const source = join(directory, "source.mp4");
		const statePath = join(directory, "state.json");
		writeFileSync(source, "corrupt source");
		let calls = 0;
		await assert.rejects(
			runFixture({ source, statePath, env: {}, notify() {} }, async () => {
				calls++;
				return "";
			}),
			/checksum/,
		);
		assert.equal(calls, 0);
		assert.equal(readFileSync(source, "utf8"), "corrupt source");
		assert.equal(existsSync(statePath), false);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("ZIP extraction targets only the pinned filename and rejects traversal", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-zip-test-"));
	try {
		const archive = join(directory, "source.zip");
		const output = join(directory, "source.mp4");
		const { execFileSync } = await import("node:child_process");
		execFileSync("python3", [
			"-I",
			"-c",
			"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z: z.writestr('BigBuckBunny_320x180.mp4',b'small fixture')",
			archive,
		]);
		await extractSource(archive, output);
		assert.equal(readFileSync(output, "utf8"), "small fixture");
		rmSync(output);
		execFileSync("python3", [
			"-I",
			"-c",
			"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('../escape.mp4',b'bad')\n z.writestr('BigBuckBunny_320x180.mp4',b'small fixture')",
			archive,
		]);
		await assert.rejects(extractSource(archive, output));
		assert.throws(() => readFileSync(output));
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("only complete numeric summaries can reach the public log", () => {
	const summary = {
		version: 1,
		videoFrames: 240,
		hlsSegments: 5,
		dashSegments: 5,
		decodedPresentations: 3,
		vmafFrames: 240,
		means: { self: 99, encoded: 90, degraded: 40 },
	};
	assert.deepEqual(validateSummary(JSON.stringify(summary)), summary);
	assert.throws(() =>
		validateSummary(JSON.stringify({ ...summary, videoFrames: 239 })),
	);
	assert.throws(() =>
		validateSummary(JSON.stringify({ ...summary, raw: "private diagnostics" })),
	);
	assert.throws(() =>
		validateSummary(
			JSON.stringify({
				...summary,
				means: { ...summary.means, encoded: null },
			}),
		),
	);
});

test("ZIP extraction rejects duplicate names, backslashes, oversized entries and damaged CRCs", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-archive-test-"));
	try {
		const archive = join(directory, "source.zip");
		const { execFileSync } = await import("node:child_process");
		for (const variant of ["duplicate", "backslash", "oversized", "crc"]) {
			const output = join(directory, `${variant}.mp4`);
			execFileSync("python3", [
				"-I",
				"-c",
				`import sys,zipfile,struct,warnings
warnings.simplefilter('ignore')
path,variant=sys.argv[1:]
with zipfile.ZipFile(path,'w') as z:
 z.writestr('BigBuckBunny_320x180.mp4',b'known payload')
 if variant=='duplicate': z.writestr('BigBuckBunny_320x180.mp4',b'duplicate')
 if variant=='backslash': z.writestr('..\\\\escape',b'bad')
data=bytearray(open(path,'rb').read())
if variant=='oversized': struct.pack_into('<I',data,data.index(b'PK\\x01\\x02')+24,100*1024*1024)
if variant=='crc': data[data.index(b'known payload')]=88
open(path,'wb').write(data)
`,
				archive,
				variant,
			]);
			await assert.rejects(extractSource(archive, output));
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("cleanup refuses resources whose ownership label differs", async () => {
	const state = {
		id: "a".repeat(32),
		directory: "/private/not-removed",
		imageRequested: false,
		containerRequested: true,
	};
	const calls = [];
	await assert.rejects(
		cleanupFixture(
			state,
			async (_binary, args) => {
				calls.push(args);
				return JSON.stringify({ "io.bitovp.media-smoke": "b".repeat(32) });
			},
			{},
		),
		/ownership/,
	);
	assert(!calls.some((args) => args.includes("rm")));
});

test("cleanup removes only labelled names and never prunes shared resources", async () => {
	const directory = mkdtempSync(
		join(realpathSync(tmpdir()), "bitovp-media-test-"),
	);
	const id = "a".repeat(32);
	writeFileSync(join(directory, ".owner"), id);
	const calls = [];
	try {
		await cleanupFixture(
			{ id, directory, imageRequested: true, containerRequested: true },
			async (_binary, args) => {
				calls.push(args);
				return args.includes("inspect")
					? JSON.stringify({ "io.bitovp.media-smoke": id })
					: "";
			},
			{},
		);
		assert.equal(existsSync(directory), false);
		const removals = calls.filter((args) => args.includes("rm"));
		assert.equal(removals.length, 2);
		assert(removals.every((args) => args.at(-1) === `bitovp-media-${id}`));
		assert(!calls.some((args) => args.includes("prune")));
		assert(
			!removals.find((args) => args.includes("image")).includes("--force"),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
