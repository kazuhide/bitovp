import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import { NATIVE_OFFICIAL_REVISION } from "./native-contract";
import {
	createSupervisedVmafRunner,
	vmafHeartbeatDeadline,
} from "./supervised-runner";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-supervised-"));
	directories.push(dir);
	const nativePath = join(dir, "bitovp-vmaf"),
		companion = join(dir, "bitovp-vmaf-supervisor"),
		source = "a".repeat(64);
	await writeFile(nativePath, "native");
	await chmod(nativePath, 0o700);
	await writeFile(companion, "guardian");
	const run = vi.fn<ProcessRunner["run"]>(async (_bin, args) => ({
		code: 0,
		stderr: "",
		stdout:
			args[0] === "--version"
				? `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`
				: args[0] === "--identity"
					? `bitovp-vmaf-supervisor-v1-clock=boottime-source=${source}\n`
					: "output",
	}));
	return {
		nativePath,
		companion,
		run,
		deps: {
			nativePath,
			platform: "linux",
			readUptime: () => "100.25 99.10\n",
			runner: { run, spawn: vi.fn() },
		},
	};
}
it("generates bounded suspend-aware absolute records without floating point rounding", () => {
	expect(vmafHeartbeatDeadline("100.25 200.10\n")).toBe("115250000000\n");
	for (const text of [
		"NaN 0",
		"-1 0",
		"1e9 0",
		"999999999999 0",
		"1.1234567890 0",
		"1 0\nsecret",
	])
		expect(() => vmafHeartbeatDeadline(text)).toThrow();
});
it("wraps direct argv, preserves cancellation and keeps heartbeats on their private descriptor", async () => {
	const f = await fixture();
	const wrapped = await createSupervisedVmafRunner(f.deps);
	const controller = new AbortController();
	expect(
		await wrapped.runner.run(
			"ffmpeg",
			["input with spaces", "literal;argument"],
			{ signal: controller.signal },
		),
	).toMatchObject({ code: 0, stdout: "output" });
	const [bin, args, options] = f.run.mock.calls[2] ?? [];
	expect(bin).toBe(wrapped.executable);
	expect(args).toEqual([
		"--supervise",
		"--parent-pid",
		String(process.pid),
		"--heartbeat-fd",
		"3",
		"--heartbeat-timeout-ms",
		"15000",
		"--",
		"ffmpeg",
		"input with spaces",
		"literal;argument",
	]);
	expect(options?.signal).toBe(controller.signal);
	expect(options?.heartbeat?.read()).toBe("115250000000\n");
});
it("rejects a replaced companion before starting new work", async () => {
	const f = await fixture();
	const wrapped = await createSupervisedVmafRunner(f.deps);
	await writeFile(f.companion, "different guardian");
	await expect(wrapped.runner.run("ffmpeg", [])).rejects.toThrow(
		"VMAF_SUPERVISOR_BUILD_CHANGED",
	);
	expect(f.run).toHaveBeenCalledTimes(2);
});
it("rejects incompatible clocks, platforms and sources before work starts", async () => {
	const f = await fixture();
	await expect(
		createSupervisedVmafRunner({ ...f.deps, platform: "darwin" }),
	).rejects.toThrow("REQUIRES_LINUX");
	f.run.mockImplementationOnce(async () => ({
		code: 0,
		stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${"b".repeat(64)}\n`,
		stderr: "",
	}));
	await expect(createSupervisedVmafRunner(f.deps)).rejects.toThrow(
		"IDENTITY_MISMATCH",
	);
});
