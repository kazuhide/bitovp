import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isEntryPoint } from "./gate-report.mjs";

const root = resolve(import.meta.dirname, "..");

export function workflowFiles(checkout) {
	const directory = join(checkout, ".github/workflows");
	const files = readdirSync(directory)
		.filter((name) => /\.ya?ml$/.test(name))
		.sort()
		.map((name) => join(directory, name));
	if (!files.length) throw new Error("NO_WORKFLOWS");
	if (files.some((file) => !lstatSync(file).isFile()))
		throw new Error("WORKFLOW_MUST_BE_A_REGULAR_FILE");
	return files;
}

export function lintWorkflows(checkout = root, execute = spawnSync) {
	const files = workflowFiles(checkout);
	const result = execute(
		"actionlint",
		["-shellcheck=", "-pyflakes=", ...files],
		{
			cwd: checkout,
			stdio: "inherit",
			timeout: 30_000,
		},
	);
	if (result.error || result.signal || result.status !== 0)
		throw new Error("WORKFLOW_LINT_FAILED: actionlint 1.7.12 is required");
	return files.length;
}

if (isEntryPoint(import.meta.url)) {
	try {
		if (process.argv.length !== 2) throw new Error("UNEXPECTED_ARGUMENTS");
		console.log(`Validated ${lintWorkflows()} workflow files.`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
