import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
	ADVISORY,
	AUDIT_COMMAND,
	evaluateAudit,
	inspectInstallation,
	runDependencyAudit,
	validateLock,
} from "./dependency-audit.mjs";
import {
	EXPECTED_PICOMATCH_FILES,
	PICOMATCH_INTEGRITY,
	PICOMATCH_PATCH_SHA256,
	PICOMATCH_VERSION,
} from "./picomatch-security-contract.mjs";
import { COMMANDS } from "./release-gates.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const patchName = "patches/picomatch@4.0.7.patch";
const patch = readFileSync(join(repository, patchName));
const version = `${PICOMATCH_VERSION}(patch_hash=${PICOMATCH_PATCH_SHA256})`;
const locator = `picomatch@${PICOMATCH_VERSION}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const store = join(repository, "node_modules/.pnpm");
const candidates = readdirSync(store).filter((name) =>
	name.startsWith(`picomatch@${PICOMATCH_VERSION}_patch_hash=`),
);
assert.equal(
	candidates.length,
	1,
	"Install the single patched picomatch first",
);
const sourcePackage = join(store, candidates[0], "node_modules/picomatch");

function write(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, value, { mode: 0o600 });
}

function copyPackage(target) {
	for (const name of ["LICENSE", "README.md"]) {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		copyFileSync(join(sourcePackage, name), join(target, name));
	}
	for (const [name, digest] of Object.entries(EXPECTED_PICOMATCH_FILES)) {
		const source = join(sourcePackage, name);
		assert.equal(hash(readFileSync(source)), digest, `Fixture source: ${name}`);
		mkdirSync(dirname(join(target, name)), { recursive: true, mode: 0o700 });
		copyFileSync(source, join(target, name));
	}
}

function fixture(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "bitovp-audit-test-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const root = join(base, "checkout");
	const output = join(base, "receipt");
	const picomatch = join(
		root,
		`node_modules/.pnpm/picomatch@${PICOMATCH_VERSION}_patch_hash=${PICOMATCH_PATCH_SHA256}/node_modules/picomatch`,
	);
	const consumer = join(
		root,
		"node_modules/.pnpm/fixture-consumer@1.0.0/node_modules/fixture-consumer",
	);
	const resolution = join(dirname(consumer), "picomatch");
	const lock = {
		lockfileVersion: "9.0",
		patchedDependencies: { [locator]: PICOMATCH_PATCH_SHA256 },
		importers: {
			".": {
				devDependencies: {
					"fixture-consumer": { specifier: "1.0.0", version: "1.0.0" },
				},
			},
		},
		packages: {
			[locator]: { resolution: { integrity: PICOMATCH_INTEGRITY } },
			"fixture-consumer@1.0.0": { resolution: { integrity: "fixture-only" } },
		},
		snapshots: {
			[`picomatch@${version}`]: {},
			"fixture-consumer@1.0.0": { dependencies: { picomatch: version } },
		},
	};
	const workspace = { patchedDependencies: { [locator]: patchName } };
	const modules = {
		nodeLinker: "isolated",
		layoutVersion: 5,
		virtualStoreDir: ".pnpm",
		packageManager: "pnpm@11.28.8",
		included: {
			dependencies: true,
			devDependencies: true,
			optionalDependencies: true,
		},
	};
	const saveLock = () => {
		const bytes = stringify(lock);
		write(join(root, "pnpm-lock.yaml"), bytes);
		write(join(root, "node_modules/.pnpm/lock.yaml"), bytes);
	};
	write(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture-root", private: true }),
	);
	write(
		join(consumer, "package.json"),
		JSON.stringify({
			name: "fixture-consumer",
			version: "1.0.0",
			dependencies: { picomatch: "^4.0.7" },
		}),
	);
	copyPackage(picomatch);
	symlinkSync(picomatch, resolution, "dir");
	symlinkSync(consumer, join(root, "node_modules/fixture-consumer"), "dir");
	write(join(root, patchName), patch);
	write(join(root, "pnpm-workspace.yaml"), stringify(workspace));
	write(join(root, "node_modules/.modules.yaml"), stringify(modules));
	saveLock();
	return {
		base,
		root,
		output,
		picomatch,
		consumer,
		resolution,
		lock,
		workspace,
		modules,
		saveLock,
	};
}

function audit(finding = true) {
	return {
		advisories: finding
			? {
					112233: {
						id: 112233,
						github_advisory_id: ADVISORY,
						module_name: "picomatch",
						url: `https://github.com/advisories/${ADVISORY}`,
						severity: "high",
						vulnerable_versions: "<=4.0.7",
						patched_versions: null,
						patched_versions_unpublished: true,
						findings: [
							{
								version: "4.0.7",
								dev: true,
								optional: false,
								bundled: false,
								paths: ["fixture-root>fixture-consumer>picomatch"],
							},
						],
					},
				}
			: {},
		metadata: {
			vulnerabilities: {
				info: 0,
				low: 0,
				moderate: 0,
				high: finding ? 1 : 0,
				critical: 0,
			},
		},
	};
}

function childResult(document = audit(), overrides = {}) {
	return {
		stdout: JSON.stringify(document),
		stderr: "audit fixture stderr\n",
		status: Object.keys(document.advisories ?? {}).length ? 1 : 0,
		signal: null,
		...overrides,
	};
}

function execute(result) {
	return (command, args, options) => {
		assert.equal(command, "pnpm");
		assert.deepEqual(args, ["audit", "--audit-level", "low", "--json"]);
		assert.equal(options.timeout, 60_000);
		assert.equal(options.killSignal, "SIGKILL");
		return result;
	};
}

async function rejectsWithReceipt(f, result, expected) {
	await assert.rejects(runDependencyAudit(f, execute(result)), expected);
	assert.equal(
		readFileSync(join(f.output, "audit.stdout.json"), "utf8"),
		result.stdout,
	);
	assert.equal(
		readFileSync(join(f.output, "audit.stderr.txt"), "utf8"),
		result.stderr,
	);
	assert.deepEqual(
		JSON.parse(readFileSync(join(f.output, "audit-exit.json"), "utf8")),
		{
			status: result.status,
			signal: result.signal,
			...(result.error?.code ? { error: result.error.code } : {}),
		},
	);
	assert.equal(existsSync(join(f.output, "verified.json")), false);
}

for (const finding of [true, false]) {
	test(`verifies real fixed package bytes and runtime contract with ${finding ? "the exact advisory" : "no findings"}`, async (t) => {
		const f = fixture(t);
		assert.deepEqual(
			[...validateLock(f.lock, f.workspace, patch)],
			["fixture-consumer@1.0.0"],
		);
		assert.equal(
			realpathSync(
				createRequire(join(f.consumer, "package.json")).resolve("picomatch"),
			),
			join(f.picomatch, "index.js"),
		);
		const installation = inspectInstallation(f.root);
		assert.deepEqual(installation.roots, [f.picomatch]);
		assert.deepEqual(
			evaluateAudit(
				JSON.stringify(audit(finding)),
				finding ? 1 : 0,
				installation,
			),
			{ findings: finding ? 1 : 0, checkedPaths: finding ? 1 : 0 },
		);
		const result = await runDependencyAudit(
			f,
			execute(childResult(audit(finding))),
		);
		assert.equal(
			result.status,
			finding
				? "LOCALLY_MITIGATED_SCA_FINDING_REMAINS"
				: "NO_SCA_FINDINGS_PATCH_VERIFIED",
		);
		assert.equal(result.instances.length, 1);
		assert.deepEqual(result.instances[0].files, EXPECTED_PICOMATCH_FILES);
		assert.equal(result.instances[0].contract.rejectionChecks, 1152);
		assert.equal(result.instances[0].contract.acceptedCases, 3264);
		assert.equal(result.instances[0].contract.noextCases, 48);
		assert.equal(
			JSON.parse(readFileSync(join(f.output, "verified.json"), "utf8")).status,
			result.status,
		);
	});
}

for (const [name, mutate, expected] of [
	["missing patch", (f) => rmSync(join(f.root, patchName)), /ENOENT/],
	[
		"modified patch",
		(f) =>
			write(join(f.root, patchName), Buffer.concat([patch, Buffer.from("\n")])),
		/Patch bytes changed/,
	],
	[
		"modified runtime even when audit is clean",
		(f) =>
			write(
				join(f.picomatch, "lib/parse.js"),
				"throw new Error('must not execute tampered code');",
			),
		/Unexpected picomatch runtime bytes/,
	],
	[
		"wrong installed version",
		(f) => {
			const path = join(f.picomatch, "package.json");
			const pkg = JSON.parse(readFileSync(path));
			pkg.version = "4.0.6";
			write(path, JSON.stringify(pkg));
		},
		/Unexpected installed picomatch/,
	],
	[
		"additional unverified instance",
		(f) => {
			const extra = join(
				f.root,
				"node_modules/.pnpm/extra/node_modules/picomatch",
			);
			copyPackage(extra);
			write(join(extra, "lib/parse.js"), "module.exports = () => ({});");
		},
		/Unexpected picomatch runtime bytes/,
	],
	[
		"external package resolution",
		(f) => {
			const external = join(f.base, "external-picomatch");
			copyPackage(external);
			rmSync(f.resolution);
			symlinkSync(external, f.resolution, "dir");
		},
		/escapes the checkout/,
	],
	[
		"missing dependency resolution",
		(f) => rmSync(f.resolution),
		/Missing dependency resolution: picomatch/,
	],
	[
		"different installed lock",
		(f) =>
			write(
				join(f.root, "node_modules/.pnpm/lock.yaml"),
				"lockfileVersion: '9.0'\n",
			),
		/Installed lock differs/,
	],
	[
		"unpatched lock edge",
		(f) => {
			f.lock.snapshots["fixture-consumer@1.0.0"].dependencies.picomatch =
				"4.0.7";
			f.saveLock();
		},
		/Unpatched lock edge/,
	],
	[
		"additional locked version",
		(f) => {
			f.lock.packages["picomatch@3.0.0"] = {};
			f.saveLock();
		},
		/Unexpected picomatch version/,
	],
	[
		"wrong tarball integrity",
		(f) => {
			f.lock.packages[locator].resolution.integrity = "sha512-wrong";
			f.saveLock();
		},
		/sha512/,
	],
	[
		"missing locked consumer",
		(f) => {
			f.lock.snapshots["missing-consumer@1.0.0"] = {
				dependencies: { picomatch: version },
			};
			f.saveLock();
		},
		/Missing locked consumer/,
	],
	[
		"incomplete installation",
		(f) => {
			f.modules.included.devDependencies = false;
			write(join(f.root, "node_modules/.modules.yaml"), stringify(f.modules));
		},
		/false.*true|true.*false/s,
	],
	[
		"workspace advisory suppression",
		(f) => {
			f.workspace.auditConfig = { ignoreGhsas: [ADVISORY] };
			write(join(f.root, "pnpm-workspace.yaml"), stringify(f.workspace));
		},
		/Audit suppressions/,
	],
]) {
	test(`fails closed for ${name} and preserves raw audit evidence`, async (t) => {
		const f = fixture(t);
		mutate(f);
		await rejectsWithReceipt(f, childResult(audit(false)), expected);
	});
}

for (const name of [
	"lib/parse",
	"lib/picomatch",
	"lib/extra.js",
	"lib/extra-directory",
]) {
	test(`rejects unexpected package path ${name} before executing shadow code`, async (t) => {
		const f = fixture(t);
		const marker = join(f.base, "unverified-code-executed");
		if (name.endsWith("directory")) mkdirSync(join(f.picomatch, name));
		else
			write(
				join(f.picomatch, name),
				`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); module.exports = require(${JSON.stringify(`./${name.split("/").at(-1)}.js`)});`,
			);
		try {
			await rejectsWithReceipt(
				f,
				childResult(audit(false)),
				/inventory|Unexpected|package files/i,
			);
		} finally {
			assert.equal(
				existsSync(marker),
				false,
				"Unverified shadow module executed before rejection",
			);
		}
	});
}

test("checks peer-only consumers and rejects their missing actual resolution", async (t) => {
	const f = fixture(t);
	write(
		join(f.consumer, "package.json"),
		JSON.stringify({
			name: "fixture-consumer",
			version: "1.0.0",
			peerDependencies: { picomatch: "^4.0.7" },
		}),
	);
	assert.deepEqual(inspectInstallation(f.root).roots, [f.picomatch]);
	rmSync(f.resolution);
	await rejectsWithReceipt(
		f,
		childResult(audit(false)),
		/Missing dependency resolution: picomatch/,
	);
});

test("rejects actual pristine npm parse.js reconstructed from the reviewed patch", async (t) => {
	const f = fixture(t);
	const reversed = spawnSync(
		"git",
		["apply", "--reverse", "--no-index", join(repository, patchName)],
		{ cwd: f.picomatch, encoding: "utf8", timeout: 1000 },
	);
	assert.equal(reversed.status, 0, reversed.stderr);
	assert.equal(
		hash(readFileSync(join(f.picomatch, "lib/parse.js"))),
		"4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4",
	);
	await rejectsWithReceipt(
		f,
		childResult(audit(false)),
		/Unexpected picomatch runtime bytes/,
	);
});

for (const [name, mutate, expected] of [
	[
		"another package advisory",
		(d) => {
			d.advisories[112233].module_name = "other-package";
			d.advisories[112233].github_advisory_id = "GHSA-aaaa-bbbb-cccc";
		},
		/Unmitigated advisory/,
	],
	[
		"a different package with the same advisory id",
		(d) => {
			d.advisories[112233].module_name = "other-package";
		},
		/picomatch/,
	],
	[
		"another advisory for picomatch",
		(d) => {
			d.advisories[112233].github_advisory_id = "GHSA-aaaa-bbbb-cccc";
		},
		/Unmitigated advisory/,
	],
	[
		"wrong finding version",
		(d) => {
			d.advisories[112233].findings[0].version = "4.0.6";
		},
		/4\.0\.7/,
	],
	[
		"runtime finding",
		(d) => {
			d.advisories[112233].findings[0].dev = false;
		},
		/runtime reachability/,
	],
	[
		"missing finding resolution",
		(d) => {
			d.advisories[112233].findings[0].paths = [
				"fixture-root>missing-package>picomatch",
			];
		},
		/Missing dependency resolution/,
	],
	[
		"unknown audit schema",
		(d) => {
			d.error = "registry error";
		},
		/Unknown audit schema/,
	],
	[
		"contradictory summary",
		(d) => {
			d.metadata.vulnerabilities.high = 0;
		},
		/contradictory advisory summary/,
	],
	[
		"duplicate finding paths",
		(d) => {
			d.advisories[112233].findings[0].paths.push(
				"fixture-root>fixture-consumer>picomatch",
			);
		},
		/Duplicate audit path/,
	],
]) {
	test(`rejects ${name} without manufacturing a clean receipt`, async (t) => {
		const f = fixture(t);
		const d = audit();
		mutate(d);
		await rejectsWithReceipt(f, childResult(d), expected);
	});
}

for (const [name, result, expected] of [
	[
		"raw transport error",
		childResult(audit(), {
			stdout: "registry unavailable",
			status: 1,
			error: { code: "ECONNRESET" },
		}),
		/did not complete/,
	],
	[
		"non-JSON response",
		childResult(audit(), { stdout: "<html>bad gateway</html>" }),
		/JSON|Unexpected token/,
	],
	[
		"JSON transport error",
		childResult(audit(), {
			stdout: JSON.stringify({
				error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" },
			}),
		}),
		/assert|falsy/i,
	],
	[
		"timeout with signal",
		childResult(audit(), {
			status: null,
			signal: "SIGKILL",
			error: { code: "ETIMEDOUT" },
		}),
		/did not complete/,
	],
	[
		"signal without transport error",
		childResult(audit(), { status: 1, signal: "SIGTERM" }),
		/did not complete/,
	],
	[
		"nonzero unexpected exit",
		childResult(audit(), { status: 2 }),
		/Native dependency audit failed/,
	],
	[
		"nonzero clean response",
		childResult(audit(false), { status: 1 }),
		/Audit execution failed/,
	],
	[
		"zero exit with advisory",
		childResult(audit(), { status: 0 }),
		/Audit execution failed/,
	],
]) {
	test(`retains stdout, stderr and exit on ${name}`, async (t) => {
		await rejectsWithReceipt(fixture(t), result, expected);
	});
}

for (const [script, args, error] of [
	["dependency-audit.mjs", ["--invalid"], /Dependency audit failed/],
	[
		"picomatch-security-contract.mjs",
		[],
		/No installed picomatch roots supplied/,
	],
]) {
	test(`${script} validates arguments through file and directory symlinks`, (t) => {
		const f = fixture(t);
		const actual = join(repository, "scripts", script);
		const fileLink = join(f.base, "linked-script.mjs");
		const directoryLink = join(f.base, "linked-scripts");
		symlinkSync(actual, fileLink);
		symlinkSync(join(repository, "scripts"), directoryLink, "dir");
		for (const entry of [actual, fileLink, join(directoryLink, script)]) {
			const child = spawnSync(process.execPath, [entry, ...args], {
				cwd: f.root,
				encoding: "utf8",
				timeout: 3000,
				env: { LANG: "C", NO_COLOR: "1" },
			});
			assert.equal(child.status, 1, `${entry}: ${child.stderr}`);
			assert.match(child.stderr, error);
			assert.equal(child.stdout, "");
		}
	});
}

test("keeps the low-severity native audit command in every audited entrypoint", () => {
	assert.deepEqual(AUDIT_COMMAND, ["audit", "--audit-level", "low", "--json"]);
	assert(
		COMMANDS.some(
			(command) =>
				JSON.stringify(command) ===
				JSON.stringify(["node", "scripts/dependency-audit.mjs"]),
		),
	);
	for (const name of ["ci.yml", "security-audit.yml"]) {
		const workflow = parse(
			readFileSync(join(repository, ".github/workflows", name), "utf8"),
		);
		const steps = Object.values(workflow.jobs).flatMap(
			(job) => job.steps ?? [],
		);
		assert(
			steps.some(
				(step) =>
					step.run ===
					'node scripts/dependency-audit.mjs --output "$RUNNER_TEMP/dependency-audit"',
			),
		);
		assert(steps.some((step) => step.run === "pnpm audit signatures"));
		assert(
			!steps.some((step) => /pnpm audit --audit-level/.test(step.run ?? "")),
		);
		assert(
			steps.some(
				(step) =>
					step.if === "always()" && step.with?.name === "dependency-audit",
			),
		);
	}
	const ci = parse(
		readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8"),
	);
	assert(
		ci.jobs.quality.steps.some(
			(step) => step.run === "pnpm test:release-gates",
		),
	);
	const pkg = JSON.parse(
		readFileSync(join(repository, "package.json"), "utf8"),
	);
	assert(
		pkg.scripts["test:release-gates"]
			.split(/\s+/)
			.includes("scripts/dependency-audit.test.mjs"),
	);
});
