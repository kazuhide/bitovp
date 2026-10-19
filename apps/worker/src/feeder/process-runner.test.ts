import { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createResourceAdmission } from "../vmaf/resource-admission";
import { createNodeProcessRunner } from "./process-runner";

/**
 * Real-process checks ensure abort stops owned work promptly while retaining
 * admission until the child and its output streams physically close.
 */
describe("createNodeProcessRunner().run", () => {
	it.each([
		"ignored SIGTERM",
		"failed SIGTERM",
	])("closes an opted-in child before releasing admission (%s)", async (failure) => {
		const directory = await mkdtemp(join(tmpdir(), "process-runner-kill-"));
		const aborter = new AbortController();
		let pid: number | undefined;
		let closed = false;
		let restoreKill: (() => void) | undefined;
		let ownedChild: ChildProcess | undefined;
		let physicalClose: Promise<void> | undefined;
		let first:
			| ReturnType<ReturnType<typeof createNodeProcessRunner>["run"]>
			| undefined;
		let next: Promise<void> | undefined;
		try {
			const ready = join(directory, "ready");
			const terminated = join(directory, "term");
			const gate = createResourceAdmission({
				capacityBytes: 1,
				availableBytes: () => 1,
			});
			const options = { signal: aborter.signal, abortKillAfterMs: 250 };
			first = gate
				.run(1, aborter.signal, () =>
					createNodeProcessRunner().run(
						process.execPath,
						[
							"-e",
							`process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(terminated)},'term')); require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000); setTimeout(()=>process.exit(42),5000);`,
						],
						options,
					),
				)
				.finally(() => {
					closed = true;
				});
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				try {
					pid = Number(await readFile(ready, "utf8"));
					break;
				} catch {
					await delay(10);
				}
			}
			expect(pid).toBeGreaterThan(0);
			const original = ChildProcess.prototype.kill;
			const kill = vi
				.spyOn(ChildProcess.prototype, "kill")
				.mockImplementation(function (this: ChildProcess, signal) {
					if (this.pid === pid) {
						if (!ownedChild) {
							ownedChild = this;
							physicalClose = new Promise<void>((resolve) =>
								this.once("close", () => resolve()),
							);
						}
						if (
							failure === "failed SIGTERM" &&
							(signal === undefined || signal === "SIGTERM")
						)
							throw new Error("fixture SIGTERM denied");
					}
					return original.call(this, signal);
				});
			restoreKill = () => kill.mockRestore();
			let aliveOnGrant = false;
			next = gate.run(1, new AbortController().signal, async () => {
				try {
					process.kill(pid as number, 0);
					aliveOnGrant = true;
				} catch {}
			});
			aborter.abort();
			const outcome = await Promise.race([
				first.then((result) => ({ result })),
				delay(1000).then(() => ({ result: undefined })),
			]);
			expect(
				outcome.result,
				"the owned child must close after its abort grace",
			).toBeDefined();
			expect(outcome.result?.code).toBeNull();
			if (failure === "failed SIGTERM") {
				expect(outcome.result?.stderr).toContain("fixture SIGTERM denied");
			} else {
				expect(outcome.result?.stderr).toMatch(/abort/i);
				expect(await readFile(terminated, "utf8")).toBe("term");
			}
			await next;
			expect(aliveOnGrant).toBe(false);
		} finally {
			aborter.abort();
			if (
				ownedChild &&
				ownedChild.exitCode === null &&
				ownedChild.signalCode === null
			) {
				ownedChild.kill("SIGKILL");
			} else if (pid !== undefined && !closed && !ownedChild) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await physicalClose;
			await first;
			await next;
			restoreKill?.();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("preserves the default SIGTERM grace and holds admission until close", async () => {
		const directory = await mkdtemp(join(tmpdir(), "process-runner-close-"));
		const aborter = new AbortController();
		try {
			const ready = join(directory, "ready");
			const exited = join(directory, "graceful-exit");
			const gate = createResourceAdmission({
				capacityBytes: 1,
				availableBytes: () => 1,
			});
			const first = gate.run(1, aborter.signal, () =>
				createNodeProcessRunner().run(
					process.execPath,
					[
						"-e",
						`process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(exited)},'graceful');process.exit(0)},400)); require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`,
					],
					{ signal: aborter.signal },
				),
			);
			let pid: number | undefined;
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				try {
					pid = Number(await readFile(ready, "utf8"));
					break;
				} catch {
					await delay(10);
				}
			}
			expect(pid).toBeGreaterThan(0);
			let aliveOnGrant = false;
			const next = gate.run(1, new AbortController().signal, async () => {
				try {
					process.kill(pid as number, 0);
					aliveOnGrant = true;
				} catch {}
			});
			aborter.abort();
			const [result] = await Promise.all([first, next]);
			expect(await readFile(exited, "utf8")).toBe("graceful");
			expect(result.code).toBeNull();
			expect(result.stderr).toMatch(/abort/i);
			expect(aliveOnGrant).toBe(false);
		} finally {
			aborter.abort();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("settles spawn failures and already-aborted launches without retaining admission", async () => {
		const runner = createNodeProcessRunner();
		const gate = createResourceAdmission({
			capacityBytes: 1,
			availableBytes: () => 1,
		});
		const controller = new AbortController();
		controller.abort();
		const aborted = await runner.run(
			process.execPath,
			["-e", "setTimeout(()=>{},30000)"],
			{ signal: controller.signal, abortKillAfterMs: 250 },
		);
		expect(aborted.code).toBeNull();
		expect(aborted.stderr).toMatch(/abort/i);
		const missing = await gate.run(1, new AbortController().signal, () =>
			runner.run("/no-such-bitovp-fixture-binary", [], {
				abortKillAfterMs: 250,
			}),
		);
		expect(missing.code).toBeNull();
		expect(missing.stderr).toMatch(/ENOENT/);
		await expect(
			gate.run(1, new AbortController().signal, async () => "next"),
		).resolves.toBe("next");
	});
	it("returns the exit code and buffered output of a finished child", async () => {
		const runner = createNodeProcessRunner();
		const result = await runner.run("sh", [
			"-c",
			"printf out; printf err 1>&2; exit 3",
		]);
		expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
	});

	it("an aborted signal ends a long-running child promptly with code null", async () => {
		const runner = createNodeProcessRunner();
		const aborter = new AbortController();
		const startedAt = Date.now();
		const pending = runner.run("sleep", ["30"], { signal: aborter.signal });
		setTimeout(() => aborter.abort(), 50);
		const result = await pending;
		expect(result.code).toBeNull();
		expect(result.stderr).toMatch(/abort/i);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
});
