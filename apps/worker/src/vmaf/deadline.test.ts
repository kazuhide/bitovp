import { afterEach, expect, it, vi } from "vitest";
import { VmafDeadlineExceeded, withVmafDeadline } from "./deadline";

afterEach(() => vi.useRealTimers());
it("aborts an already expired queued job without entering work", async () => {
	const work = vi.fn();
	await expect(
		withVmafDeadline(
			new AbortController().signal,
			"2020-01-01T00:00:00Z",
			work,
		),
	).rejects.toBeInstanceOf(VmafDeadlineExceeded);
	expect(work).not.toHaveBeenCalled();
});
it("keeps ownership until aborted work settles", async () => {
	vi.useFakeTimers();
	const deadline = new Date(Date.now() + 100).toISOString();
	let closed = false;
	let settled = false;
	const pending = withVmafDeadline(
		new AbortController().signal,
		deadline,
		async (signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() =>
						setTimeout(() => {
							closed = true;
							resolve();
						}, 250),
					{ once: true },
				),
			);
			signal.throwIfAborted();
		},
	).finally(() => {
		settled = true;
	});
	pending.catch(() => {});
	await vi.advanceTimersByTimeAsync(100);
	expect(settled).toBe(false);
	expect(closed).toBe(false);
	await vi.advanceTimersByTimeAsync(250);
	await expect(pending).rejects.toBeInstanceOf(VmafDeadlineExceeded);
	expect(closed).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});
it("does not overflow a distant deadline or leave a timer after completion", async () => {
	vi.useFakeTimers();
	const pending = withVmafDeadline(
		new AbortController().signal,
		"2099-01-01T00:00:00Z",
		async (signal) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(signal.aborted).toBe(false);
			return "result";
		},
	);
	await vi.advanceTimersByTimeAsync(10);
	expect(await pending).toBe("result");
	expect(vi.getTimerCount()).toBe(0);
});
it("preserves caller cancellation and leaves omission unchanged", async () => {
	const parent = new AbortController();
	const reason = new Error("row canceled");
	parent.abort(reason);
	await expect(
		withVmafDeadline(parent.signal, undefined, async (signal) =>
			signal.throwIfAborted(),
		),
	).rejects.toBe(reason);
	const active = new AbortController();
	await withVmafDeadline(active.signal, undefined, async (signal) =>
		expect(signal).toBe(active.signal),
	);
});

it("a real owned Node child exits before a deadline failure is returned", async () => {
	const { createNodeProcessRunner } = await import("../feeder/process-runner");
	const runner = createNodeProcessRunner();
	let closed = false;
	await expect(
		withVmafDeadline(
			new AbortController().signal,
			new Date(Date.now() + 500).toISOString(),
			async (signal) => {
				const result = await runner.run(
					process.execPath,
					[
						"-e",
						'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)',
					],
					{ signal, abortKillAfterMs: 50 },
				);
				closed = true;
				expect(result.stdout).toContain("ready");
				expect(result.code).toBeNull();
			},
		),
	).rejects.toBeInstanceOf(VmafDeadlineExceeded);
	expect(closed).toBe(true);
});
