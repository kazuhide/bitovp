import { describe, expect, it } from "vitest";
import { MediaOperationError, runMediaProcess } from "./process";

describe("editing media process ownership", () => {
	it("passes arguments literally without a shell", async () => {
		const result = await runMediaProcess(process.execPath, [
			"-e",
			"process.stdout.write(process.argv[1])",
			"$(never-run); `still-literal`",
		]);
		expect(result.stdout).toBe("$(never-run); `still-literal`");
	});
	it("rejects a missing binary", async () => {
		await expect(
			runMediaProcess("/missing/bitovp-media-process", []),
		).rejects.toMatchObject({
			code: "PROCESS_FAILED",
		});
	});
	it("bounds child output and waits for the child to close", async () => {
		await expect(
			runMediaProcess(
				process.execPath,
				[
					"-e",
					"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)",
				],
				{
					maxOutputBytes: 100,
					killAfterMs: 20,
				},
			),
		).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
	});
	it("escalates a timed out process that ignores SIGTERM", async () => {
		await expect(
			runMediaProcess(
				process.execPath,
				["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
				{
					timeoutMs: 100,
					killAfterMs: 20,
				},
			),
		).rejects.toMatchObject({ code: "TIMED_OUT" });
	});
	it("does not start an already canceled operation", async () => {
		const signal = AbortSignal.abort();
		await expect(
			runMediaProcess(process.execPath, ["-e", "process.exit(99)"], { signal }),
		).rejects.toBeInstanceOf(MediaOperationError);
		await expect(
			runMediaProcess(process.execPath, [], { signal }),
		).rejects.toMatchObject({ code: "CANCELED" });
	});
	it("retains the hard-kill grace after a parent exits while a child holds its pipes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-process-group-"));
		const ready = join(dir, "ready");
		const childCode = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},String(process.ppid));setInterval(()=>{},1000)`;
		const controller = new AbortController();
		const pending = runMediaProcess(
			process.execPath,
			[
				"-e",
				`process.on('SIGTERM',()=>process.exit(0));require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
			],
			{ signal: controller.signal, killAfterMs: 20, timeoutMs: 3000 },
		);
		let groupId = 0;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		let fallbackUsed = false;
		const cleanup = () => {
			if (groupId) {
				try {
					process.kill(-groupId, "SIGKILL");
				} catch {}
			}
		};
		try {
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					groupId = Number(await readFile(ready, "utf8"));
					break;
				} catch {
					await delay(10);
				}
			}
			expect(groupId).toBeGreaterThan(0);
			watchdog = setTimeout(() => {
				fallbackUsed = true;
				cleanup();
			}, 500);
			controller.abort();
			await expect(pending).rejects.toMatchObject({ code: "CANCELED" });
			expect(fallbackUsed).toBe(false);
		} finally {
			if (watchdog) clearTimeout(watchdog);
			cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
