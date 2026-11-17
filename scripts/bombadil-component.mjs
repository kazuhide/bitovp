import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const component = "apps/web/src/app/vod/new/rendition-add-controls.tsx";
// This main ancestor remains reachable after the foundation branch is squashed.
const historical = "8c8642a0332585e934461302df4ac91a55f9bb9e";
const fixture = join(root, "tests/bombadil/rendition-fixture.tsx");
const specification = join(root, "tests/bombadil/rendition.spec.ts");
export const properties = [
	"defaultCopySourceIsLast",
	"explicitSelectionIsNotRedirected",
	"copiedSourceMatchesVisibleChoice",
	"eachAddHasOneReceipt",
];
export const binaryHashes = {
	"darwin-arm64":
		"3d7866e2e8356390a0f2560853e3c775839f8c8ff648c9552c0105f7f78d1d72",
	"linux-x64":
		"6f2664ca7d4067017b4efb26db5c29d6dcfecdc78131f96989d336f12420cc1b",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (path, value) =>
	writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});

export function childEnvironment(temporary) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "en_US.UTF-8",
		TMPDIR: temporary,
		NO_COLOR: "1",
	};
}
export function summarizeTrace(entries) {
	assert(entries.length > 0, "Bombadil did not capture a state");
	const violations = entries.flatMap((entry) => entry.violations ?? []);
	const names = properties.filter((name) =>
		violations.some((violation) => violation.name === name),
	);
	return {
		states: entries.length,
		actions: entries.filter((entry) => entry.action != null).length,
		violationNames: names,
		violations,
	};
}
export function transitionCoverage(models) {
	const counts = {
		uniqueKeyReorders: 0,
		resolvedCollisionReorders: 0,
		ambiguousCountResets: 0,
	};
	let resolvedSelection = false;
	for (let i = 1; i < models.length; i++) {
		const previous = models[i - 1];
		const current = models[i];
		if (
			current.counts.select > previous.counts.select ||
			current.counts.reset > previous.counts.reset ||
			current.collision
		)
			resolvedSelection = false;
		if (
			previous.collision &&
			!current.collision &&
			current.intent?.label != null
		)
			resolvedSelection = true;
		if (
			current.counts.reorder > previous.counts.reorder &&
			!current.collision &&
			current.intent?.label != null
		) {
			counts.uniqueKeyReorders++;
			if (resolvedSelection) counts.resolvedCollisionReorders++;
			resolvedSelection = false;
		}
		if (
			current.collision &&
			current.counts.add > previous.counts.add &&
			previous.intent?.label != null &&
			current.pristine
		)
			counts.ambiguousCountResets++;
	}
	return counts;
}
export function requireCoverage(evidence, trace) {
	assert(evidence?.ready === true, "Fixture readiness was never observed");
	assert(trace.actions >= 20, "Fewer than 20 actual Bombadil actions");
	for (const key of ["select", "collision", "reorder", "add", "reset"])
		assert(evidence.counts[key] > 0, `Unreached action: ${key}`);
	assert(evidence.receipts.length > 0, "No actual onAdd callback observed");
}
export function acceptPositiveTrace(entries) {
	const trace = summarizeTrace(entries);
	const evidence = [];
	let readyObserved = false;
	for (const [index, entry] of entries.entries()) {
		const states = (entry.snapshots ?? []).filter(
			(snapshot) => snapshot.name === "state",
		);
		if (states.some((snapshot) => snapshot.value?.ready === true))
			readyObserved = true;
		if (!readyObserved) continue;
		assert(
			states.length === 1 && states[0].value?.ready === true,
			`Fixture readiness lost or ambiguous at observation ${index}`,
		);
		evidence.push(states[0].value);
	}
	const transitions = transitionCoverage(evidence);
	assert.equal(trace.violations.length, 0);
	requireCoverage(evidence.at(-1), trace);
	for (const [name, count] of Object.entries(transitions))
		assert(count > 0, `Unreached transition: ${name}`);
	return { trace, evidence, transitions };
}
export function terminate(child, signal = "SIGKILL") {
	// A detached leader can exit while its owned process group still has helpers.
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}
export function fixtureSandboxArgs(platform = process.platform) {
	// Only our synthetic loopback fixture runs in this dedicated browser. Ubuntu
	// AppArmor can prevent the downloaded Chromium from creating its sandbox.
	return platform === "linux" ? ["--no-sandbox"] : [];
}
async function waitForExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((done, reject) => {
		child.once("exit", done);
		child.once("error", reject);
	});
}

async function main() {
	process.umask(0o077);
	const options = Object.fromEntries(
		process.argv.slice(2).map((arg) => {
			const match = /^--(binary|dependencies|output)=(.+)$/.exec(arg);
			assert(match, `Unknown argument: ${arg}`);
			return [match[1], resolve(match[2])];
		}),
	);
	assert(
		options.binary && options.output,
		"Use --binary=<verified CLI> --output=<new evidence directory> [--dependencies=<checkout with installed dependencies>]",
	);
	const binaryBytes = await readFile(options.binary);
	assert.equal(
		digest(binaryBytes),
		binaryHashes[`${process.platform}-${process.arch}`],
		"Unexpected Bombadil binary hash",
	);
	const dependencies = options.dependencies ?? root;
	const webRequire = createRequire(join(dependencies, "apps/web/package.json"));
	const vitestRequire = createRequire(
		webRequire.resolve("vitest/package.json"),
	);
	const viteRequire = createRequire(vitestRequire.resolve("vite/package.json"));
	const { build } = viteRequire("esbuild");
	const chrome = webRequire("@playwright/test").chromium.executablePath();
	const git = (...args) => {
		const result = spawnSync(
			"git",
			["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
			{ cwd: root },
		);
		assert.equal(result.status, 0, result.stderr.toString());
		return result.stdout;
	};
	const oldSource = git("show", `${historical}:${component}`);
	assert.equal(
		digest(oldSource),
		"5a4eaf947b6d789a5132a85a93afe6e5c8474ac6841fc3e4b41f10ee42b42d69",
		"Historical control bytes changed",
	);
	const currentSource = await readFile(join(root, component));
	assert.notEqual(
		digest(oldSource),
		digest(currentSource),
		"Corrected component is not present; wait for the reviewed fix before positive verification",
	);
	await mkdir(options.output, { recursive: false, mode: 0o700 });
	const env = childEnvironment(tmpdir());
	const version = spawnSync(options.binary, ["--version"], {
		env,
		encoding: "utf8",
	});
	assert.equal(version.status, 0);
	assert.equal(version.stdout.trim(), "bombadil 0.7.10");
	const browserVersion = spawnSync(chrome, ["--version"], {
		env,
		encoding: "utf8",
	});
	assert.equal(browserVersion.status, 0);
	const metadata = {
		head: git("rev-parse", "HEAD").toString().trim(),
		tree: git("rev-parse", "HEAD^{tree}").toString().trim(),
		historical,
		component,
		currentComponentSha256: digest(currentSource),
		historicalComponentSha256: digest(oldSource),
		fixtureSha256: digest(await readFile(fixture)),
		specificationSha256: digest(await readFile(specification)),
		toolVersion: version.stdout.trim(),
		toolSha256: digest(binaryBytes),
		browserVersion: browserVersion.stdout.trim(),
		browserSha256: digest(await readFile(chrome)),
		lockSha256: digest(await readFile(join(dependencies, "pnpm-lock.yaml"))),
		viewport: { width: 1024, height: 768 },
		sourceScope: "real standalone React component; full installed GUI retained",
		positiveBudgetSeconds: 30,
		negativeBudgetSeconds: 30,
		outerRunBudgetSeconds: 60,
	};
	const temporary = await mkdtemp(join(tmpdir(), "bitovp-bombadil-"));
	env.TMPDIR = temporary;
	let activeBundle;
	const server = createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
		);
		if (request.method === "GET" && request.url === "/") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				'<!doctype html><html lang="en"><meta charset="utf-8"><title>Rendition fixture</title><style>body{font:16px sans-serif;margin:24px}button,select{margin:8px;padding:8px}output{display:block;white-space:pre-wrap;font:11px monospace;max-width:900px}</style><div id="root"></div><script src="/app.js"></script></html>',
			);
		} else if (request.method === "GET" && request.url === "/app.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(activeBundle);
		} else response.writeHead(404).end();
	});
	let browser;
	let bombadil;
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
		terminate(bombadil);
		terminate(browser);
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		const pinnedSpecification = join(options.output, "specification.ts");
		await writeFile(pinnedSpecification, await readFile(specification), {
			flag: "wx",
			mode: 0o600,
		});
		await writeFile(
			join(options.output, "fixture.tsx"),
			await readFile(fixture),
			{ flag: "wx", mode: 0o600 },
		);
		const bundles = {};
		for (const [label, source] of [
			["current", currentSource],
			["historical", oldSource],
		]) {
			const bundle = await build({
				entryPoints: [fixture],
				bundle: true,
				write: false,
				platform: "browser",
				format: "iife",
				jsx: "automatic",
				tsconfig: join(root, "apps/web/tsconfig.json"),
				define: { "process.env.NODE_ENV": '"production"' },
				nodePaths: [
					join(dependencies, "apps/web/node_modules"),
					join(dependencies, "node_modules"),
				],
				plugins: [
					{
						name: "pinned-real-component",
						setup(builder) {
							builder.onLoad(
								{ filter: /rendition-add-controls\.tsx$/ },
								() => ({
									contents: source.toString(),
									loader: "tsx",
									resolveDir: dirname(join(root, component)),
								}),
							);
						},
					},
				],
				logLevel: "silent",
			});
			bundles[label] = bundle.outputFiles[0].contents;
			await writeFile(
				join(options.output, `${label}-bundle.js`),
				bundles[label],
				{ mode: 0o600, flag: "wx" },
			);
		}
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		const origin = `http://127.0.0.1:${server.address().port}/`;
		await writeJson(join(options.output, "provenance.json"), {
			...metadata,
			origin,
			currentBundleSha256: digest(bundles.current),
			historicalBundleSha256: digest(bundles.historical),
		});
		const results = [];
		for (const stage of ["current", "historical", "replay"]) {
			assert(!interrupted, "Experiment interrupted");
			activeBundle = stage === "current" ? bundles.current : bundles.historical;
			const output = join(options.output, stage);
			const profile = join(temporary, stage);
			await mkdir(profile);
			const chromeArgs = [
				"--headless",
				...fixtureSandboxArgs(),
				`--user-data-dir=${profile}`,
				"--remote-debugging-port=0",
				"--remote-debugging-address=127.0.0.1",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-background-networking",
				"--disable-component-update",
				"--no-pings",
				"--disable-crash-reporter",
				"--use-mock-keychain",
				"about:blank",
			];
			browser = spawn(chrome, chromeArgs, {
				env,
				detached: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let browserLog = "";
			browser.stderr.on("data", (part) => {
				browserLog += part;
			});
			let port;
			for (let i = 0; i < 100; i++) {
				try {
					port = Number(
						(await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
							"\n",
						)[0],
					);
					if (port) break;
				} catch {
					/* Chrome has not published its owned port yet. */
				}
				assert(
					browser.exitCode === null,
					"Owned Chromium exited during startup",
				);
				await pause(100);
			}
			assert(port, "Owned Chromium did not publish its CDP port");
			const args = [
				"browser",
				"test-external",
				"--remote-debugger",
				`http://127.0.0.1:${port}`,
				"--create-target",
				"--width",
				"1024",
				"--height",
				"768",
				"--output-path",
				output,
				...(stage === "replay"
					? ["--reproduce", join(options.output, "historical")]
					: ["--time-limit", "30s", "--exit-on-violation"]),
				origin,
				pinnedSpecification,
			];
			const started = performance.now();
			let log = "";
			let timedOut = false;
			bombadil = spawn(options.binary, args, {
				cwd: root,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			bombadil.stdout.on("data", (part) => {
				log += part;
			});
			bombadil.stderr.on("data", (part) => {
				log += part;
			});
			const timeout = setTimeout(() => {
				timedOut = true;
				terminate(bombadil);
			}, 60000);
			try {
				await waitForExit(bombadil);
			} finally {
				clearTimeout(timeout);
				terminate(bombadil);
			}
			terminate(browser);
			await waitForExit(browser);
			browser = undefined;
			await writeFile(join(options.output, `${stage}.log`), log, {
				mode: 0o600,
				flag: "wx",
			});
			await writeFile(
				join(options.output, `${stage}-browser.log`),
				browserLog,
				{ mode: 0o600, flag: "wx" },
			);
			const traceBytes = await readFile(join(output, "trace.jsonl"));
			const entries = traceBytes
				.toString()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const trace = summarizeTrace(entries);
			const evidence = entries.flatMap((entry) =>
				(entry.snapshots ?? [])
					.filter(
						(snapshot) => snapshot.name === "state" && snapshot.value?.ready,
					)
					.map((snapshot) => snapshot.value),
			);
			const transitions = transitionCoverage(evidence);
			const terminalStates = (entries.at(-1).snapshots ?? []).filter(
				(snapshot) => snapshot.name === "state",
			);
			const terminalState =
				terminalStates.length === 1 ? terminalStates[0].value : null;
			await writeJson(join(options.output, `${stage}-coverage.json`), {
				lastObservedState: terminalState,
				transitions,
			});
			const result = {
				stage,
				command: [options.binary, ...args],
				exitCode: bombadil.exitCode,
				signal: bombadil.signalCode,
				timedOut,
				elapsedMs: Math.round(performance.now() - started),
				traceSha256: digest(traceBytes),
				...trace,
				coverage: terminalState?.counts ?? null,
				transitions,
			};
			await writeJson(join(options.output, `${stage}-result.json`), result);
			results.push(result);
			console.log(
				JSON.stringify({
					...result,
					command: undefined,
					violations: undefined,
				}),
			);
			assert(!timedOut, `${stage} exceeded the outer budget`);
			assert(!interrupted, "Experiment interrupted");
			if (stage === "current") {
				assert.equal(
					result.exitCode,
					0,
					"Corrected component run did not pass",
				);
				acceptPositiveTrace(entries);
			} else {
				assert.equal(
					result.exitCode,
					2,
					`${stage} did not report a Bombadil property violation`,
				);
				assert(
					trace.actions > 0,
					"Negative control performed no generated action",
				);
				assert(
					trace.violationNames.some((name) =>
						properties.slice(0, 3).includes(name),
					),
					"Negative control failed for an unintended reason",
				);
			}
			if (stage === "replay") {
				assert.match(log, /Reproduction finished/);
				assert.deepEqual(result.violationNames, results[1].violationNames);
			}
		}
		await writeJson(join(options.output, "summary.json"), {
			...metadata,
			results,
			status: "passed",
			scope:
				"bounded real-component exploration, historical control and actual Bombadil replay; not full-application proof",
		});
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		terminate(bombadil);
		terminate(browser);
		if (browser) await waitForExit(browser);
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		await rm(temporary, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	await main();
