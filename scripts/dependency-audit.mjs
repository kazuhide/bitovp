import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
	PICOMATCH_INTEGRITY,
	PICOMATCH_PATCH_SHA256,
	PICOMATCH_VERSION,
	verifyInstalledPicomatch,
} from "./picomatch-security-contract.mjs";

export const ADVISORY = "GHSA-fc5q-39xc-vjpf";
export const AUDIT_COMMAND = ["audit", "--audit-level", "low", "--json"];
const locator = `picomatch@${PICOMATCH_VERSION}`;
const patchedVersion = `${PICOMATCH_VERSION}(patch_hash=${PICOMATCH_PATCH_SHA256})`;
const patchPath = "patches/picomatch@4.0.7.patch";
const dependencyGroups = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];
const severities = ["info", "low", "moderate", "high", "critical"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const yaml = (text) => parse(text, { uniqueKeys: true, maxAliasCount: 0 });
const jsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

function inside(root, path) {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function installedPath(root, path) {
	const actual = realpathSync(path);
	assert(inside(root, actual), "Installed dependency escapes the checkout");
	return actual;
}

export function validateLock(lock, workspace, patch) {
	assert.equal(lock.lockfileVersion, "9.0", "Unknown lockfile schema");
	assert(
		record(lock.packages) && record(lock.snapshots) && record(lock.importers),
	);
	assert.equal(workspace.patchedDependencies?.[locator], patchPath);
	assert.equal(
		workspace.auditConfig,
		undefined,
		"Audit suppressions are unsupported",
	);
	assert.equal(sha256(patch), PICOMATCH_PATCH_SHA256, "Patch bytes changed");
	assert.equal(lock.patchedDependencies?.[locator], PICOMATCH_PATCH_SHA256);
	assert.deepEqual(
		Object.keys(lock.packages).filter((name) => name.startsWith("picomatch@")),
		[locator],
		"Unexpected picomatch version",
	);
	assert.equal(
		lock.packages[locator].resolution?.integrity,
		PICOMATCH_INTEGRITY,
	);
	assert.deepEqual(
		Object.keys(lock.snapshots).filter((name) => name.startsWith("picomatch@")),
		[`picomatch@${patchedVersion}`],
		"Missing patched lock snapshot",
	);
	const consumers = new Set();
	for (const [name, snapshot] of Object.entries(lock.snapshots)) {
		for (const group of dependencyGroups) {
			for (const [dependency, version] of Object.entries(
				snapshot[group] ?? {},
			)) {
				if (dependency === "picomatch") {
					assert.equal(version, patchedVersion, "Unpatched lock edge");
					consumers.add(name.split("(")[0]);
				} else {
					assert(
						!String(version).startsWith("picomatch@"),
						"Unsupported alias",
					);
				}
			}
		}
	}
	for (const importer of Object.values(lock.importers)) {
		for (const group of dependencyGroups) {
			for (const [dependency, spec] of Object.entries(importer[group] ?? {})) {
				if (dependency === "picomatch")
					assert.equal(spec.version, patchedVersion);
				else
					assert(
						!String(spec.version).startsWith("picomatch@"),
						"Unsupported alias",
					);
			}
		}
	}
	assert(consumers.size > 0, "No locked picomatch consumers");
	return consumers;
}

// Node's package lookup, without executing code or relying on package exports.
function resolvePackage(root, parent, name) {
	assert.match(name, /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/);
	let current = parent;
	while (inside(root, current)) {
		const candidate = join(current, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) {
			const actual = installedPath(root, candidate);
			assert.equal(jsonFile(join(actual, "package.json")).name, name);
			return actual;
		}
		if (current === root) break;
		current = dirname(current);
	}
	throw new Error(`Missing dependency resolution: ${name}`);
}

export function inspectInstallation(root) {
	root = realpathSync(root);
	const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
	assert.deepEqual(
		readFileSync(join(root, "node_modules/.pnpm/lock.yaml")),
		lockBytes,
		"Installed lock differs; perform a complete frozen install",
	);
	const lock = yaml(lockBytes.toString());
	const workspace = yaml(
		readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
	);
	const expectedConsumers = validateLock(
		lock,
		workspace,
		readFileSync(join(root, patchPath)),
	);
	const modules = yaml(
		readFileSync(join(root, "node_modules/.modules.yaml"), "utf8"),
	);
	assert.equal(modules.nodeLinker, "isolated");
	assert.equal(modules.layoutVersion, 5);
	assert.equal(modules.virtualStoreDir, ".pnpm");
	assert.equal(modules.packageManager, "pnpm@11.28.8");
	for (const group of dependencyGroups)
		assert.equal(modules.included?.[group], true);
	const packages = new Map();
	const moduleDirs = new Set();
	const scan = (path) => {
		if (!existsSync(path)) return;
		const actual = installedPath(root, path);
		if (moduleDirs.has(actual)) return;
		moduleDirs.add(actual);
		for (const entry of readdirSync(actual, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const paths = entry.name.startsWith("@")
				? readdirSync(join(actual, entry.name)).map((name) =>
						join(actual, entry.name, name),
					)
				: [join(actual, entry.name)];
			for (const path of paths) {
				const packageRoot = installedPath(root, path);
				if (packages.has(packageRoot)) continue;
				const pkg = jsonFile(join(packageRoot, "package.json"));
				assert(typeof pkg.name === "string" && typeof pkg.version === "string");
				packages.set(packageRoot, pkg);
				scan(join(packageRoot, "node_modules"));
			}
		}
	};
	const importers = new Map();
	for (const key of Object.keys(lock.importers)) {
		const path = resolve(root, key);
		assert(inside(root, path), "Importer escapes checkout");
		assert(existsSync(join(path, "package.json")));
		importers.set(key.replaceAll("/", "__"), path);
		assert(existsSync(join(path, "node_modules")), "Missing workspace install");
		scan(join(path, "node_modules"));
	}
	importers.set(jsonFile(join(root, "package.json")).name, root);
	const store = join(root, "node_modules/.pnpm");
	for (const entry of readdirSync(store, { withFileTypes: true })) {
		if (entry.name === "node_modules") scan(join(store, entry.name));
		else if (entry.isDirectory()) scan(join(store, entry.name, "node_modules"));
	}
	const roots = new Set();
	const actualConsumers = new Set();
	for (const [path, pkg] of packages) {
		if (pkg.name === "picomatch") {
			assert.equal(
				pkg.version,
				PICOMATCH_VERSION,
				"Unexpected installed picomatch",
			);
			roots.add(path);
		}
	}
	assert(roots.size > 0, "No installed picomatch");
	for (const [path, pkg] of packages) {
		if (
			["dependencies", "optionalDependencies", "peerDependencies"].some(
				(group) => pkg[group]?.picomatch,
			)
		) {
			assert(
				roots.has(resolvePackage(root, path, "picomatch")),
				"Unverified resolution",
			);
			actualConsumers.add(`${pkg.name}@${pkg.version}`);
		}
	}
	for (const consumer of expectedConsumers) {
		assert(
			actualConsumers.has(consumer),
			`Missing locked consumer ${consumer}`,
		);
	}
	return {
		root,
		roots: [...roots].sort(),
		importers,
		lockSha256: sha256(lockBytes),
	};
}

export function evaluateAudit(raw, exitCode, installation) {
	const audit = JSON.parse(raw);
	assert(record(audit) && record(audit.advisories) && record(audit.metadata));
	assert.deepEqual(
		Object.keys(audit).sort(),
		["advisories", "metadata"],
		"Unknown audit schema",
	);
	const counts = audit.metadata.vulnerabilities;
	assert(record(counts));
	assert.deepEqual(Object.keys(counts).sort(), [...severities].sort());
	for (const severity of severities)
		assert(Number.isSafeInteger(counts[severity]) && counts[severity] >= 0);
	const entries = Object.entries(audit.advisories);
	const actualCounts = Object.fromEntries(
		severities.map((severity) => [severity, 0]),
	);
	const checkedPaths = new Set();
	for (const [id, advisory] of entries) {
		assert(record(advisory) && String(advisory.id) === id);
		assert.equal(advisory.github_advisory_id, ADVISORY, "Unmitigated advisory");
		assert.equal(advisory.module_name, "picomatch");
		assert.equal(advisory.url, `https://github.com/advisories/${ADVISORY}`);
		assert.equal(advisory.severity, "high");
		assert.equal(advisory.vulnerable_versions, "<=4.0.7");
		assert.equal(
			advisory.patched_versions,
			null,
			"Reassess upstream remediation",
		);
		assert.equal(advisory.patched_versions_unpublished, true);
		assert(Array.isArray(advisory.findings) && advisory.findings.length > 0);
		actualCounts.high++;
		for (const finding of advisory.findings) {
			assert.equal(finding.version, PICOMATCH_VERSION);
			assert.equal(finding.dev, true, "Review changed runtime reachability");
			assert.equal(finding.optional, false);
			assert.equal(finding.bundled, false);
			assert(Array.isArray(finding.paths) && finding.paths.length > 0);
			for (const path of finding.paths) {
				assert(typeof path === "string" && path.length <= 8192);
				assert(!checkedPaths.has(path), "Duplicate audit path");
				checkedPaths.add(path);
				const [importer, ...names] = path.split(">");
				let resolved = installation.importers.get(importer);
				assert(resolved && names.length > 0 && names.at(-1) === "picomatch");
				for (const name of names)
					resolved = resolvePackage(installation.root, resolved, name);
				assert(
					installation.roots.includes(resolved),
					"Audit path resolves to unverified package",
				);
			}
		}
	}
	assert(entries.length <= 1, "Unexpected additional findings");
	assert.deepEqual(
		counts,
		actualCounts,
		"Incomplete or contradictory advisory summary",
	);
	assert.equal(
		exitCode,
		entries.length === 0 ? 0 : 1,
		"Audit execution failed",
	);
	return { findings: entries.length, checkedPaths: checkedPaths.size };
}

export async function runDependencyAudit(
	{ root, output },
	execute = spawnSync,
) {
	root = realpathSync(root);
	output ??= mkdtempSync(join(tmpdir(), "bitovp-dependency-audit-"));
	assert(isAbsolute(output));
	if (!existsSync(output)) mkdirSync(output, { recursive: true, mode: 0o700 });
	assert(
		lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink(),
	);
	const save = (name, value) =>
		writeFileSync(join(output, name), value, { flag: "wx", mode: 0o600 });
	const child = execute("pnpm", AUDIT_COMMAND, {
		cwd: root,
		encoding: "utf8",
		timeout: 60_000,
		killSignal: "SIGKILL",
		maxBuffer: 8 * 1024 * 1024,
		env: Object.fromEntries(
			["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "COREPACK_HOME", "PNPM_HOME"]
				.filter((key) => process.env[key] !== undefined)
				.map((key) => [key, process.env[key]]),
		),
	});
	save("audit.stdout.json", child.stdout ?? "");
	save("audit.stderr.txt", child.stderr ?? "");
	save(
		"audit-exit.json",
		JSON.stringify({
			status: child.status,
			signal: child.signal,
			error: child.error?.code,
		}),
	);
	assert(
		!child.error && !child.signal,
		"Native dependency audit did not complete",
	);
	assert(
		child.status === 0 || child.status === 1,
		"Native dependency audit failed",
	);
	const installation = inspectInstallation(root);
	const audit = evaluateAudit(child.stdout, child.status, installation);
	const instances = await verifyInstalledPicomatch(installation.roots);
	assert.equal(instances.length, installation.roots.length);
	const report = {
		status: audit.findings
			? "LOCALLY_MITIGATED_SCA_FINDING_REMAINS"
			: "NO_SCA_FINDINGS_PATCH_VERIFIED",
		advisory: ADVISORY,
		...audit,
		lockSha256: installation.lockSha256,
		patchSha256: PICOMATCH_PATCH_SHA256,
		instances,
		scope:
			"Repeated extglobs are rejected at string-glob compilation. Raw RegExp and precompiled-state APIs are trusted boundaries; this is not a general ReDoS or full-compatibility claim.",
	};
	save("verified.json", `${JSON.stringify(report, null, 2)}\n`);
	return { ...report, output };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = process.argv.slice(2);
		assert(args.length === 0 || (args.length === 2 && args[0] === "--output"));
		const report = await runDependencyAudit({
			root: process.cwd(),
			output: args[1],
		});
		console.log(JSON.stringify(report, null, 2));
	} catch (error) {
		console.error(`Dependency audit failed: ${error.message}`);
		process.exitCode = 1;
	}
}
