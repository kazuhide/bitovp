#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
const inputIndex = args.indexOf("-i");
const source = args[inputIndex + 1];
if (inputIndex < 0 || !source || !isAbsolute(source)) {
	throw new Error("The normalization fixture requires an absolute input path");
}

const directory = dirname(source);
appendFileSync(join(directory, "probe.jsonl"), `${JSON.stringify(args)}\n`);
const result = spawnSync("ffprobe", args, { encoding: "utf8" });
if (result.error) throw result.error;
let stdout = result.stdout;
if (
	existsSync(join(directory, "malformed-time")) &&
	args.includes("compact=p=1:nk=0")
) {
	stdout = stdout.replace(
		"best_effort_timestamp_time=0.000000",
		"best_effort_timestamp_time=0.100000",
	);
}
process.stdout.write(stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
