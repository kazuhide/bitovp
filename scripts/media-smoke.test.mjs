import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
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
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { failureLines } from "./gate-report.mjs";
import {
	childEnvironment,
	cleanupFixture,
	command,
	containerArguments,
	dockerConfiguration,
	downloadArchive,
	extractSource,
	FIXTURES,
	fixtureAccount,
	runFixture,
	validateSummary,
	verifySource,
} from "./media-smoke.mjs";

const fixtureLog = (name, counts) =>
	`media fixture: ${name}\n✔ a test (1ms)\nmedia fixture totals: ${JSON.stringify(
		{
			tests: 0,
			passed: 0,
			failed: 0,
			cancelled: 0,
			skipped: 0,
			todo: 0,
			topLevel: 0,
			suites: 0,
			...counts,
		},
	)}\n`;
const completeLog = (change = {}) =>
	Object.entries(FIXTURES)
		.map(([name, tests]) =>
			fixtureLog(name, { tests, passed: tests, ...change[name] }),
		)
		.join("");

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

test("timeout and cancellation stop a real child and keep its diagnostics out of the message", async () => {
	for (const [options, message, details] of [
		[
			() => ({ timeout: 300 }),
			"Media validation command failed",
			["The command was stopped at its 0.3 second limit"],
		],
		[
			() => ({ timeout: 2_000, signal: AbortSignal.timeout(300) }),
			"Media validation command cancelled",
			[],
		],
	]) {
		await assert.rejects(
			command(
				process.execPath,
				[
					"-e",
					"process.stderr.write('kept for the failure report\\n');setInterval(()=>{},1000)",
				],
				{ env: {}, ...options() },
			),
			(error) => {
				assert.equal(error.message, message);
				assert.deepEqual(error.details, details);
				assert.equal(error.diagnostics, "kept for the failure report\n");
				return true;
			},
		);
	}
});

test("a failed command reports the end of its own diagnostics, not its result", async () => {
	const seen = [];
	await assert.rejects(
		command(
			process.execPath,
			[
				"-e",
				"console.log('result text');console.error('::error::forged');console.error('real reason');process.exit(3)",
			],
			{ env: {}, diagnostics: (text) => seen.push(text) },
		),
		(error) => {
			assert.deepEqual(failureLines(error), [
				"Reason: Media validation command failed",
				"Last 2 lines of the failed command:",
				"  | ::error::forged",
				"  | real reason",
			]);
			return true;
		},
	);
	assert.equal(seen.join(""), "::error::forged\nreal reason\n");
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

test("the offline image runs every real editing and reference fixture", () => {
	const root = join(import.meta.dirname, "..");
	const { scripts } = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	);
	assert.equal(scripts["test:editing-media"], "sh scripts/editing-media.sh");
	const script = readFileSync(
		new URL("./editing-media.sh", import.meta.url),
		"utf8",
	);
	const discovered = ["library-editing", "vmaf"].flatMap((folder) =>
		readdirSync(join(root, "apps/worker/src", folder))
			.filter((name) => name.endsWith(".media.ts"))
			.map((name) => `src/${folder}/${name}`),
	);
	assert.deepEqual(
		[...script.matchAll(/src\/[\w/-]+\.media\.ts/g)]
			.map(([name]) => name)
			.sort(),
		discovered.sort(),
	);
	const args = containerArguments(
		{ id: "a".repeat(32) },
		"/private/source.mp4",
	);
	// The manifest requires the same fixtures, in the order the script runs them.
	assert.deepEqual(
		[...script.matchAll(/src\/[\w/-]+\.media\.ts/g)].map(([name]) => name),
		Object.keys(FIXTURES),
	);
	assert(Object.values(FIXTURES).every((tests) => tests > 0));
	assert(args.includes("BITOVP_HLS_NATIVE_OUT=/work/hls-gates"));
	assert(args.includes("BITOVP_HLS_FFMPEG=/usr/local/bin/ffmpeg"));
	assert(args.includes("BITOVP_HLS_FFPROBE=/usr/local/bin/ffprobe"));
	assert(args.at(-1).startsWith("sh scripts/editing-media.sh >&2 && "));
});

for (const succeeds of [false, true])
	test(`an editing media gate ${succeeds ? "success permits" : "failure blocks"} the final QC summary`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "media-gate-order-"));
		try {
			const marker = join(directory, "qc-ran");
			writeFileSync(
				join(directory, "sh"),
				`#!${process.execPath}\nprocess.exit(${succeeds ? 0 : 7});\n`,
				{ mode: 0o700 },
			);
			writeFileSync(
				join(directory, "node"),
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.QC_MARKER,'ran');process.stdout.write('qc completed');\n`,
				{ mode: 0o700 },
			);
			const args = containerArguments(
				{ id: "a".repeat(32) },
				"/private/source.mp4",
			);
			const entrypoint = args.indexOf("--entrypoint");
			const run = command(args[entrypoint + 1], args.slice(entrypoint + 3), {
				env: { PATH: directory, QC_MARKER: marker },
			});
			if (succeeds) assert.equal(await run, "qc completed");
			else await assert.rejects(run, /Media validation command failed/);
			assert.equal(existsSync(marker), succeeds);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

for (const fails of [false, true])
	test(`native fixtures use fresh processes and ${fails ? "stop at failure" : "all execute"}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "native-media-loop-"));
		try {
			const bin = join(directory, "bin"),
				scripts = join(directory, "scripts");
			mkdirSync(bin);
			mkdirSync(scripts);
			mkdirSync(join(directory, "apps/worker"), { recursive: true });
			const log = join(directory, "calls.jsonl"),
				runner = join(scripts, "editing-media.sh");
			writeFileSync(
				runner,
				readFileSync(new URL("./editing-media.sh", import.meta.url)),
			);
			writeFileSync(
				join(bin, "node"),
				`#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.MEDIA_LOG,JSON.stringify({pid:process.pid,args,go:process.env.GOMAXPROCS})+'\\n');
if(args.at(-1)===process.env.FAIL_FIXTURE)process.exit(7);
`,
				{ mode: 0o700 },
			);
			const run = command("/bin/sh", [runner], {
				cwd: tmpdir(),
				env: {
					PATH: `${bin}:/usr/bin:/bin`,
					MEDIA_LOG: log,
					FAIL_FIXTURE: fails ? "src/library-editing/render.media.ts" : "",
				},
			});
			if (fails) await assert.rejects(run, /Media validation command failed/);
			else
				assert.deepEqual(
					(await run).split("\n"),
					Object.keys(FIXTURES).map((name) => `media fixture: ${name}`),
				);
			const calls = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(calls.length, fails ? 4 : 6);
			assert.equal(new Set(calls.map((call) => call.pid)).size, calls.length);
			assert(
				calls.every(
					(call) =>
						call.go === "2" &&
						call.args.includes("--test") &&
						call.args.includes("--experimental-test-isolation=none") &&
						call.args.includes(
							"--test-reporter=../../scripts/media-smoke-reporter.mjs",
						),
				),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

test("the fixture reporter gives the media runner the test runner's own totals", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-reporter-test-"));
	try {
		const run = async (name, source) => {
			writeFileSync(join(directory, name), source);
			const output = await command(
				process.execPath,
				[
					"--test",
					"--experimental-test-isolation=none",
					"--test-reporter=spec",
					"--test-reporter-destination=stdout",
					`--test-reporter=${pathToFileURL(join(import.meta.dirname, "media-smoke-reporter.mjs")).href}`,
					"--test-reporter-destination=stdout",
					join(directory, name),
				],
				{ env: { PATH: process.env.PATH } },
			);
			const account = fixtureAccount({ [name]: 3 });
			account.accept(`media fixture: ${name}\n${output}\n`);
			return account;
		};
		const passing = await run(
			"passing.media.mjs",
			`import test from "node:test";
test("first", () => {});
test("second", async (t) => { await t.test("inner", () => {}); });
`,
		);
		assert.deepEqual(passing.finish(), { files: 1, tests: 3 });
		const skipping = await run(
			"skipping.media.mjs",
			`import test from "node:test";
test("first", () => {});
test("second", async (t) => { await t.test("inner", () => {}); });
test("unavailable", { skip: true }, () => {});
test("later", { todo: true }, () => {});
`,
		);
		assert.throws(
			() => skipping.finish(),
			(error) => {
				assert.deepEqual(error.details, [
					"skipping.media.mjs: 3 of 5 tests passed, 1 skipped, 1 todo; 3 passed required",
				]);
				return true;
			},
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every required fixture must run once and pass its required number of tests", () => {
	const complete = fixtureAccount();
	// Pipe chunks do not end at line boundaries.
	for (const chunk of completeLog().match(/[\s\S]{1,37}/g))
		complete.accept(chunk);
	assert.deepEqual(complete.finish(), {
		files: Object.keys(FIXTURES).length,
		tests: Object.values(FIXTURES).reduce((sum, tests) => sum + tests, 0),
	});
	const [first, second] = Object.keys(FIXTURES);
	const required = FIXTURES[second];
	const firstLog = fixtureLog(first, {
		tests: FIXTURES[first],
		passed: FIXTURES[first],
	});
	assert(completeLog().startsWith(firstLog));
	for (const [log, problem] of [
		[
			completeLog().replace(firstLog, ""),
			`${first}: ran 0 times, required once`,
		],
		[completeLog() + firstLog, `${first}: ran 2 times, required once`],
		[
			completeLog({ [second]: { tests: required - 1, passed: required - 1 } }),
			`${second}: ${required - 1} of ${required - 1} tests passed; ${required} passed required`,
		],
		[
			completeLog({ [second]: { passed: required - 1, skipped: 1 } }),
			`${second}: ${required - 1} of ${required} tests passed, 1 skipped; ${required} passed required`,
		],
		[
			completeLog({ [second]: { passed: required - 1, failed: 1 } }),
			`${second}: ${required - 1} of ${required} tests passed, 1 failed; ${required} passed required`,
		],
		[
			completeLog({ [second]: { cancelled: 1 } }),
			`${second}: ${required} of ${required} tests passed, 1 cancelled; ${required} passed required`,
		],
		[
			completeLog({ [second]: { tests: required + 1, todo: 1 } }),
			`${second}: ${required} of ${required + 1} tests passed, 1 todo; ${required} passed required`,
		],
		[
			completeLog({ [second]: { tests: "4" } }),
			`${second}: did not finish; ${required} passed required`,
		],
		[
			completeLog().replace(/media fixture totals: [^\n]+\n$/, ""),
			`${Object.keys(FIXTURES).at(-1)}: did not finish; ${Object.values(FIXTURES).at(-1)} passed required`,
		],
		[
			completeLog() + fixtureLog("src/other.media.ts", { tests: 1, passed: 1 }),
			"src/other.media.ts: not a required media fixture",
		],
	]) {
		const account = fixtureAccount();
		account.accept(log);
		assert.throws(
			() => account.finish(),
			(error) => {
				assert.equal(error.message, "Media fixtures did not all run and pass");
				assert.deepEqual(error.details, [problem]);
				return true;
			},
		);
	}
	// Totals that precede every fixture belong to none of them.
	const stray = fixtureAccount({});
	stray.accept(fixtureLog("ignored", {}).split("\n").slice(1).join("\n"));
	assert.deepEqual(stray.finish(), { files: 0, tests: 0 });
});

test("a failed media run reports which fixtures finished, stopped and never started", () => {
	const names = Object.keys(FIXTURES);
	const account = fixtureAccount();
	account.accept(
		`${fixtureLog(names[0], { tests: 1, passed: 1 })}${fixtureLog(names[1], { tests: 4, passed: 3, failed: 1 })}media fixture: ${names[2]}\n✖ stopped here`,
	);
	assert.deepEqual(account.progress(), [
		`${names[0]}: 1 of 1 tests passed`,
		`${names[1]}: 3 of 4 tests passed, 1 failed`,
		`${names[2]}: did not finish`,
		`not started: ${names.slice(3).join(", ")}`,
	]);
	assert.deepEqual(fixtureAccount().progress(), [
		`not started: ${names.join(", ")}`,
	]);
});

test("the runner started through a symlinked path still runs and reports its failure", () => {
	const directory = mkdtempSync(join(tmpdir(), "media-symlink-test-"));
	try {
		symlinkSync(import.meta.dirname, join(directory, "linked"));
		const result = spawnSync(
			process.execPath,
			[join(directory, "linked", "media-smoke.mjs"), "--unknown", "value"],
			{ env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000 },
		);
		assert.equal(result.status, 1);
		assert.deepEqual(result.stderr.trimEnd().split("\n"), [
			"Offline media validation failed; source, media checks or owned cleanup did not complete.",
			"Reason: Unknown or duplicate media option",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("media builds refresh the base image before offline execution", () => {
	const source = readFileSync(
		new URL("./media-smoke.mjs", import.meta.url),
		"utf8",
	);
	assert(
		/"build",\s*"--pull"/.test(source),
		"Media builds must refresh the base image",
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

test("a failed source download reports its kind without the underlying message", async () => {
	const directory = mkdtempSync(join(tmpdir(), "media-download-test-"));
	const signal = new AbortController().signal;
	try {
		for (const [request, message, details] of [
			[
				async () => {
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error("connect to 203.0.113.7 refused"), {
							code: "ECONNREFUSED",
						}),
					});
				},
				"Official source download failed",
				["ECONNREFUSED"],
			],
			[
				async () => {
					throw new DOMException("timed out", "TimeoutError");
				},
				"Official source download failed",
				["TimeoutError"],
			],
			[
				async () => ({ ok: false, status: 503, headers: new Headers() }),
				"Official source download failed: HTTP 503",
				undefined,
			],
			[
				async () => ({
					ok: true,
					status: 200,
					headers: new Headers(),
					body: (async function* () {
						yield new Uint8Array(4);
						throw new TypeError("terminated", {
							cause: Object.assign(new Error("other side closed"), {
								code: "UND_ERR_SOCKET",
							}),
						});
					})(),
				}),
				"Official source download failed",
				["UND_ERR_SOCKET"],
			],
		]) {
			const archive = join(directory, `${randomUUID()}.zip`);
			await assert.rejects(
				downloadArchive(archive, signal, request),
				(error) => {
					assert.equal(error.message, message);
					assert.deepEqual(error.details, details);
					assert.equal(failureLines(error)[0], `Reason: ${message}`);
					return true;
				},
			);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
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
	assert.throws(
		() => validateSummary(JSON.stringify({ ...summary, videoFrames: 239 })),
		/Incomplete media validation: videoFrames must be 240/,
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
