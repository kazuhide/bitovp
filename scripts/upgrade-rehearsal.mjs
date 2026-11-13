import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { failureReport, runFixture } from "./postgres-integration.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const outside = (root, path) => {
	const value = relative(root, path);
	return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
};

export function upgradeOptions(args, root = ROOT) {
	let outputDirectory;
	let baseRef;
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		const value = args[++index];
		assert(value, "Missing upgrade rehearsal option value");
		if (option === "--output-directory" && !outputDirectory) outputDirectory = value;
		else if (option === "--base-ref" && !baseRef) baseRef = value;
		else throw new Error("Unknown or repeated upgrade rehearsal option");
	}
	assert(outputDirectory && isAbsolute(outputDirectory) && outside(root, resolve(outputDirectory)), "Use a new absolute output directory outside the source checkout");
	return { baseRef: baseRef ?? "v1.2.1", outputDirectory: resolve(outputDirectory) };
}

async function main() {
	const { baseRef, outputDirectory } = upgradeOptions(process.argv.slice(2));
	assert(!existsSync(outputDirectory), "Upgrade rehearsal output already exists");
	assert(outside(realpathSync(ROOT), join(realpathSync(dirname(outputDirectory)), basename(outputDirectory))), "Output parent must remain outside the source checkout");
	mkdirSync(outputDirectory, { mode: 0o700 });
	assert(outside(realpathSync(ROOT), realpathSync(outputDirectory)), "Output must remain outside the source checkout");
	const reportPath = join(outputDirectory, "upgrade-report.json");
	const statePath = join(outputDirectory, "postgres-state.json");
	await runFixture({ root: ROOT, statePath,
		run: async ({ root, directory, env }, execute) => {
			const output = await execute("pnpm", ["--filter", "@bitovp/db", "exec", "tsx", "scripts/upgrade-rehearsal-fixture.ts", "--directory", directory, "--base-ref", baseRef], { cwd: root, env, timeout: 300_000 });
			const report = JSON.parse(output.slice(output.lastIndexOf("BITOVP_UPGRADE_REPORT=") + "BITOVP_UPGRADE_REPORT=".length));
			assert.equal(report.status, "passed");
			writeFileSync(reportPath, `${JSON.stringify({ ...report, status: "pending-cleanup", cleanup: "pending" }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		},
	});
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	writeFileSync(reportPath, `${JSON.stringify({ ...report, status: "passed", cleanup: "passed" }, null, 2)}\n`, { mode: 0o600 });
	console.log(`Upgrade and rollback rehearsal passed; ${reportPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch((error) => {
		for (const line of failureReport(error)) console.error(line);
		process.exitCode = 1;
	});
