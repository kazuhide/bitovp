import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
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
import { FEATURES, feature } from "./feature-verification-registry.mjs";
import { command } from "./media-smoke.mjs";
import { childEnvironment, reportProblems } from "./postgres-integration.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export async function doctor(selected, { root = ROOT } = {}) {
	const checks = [
		{ id: "node", ok: Number(process.versions.node.split(".")[0]) >= 24 },
	];
	for (const file of Object.keys(selected.files))
		checks.push({
			id: `suite:${file}`,
			ok: existsSync(resolve(root, selected.directory, file)),
		});
	if (selected.id === "qc-resource-allocation")
		checks.push({
			id: "generated-db-client",
			ok: existsSync(resolve(root, "packages/db/generated/client/index.js")),
		});
	checks.push({
		id: "vitest",
		ok: existsSync(
			resolve(root, selected.directory, "node_modules/vitest/package.json"),
		),
	});
	try {
		const version = await command("pnpm", ["--version"], {
			cwd: root,
			env: { ...childEnvironment(process.env), COREPACK_ENABLE_NETWORK: "0" },
			timeout: 5000,
		});
		const pinned = JSON.parse(readFileSync(resolve(root, "package.json")))
			.packageManager?.split("@")[1]
			?.split("+")[0];
		checks.push({
			id: "pnpm",
			ok: Boolean(pinned) && version.trim() === pinned,
		});
	} catch {
		checks.push({ id: "pnpm", ok: false });
	}
	return { ready: checks.every((c) => c.ok), checks };
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function sourceIdentity(root) {
	const git = (...args) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
			maxBuffer: 32 * 1024 * 1024,
		});
	const hash = createHash("sha256").update(git("diff", "HEAD", "--binary"));
	for (const file of git("ls-files", "--others", "--exclude-standard", "-z")
		.split("\0")
		.filter(Boolean)
		.sort()) {
		const path = resolve(root, file);
		hash
			.update(file)
			.update("\0")
			.update(String(lstatSync(path).mode))
			.update("\0")
			.update(
				lstatSync(path).isSymbolicLink()
					? readlinkSync(path)
					: readFileSync(path),
			)
			.update("\0");
	}
	return {
		sha: git("rev-parse", "HEAD").trim(),
		dirtyDigest: hash.digest("hex"),
	};
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function runFeature(id, options = {}) {
	const selected = feature(id);
	const {
		root = ROOT,
		output,
		execute = command,
		inspect = doctor,
		sourceIdentity: identify = sourceIdentity,
		signal,
		timeoutMs = selected.timeoutMs,
	} = options;
	if (!isAbsolute(output ?? "")) throw new Error("OUTPUT_MUST_BE_ABSOLUTE");
	const canonicalOutput = join(realpathSync(dirname(output)), basename(output));
	const rel = relative(realpathSync(root), canonicalOutput);
	if (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	)
		throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > selected.timeoutMs
	)
		throw new Error("INVALID_TIMEOUT");
	try {
		mkdirSync(output, { mode: 0o700 });
	} catch {
		throw new Error("OUTPUT_EXISTS_OR_UNAVAILABLE");
	}
	const started = Date.now();
	const receipt = {
		schemaVersion: 1,
		runId: randomUUID(),
		featureId: id,
		scope: selected.scope,
		registryDigest: digest(
			readFileSync(
				new URL("./feature-verification-registry.mjs", import.meta.url),
			),
		),
		expected: selected.files,
		startedAt: new Date(started).toISOString(),
		status: "incomplete",
		reason: "NOT_FINISHED",
		cleanup: "not-started",
	};
	const save = () => {
		const temporary = join(output, "receipt.pending");
		writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, join(output, "receipt.json"));
	};
	save();
	let scratch;
	let timer;
	let timedOut = false;
	let ownedPid;
	let commandStarted = false;
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const fail = (reason) => {
		throw new Error(reason);
	};
	try {
		receipt.source = identify(root);
		receipt.doctor = await inspect(selected, { root });
		if (controller.signal.aborted) fail("CANCELLED");
		if (!receipt.doctor.ready) fail("PREREQUISITE_MISSING");
		scratch = mkdtempSync(join(output, ".scratch-"));
		const reportPath = join(scratch, "results.json");
		receipt.argv = [
			"--filter",
			selected.workspace,
			"exec",
			"vitest",
			"run",
			...Object.keys(selected.files),
			"--maxWorkers=2",
			"--allowOnly=false",
			"--reporter=json",
			`--outputFile=${reportPath}`,
		];
		receipt.timeoutMs = timeoutMs;
		save();
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		let commandFailed = false;
		commandStarted = true;
		try {
			await execute("pnpm", receipt.argv, {
				cwd: root,
				env: {
					...childEnvironment(process.env),
					COREPACK_ENABLE_NETWORK: "0",
					TMPDIR: scratch,
					TMP: scratch,
					TEMP: scratch,
				},
				timeout: timeoutMs,
				signal: controller.signal,
				onSpawn: (pid) => {
					ownedPid = pid;
				},
			});
		} catch {
			commandFailed = true;
		}
		clearTimeout(timer);
		if (timedOut) fail("TIMEOUT");
		if (controller.signal.aborted) fail("CANCELLED");
		if (!existsSync(reportPath))
			fail(commandFailed ? "COMMAND_FAILED" : "REPORT_MISSING");
		let report;
		const bytes = readFileSync(reportPath);
		receipt.reportDigest = digest(bytes);
		try {
			report = JSON.parse(bytes);
		} catch {
			fail("REPORT_INVALID");
		}
		if (
			!Array.isArray(report?.testResults) ||
			report.testResults.some((r) => !r || !Array.isArray(r.assertionResults))
		)
			fail("REPORT_INVALID");
		receipt.actual = {
			tests: report.numTotalTests,
			passed: report.numPassedTests,
			files: (report.testResults ?? []).map((r) => ({
				file: relative(resolve(root, selected.directory), String(r.name)),
				assertions: r.assertionResults?.length,
				passed: r.assertionResults?.filter((a) => a.status === "passed").length,
			})),
		};
		if (reportProblems(report, selected, root, "feature").length)
			fail("REPORT_INVALID");
		if (commandFailed) fail("COMMAND_FAILED");
		receipt.sourceAfter = identify(root);
		if (
			!same(receipt.source, receipt.sourceAfter) ||
			receipt.registryDigest !==
				digest(
					readFileSync(
						new URL("./feature-verification-registry.mjs", import.meta.url),
					),
				)
		)
			fail("SOURCE_CHANGED");
		receipt.status = "passed";
		receipt.reason = "ALL_REQUIRED_TESTS_PASSED";
	} catch (error) {
		const reasons = [
			"TIMEOUT",
			"CANCELLED",
			"PREREQUISITE_MISSING",
			"COMMAND_FAILED",
			"REPORT_MISSING",
			"REPORT_INVALID",
			"SOURCE_CHANGED",
		];
		receipt.reason = reasons.includes(error.message)
			? error.message
			: "VERIFICATION_ERROR";
		receipt.status =
			receipt.reason === "PREREQUISITE_MISSING" ? "blocked" : "failed";
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		try {
			if (scratch) rmSync(scratch, { recursive: true, force: true });
			receipt.cleanupScope =
				"Observed direct child close, original process group absent, owned scratch removed; no detached-descendant guarantee";
			let absent = !commandStarted;
			if (ownedPid) {
				try {
					process.kill(-ownedPid, 0);
				} catch (error) {
					absent = error.code === "ESRCH";
				}
			}
			receipt.cleanup = absent ? "complete" : "unconfirmed";
			if (!absent) {
				receipt.status = "failed";
				receipt.failureBeforeCleanup = receipt.reason;
				receipt.reason = "CLEANUP_UNCONFIRMED";
			}
		} catch {
			receipt.cleanup = "failed";
			receipt.status = "failed";
			receipt.reason = "CLEANUP_FAILED";
		}
		receipt.finishedAt = new Date().toISOString();
		receipt.durationMs = Date.now() - started;
		save();
	}
	return receipt;
}

export async function main(args, signal) {
	if (args.length === 1 && args[0] === "list") return { features: FEATURES };
	if (args.length === 2 && args[0] === "doctor") {
		const selected = feature(args[1]);
		const result = await doctor(selected);
		return { featureId: selected.id, ...result };
	}
	if (args.length === 4 && args[0] === "run" && args[2] === "--output")
		return runFeature(args[1], { output: args[3], signal });
	throw new Error(
		"USAGE: feature-verification.mjs list | doctor <id> | run <id> --output <new-absolute-directory-outside-repo>",
	);
}
if (
	process.argv[1] &&
	pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
	const controller = new AbortController();
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => controller.abort());
	main(process.argv.slice(2), controller.signal)
		.then((result) => {
			console.log(JSON.stringify(result));
			if (
				result.ready === false ||
				(result.status && result.status !== "passed")
			)
				process.exitCode = 1;
		})
		.catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		});
}
