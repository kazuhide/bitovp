import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { binaryHashes, childEnvironment } from "./bombadil-component.mjs";
import { isEntryPoint } from "./gate-report.mjs";
import { sourceRevision } from "./source-revision.mjs";

const root = resolve(import.meta.dirname, "..");
const specification = join(root, "tests/bombadil/installed-wizard.spec.ts");
const actionClasses = ["edit", "select", "add", "remove", "revisit"];
const negativeProperty = "configuredRenditionsMatchIntent";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function launchInstalledTool(binary, args, env) {
	return spawn(binary, args, {
		cwd: root,
		env,
		// The Playwright wrapper owns the driver's process group. Keep the tool
		// inside it so the outer timeout also catches it after a driver failure.
		detached: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function acceptInstalledTrace(entries, negative = false) {
	assert(
		Array.isArray(entries) && entries.length > 0,
		"Installed trace is empty",
	);
	const names = new Set();
	const models = entries.map((entry) => {
		assert(Array.isArray(entry.violations ?? []), "Malformed violations");
		for (const violation of entry.violations ?? []) {
			assert(
				typeof violation?.name === "string" && violation.name,
				"Malformed violation",
			);
			names.add(violation.name);
		}
		const snapshots = (entry.snapshots ?? []).filter(
			(value) => value.name === "state",
		);
		assert.equal(
			snapshots.length,
			1,
			"Installed state snapshot missing or duplicated",
		);
		const model = snapshots[0].value;
		assert.equal(model?.ready, true, "Installed wizard readiness lost");
		for (const rows of [model.expected, model.actual, model.serialized])
			assert(
				Array.isArray(rows) &&
					rows.length > 0 &&
					rows.every(
						(row) =>
							Number.isFinite(row?.height) &&
							row.height > 0 &&
							Number.isFinite(row?.bitrate) &&
							row.bitrate > 0,
					),
				"Malformed installed rows",
			);
		for (const name of actionClasses)
			assert(
				Number.isInteger(model.counts?.[name]) && model.counts[name] >= 0,
				"Malformed action count",
			);
		assert(
			Number.isInteger(model.faults) && model.faults >= 0,
			"Malformed fault count",
		);
		assert(
			Number.isInteger(model.actualSelected) && model.actualSelected >= 0,
			"Malformed actual selection",
		);
		if (model.selected != null) {
			assert(
				Number.isInteger(model.selected) && model.selected > 0,
				"Malformed intended selection",
			);
			assert.equal(
				model.actualSelected,
				model.selected,
				"Visible copy selection differs from intent",
			);
		}
		if (model.counts.edit > 0)
			assert.deepEqual(
				model.guarded,
				{ mutation: true, external: true },
				"Browser network guard was not observed",
			);
		if (!negative) {
			assert.deepEqual(
				model.actual,
				model.expected,
				"Visible ladder differs from intent",
			);
			assert.deepEqual(
				model.serialized,
				model.expected,
				"Serialized ladder differs from intent",
			);
		}
		return model;
	});
	const actions = entries.filter((entry) => entry.action != null).length;
	const last = models.at(-1);
	const violationNames = [...names].sort();
	if (negative) {
		assert.deepEqual(
			violationNames,
			[negativeProperty],
			"Negative control failed for an unintended reason",
		);
		assert(
			actions > 0 && last.counts.add > 0,
			"Negative control performed no Add action",
		);
		assert.equal(
			last.faults,
			1,
			"Negative control did not inject its fault exactly once",
		);
		assert(
			!isDeepStrictEqual(last.actual, last.expected),
			"Negative control recorded no visible copy mismatch",
		);
	} else {
		assert.deepEqual(violationNames, [], "Installed property violation");
		assert(actions >= 20, "Fewer than 20 actual installed Bombadil actions");
		for (const name of actionClasses)
			assert(last.counts[name] > 0, `Unreached installed action: ${name}`);
		assert.equal(last.faults, 0, "Positive exploration injected a fault");
	}
	return { states: entries.length, actions, violationNames, last };
}

async function oneTarget(endpoint, origin) {
	const response = await fetch(`${endpoint}/json/list`, {
		signal: AbortSignal.timeout(3000),
	});
	assert(response.ok, "Owned CDP target census failed");
	const targets = (await response.json()).filter(
		(target) => target.type === "page",
	);
	assert.equal(
		targets.length,
		1,
		"Bombadil requires exactly one owned page target",
	);
	assert.equal(
		targets[0].url,
		origin,
		"Owned page is not the prepared installed wizard",
	);
	return targets[0].id;
}

async function main() {
	process.umask(0o077);
	const options = Object.fromEntries(
		process.argv.slice(2).map((arg) => {
			const match =
				/^--(binary|endpoint|origin|output|stage|reproduce)=(.+)$/.exec(arg);
			assert(match, "Unknown installed Bombadil argument");
			return [match[1], match[2]];
		}),
	);
	assert(["current", "negative", "replay"].includes(options.stage));
	assert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(options.endpoint));
	assert(/^http:\/\/localhost:[1-9]\d*\/vod\/new$/.test(options.origin));
	assert(options.binary && options.output);
	const toolSha256 = digest(await readFile(options.binary));
	assert.equal(
		toolSha256,
		binaryHashes[`${process.platform}-${process.arch}`],
		"Unexpected Bombadil binary hash",
	);
	const before = await oneTarget(options.endpoint, options.origin);
	await mkdir(options.output, { mode: 0o700 });
	const pinnedSpec = join(options.output, "specification.ts");
	const specBytes = await readFile(specification);
	await writeFile(pinnedSpec, specBytes, { mode: 0o600, flag: "wx" });
	await writeFile(
		join(options.output, "installed-wizard-model.ts"),
		await readFile(join(root, "tests/bombadil/installed-wizard-model.ts")),
		{ mode: 0o600, flag: "wx" },
	);
	const args = [
		"browser",
		"test-external",
		"--remote-debugger",
		options.endpoint,
		"--width",
		"1440",
		"--height",
		"1000",
		"--output-path",
		join(options.output, "trace"),
		...(options.stage === "replay"
			? ["--reproduce", options.reproduce]
			: ["--time-limit", "30s", "--exit-on-violation"]),
		options.origin,
		pinnedSpec,
	];
	assert(
		options.stage !== "replay" || options.reproduce,
		"Replay trace is required",
	);
	const child = launchInstalledTool(
		options.binary,
		args,
		childEnvironment(options.output),
	);
	let log = "";
	let timedOut = false;
	let interrupted = false;
	child.stdout.on("data", (chunk) => {
		log += chunk;
	});
	child.stderr.on("data", (chunk) => {
		log += chunk;
	});
	const interrupt = () => {
		interrupted = true;
		child.kill("SIGKILL");
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	const started = performance.now();
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, 45_000);
	try {
		await new Promise((done, reject) => {
			child.once("exit", done);
			child.once("error", reject);
		});
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		child.kill("SIGKILL");
		await writeFile(join(options.output, "bombadil.log"), log, { mode: 0o600 });
	}
	assert(
		!timedOut && !interrupted,
		"Installed Bombadil did not complete within its budget",
	);
	assert.equal(
		await oneTarget(options.endpoint, options.origin),
		before,
		"Bombadil changed its owned target",
	);
	const traceBytes = await readFile(join(options.output, "trace/trace.jsonl"));
	const entries = traceBytes
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const result = {
		stage: options.stage,
		sourceRevision: sourceRevision(root),
		toolSha256,
		specificationSha256: digest(specBytes),
		lockSha256: digest(await readFile(join(root, "pnpm-lock.yaml"))),
		traceSha256: digest(traceBytes),
		exitCode: child.exitCode,
		elapsedMs: Math.round(performance.now() - started),
		...acceptInstalledTrace(entries, options.stage !== "current"),
	};
	await writeFile(
		join(options.output, "summary.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	assert.equal(
		child.exitCode,
		options.stage === "current" ? 0 : 2,
		"Unexpected Bombadil exit code",
	);
	if (options.stage === "replay") assert.match(log, /Reproduction finished/);
	console.log(JSON.stringify({ ...result, last: undefined }));
}

if (isEntryPoint(import.meta.url)) await main();
