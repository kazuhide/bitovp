import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
type ResolvedTask = {
	taskId: string;
	command: string;
	outputs: string[] | null;
	dependencies: string[];
	resolvedTaskDefinition: { dependsOn: string[]; outputs: string[] };
};

// Ask Turbo to resolve inheritance; never execute build/Prisma generation.
const graph = JSON.parse(
	execFileSync(
		resolve(root, "node_modules/.bin/turbo"),
		[
			"run",
			"build",
			"--filter=@bitovp/worker",
			"--filter=@bitovp/web",
			"--dry=json",
		],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				CI: "1",
				TURBO_TELEMETRY_DISABLED: "1",
			},
		},
	),
) as { tasks: ResolvedTask[] };
const task = (name: string) => {
	const found = graph.tasks.find((entry) => entry.taskId === name);
	if (!found) throw new Error(`Missing resolved task: ${name}`);
	return found;
};

describe("worker no-emit build contract", () => {
	it("declares no filesystem artifacts for the existing type-only build", () => {
		const worker = task("@bitovp/worker#build");
		expect(worker.command).toBe("tsc --noEmit");
		// Turbo serializes the flattened empty output list as null.
		expect(worker.outputs).toBeNull();
		expect(worker.resolvedTaskDefinition.outputs).toEqual([]);
	});

	it("retains upstream builds, including Prisma generation", () => {
		const worker = task("@bitovp/worker#build");
		expect(worker.resolvedTaskDefinition.dependsOn).toEqual(["^build"]);
		expect(worker.dependencies).toEqual([
			"@bitovp/core#build",
			"@bitovp/db#build",
			"@bitovp/storage#build",
		]);
		expect(task("@bitovp/db#build").command).toBe("prisma generate");
	});

	it("does not remove web build artifacts from the cache contract", () => {
		expect(task("@bitovp/web#build").resolvedTaskDefinition.outputs).toEqual([
			"!.next/cache/**",
			".next/**",
			"dist/**",
		]);
	});
});
