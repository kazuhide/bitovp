import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeProcessRunner } from "./process-runner";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

function fixture(pid: number | undefined = 12345) {
	const child = Object.assign(new EventEmitter(), {
		pid: pid as number | undefined,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	vi.mocked(spawn).mockReturnValue(
		child as unknown as ReturnType<typeof spawn>,
	);
	const controller = new AbortController();
	const run = (abortKillAfterMs: number | undefined) => {
		const options = { signal: controller.signal, abortKillAfterMs };
		return createNodeProcessRunner().run("fixture", [], options);
	};
	const abort = () => {
		controller.abort();
		child.emit(
			"error",
			Object.assign(new Error("The operation was aborted"), {
				name: "AbortError",
			}),
		);
	};
	const exit = () => {
		child.signalCode = "SIGTERM";
		child.emit("exit", null, "SIGTERM");
	};
	return { child, controller, run, abort, exit };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(spawn).mockReset();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("one-shot abort grace ownership", () => {
	it("holds an opted-in child when its first SIGTERM attempt emits a normal error", async () => {
		const t = fixture();
		let settled = false;
		const pending = t.run(250).then((result) => {
			settled = true;
			return result;
		});
		try {
			t.controller.abort();
			t.child.emit("error", new Error("kill SIGTERM EPERM"));
			await Promise.resolve();
			expect(
				settled,
				"a failed initial signal must not release a live child",
			).toBe(false);
			await vi.advanceTimersByTimeAsync(250);
			expect(t.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
			expect(settled).toBe(false);
			t.exit();
			t.child.emit("close", null, "SIGKILL");
			await expect(pending).resolves.toMatchObject({
				code: null,
				stderr: expect.stringContaining("EPERM"),
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			t.child.emit("close", null, "SIGKILL");
			await pending;
		}
	});

	it("sends one hard kill at the deadline but retains ownership until close", async () => {
		const t = fixture();
		let settled = false;
		const pending = t.run(250).then((result) => {
			settled = true;
			return result;
		});
		t.abort();
		await vi.advanceTimersByTimeAsync(249);
		expect(t.child.kill).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(t.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).toHaveBeenCalledTimes(1);
		t.exit();
		expect(settled).toBe(false);
		t.child.stdout.write("drained output");
		t.child.emit("close", null, "SIGKILL");
		await expect(pending).resolves.toMatchObject({
			code: null,
			stdout: "drained output",
		});
		expect(vi.getTimerCount()).toBe(0);
		expect(t.child.listenerCount("exit")).toBe(0);
		expect(t.child.listenerCount("close")).toBe(0);
		expect(t.child.listenerCount("error")).toBe(0);
	});

	it("clears the deadline on exit even while stdio keeps close pending", async () => {
		const t = fixture();
		let settled = false;
		const pending = t.run(250).then((result) => {
			settled = true;
			return result;
		});
		t.abort();
		await vi.advanceTimersByTimeAsync(100);
		t.exit();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		t.child.emit("close", 0, null);
		await expect(pending).resolves.toMatchObject({ code: null });
	});

	it("does not schedule a stale kill when abort follows exit", async () => {
		const t = fixture();
		const pending = t.run(250);
		t.exit();
		t.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		t.child.emit("close", 0, null);
		await expect(pending).resolves.toMatchObject({ code: null });
	});

	it("clears the deadline after a fast aborted close", async () => {
		const t = fixture();
		const pending = t.run(250);
		t.abort();
		t.child.emit("close", null, "SIGTERM");
		await pending;
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(t.child.listenerCount("exit")).toBe(0);
		expect(t.child.listenerCount("close")).toBe(0);
		expect(t.child.listenerCount("error")).toBe(0);
	});

	it("does not create a deadline for the default SIGTERM-only behavior", async () => {
		const t = fixture();
		const pending = t.run(undefined);
		t.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		t.child.emit("close", 0, null);
		await pending;
	});

	it("settles an unspawned child without an abort deadline", async () => {
		const t = fixture();
		t.child.pid = undefined;
		const pending = t.run(250);
		t.child.emit("error", new Error("spawn ENOENT"));
		await expect(pending).resolves.toMatchObject({
			code: null,
			stderr: "spawn ENOENT",
		});
		t.controller.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(t.child.listenerCount("exit")).toBe(0);
		expect(t.child.listenerCount("close")).toBe(0);
		expect(t.child.listenerCount("error")).toBe(0);
	});

	it.each([
		"emit",
		"throw",
		"return false",
	])("retains ownership after hard-kill failure (%s)", async (mode) => {
		const t = fixture();
		let settled = false;
		const pending = t.run(250).then((result) => {
			settled = true;
			return result;
		});
		t.child.kill.mockImplementation(() => {
			if (mode === "throw") throw new Error("kill denied");
			if (mode === "emit") t.child.emit("error", new Error("kill denied"));
			return false;
		});
		t.abort();
		await vi.advanceTimersByTimeAsync(250);
		expect(t.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		expect(settled).toBe(false);
		t.exit();
		t.child.emit("close", null, "SIGTERM");
		const result = await pending;
		expect(result.code).toBeNull();
		if (mode !== "return false") expect(result.stderr).toContain("kill denied");
		expect(vi.getTimerCount()).toBe(0);
		expect(t.child.listenerCount("exit")).toBe(0);
		expect(t.child.listenerCount("close")).toBe(0);
		expect(t.child.listenerCount("error")).toBe(0);
	});

	it("does not restart the deadline after another abort error", async () => {
		const t = fixture();
		const pending = t.run(250);
		t.abort();
		await vi.advanceTimersByTimeAsync(100);
		t.abort();
		await vi.advanceTimersByTimeAsync(150);
		expect(t.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		t.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).toHaveBeenCalledTimes(1);
		t.exit();
		t.child.emit("close", null, "SIGKILL");
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts the largest safe timer without wrapping to an immediate kill", async () => {
		const t = fixture();
		const pending = t.run(2 ** 31 - 1);
		t.abort();
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.child.kill).not.toHaveBeenCalled();
		t.exit();
		t.child.emit("close", null, "SIGTERM");
		await pending;
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		0,
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		2 ** 31,
	])("rejects an invalid grace before creating a child (%s)", async (grace) => {
		const t = fixture();
		const pending = t.run(grace);
		pending.catch(() => {});
		try {
			expect(spawn).not.toHaveBeenCalled();
			await expect(pending).rejects.toThrow(RangeError);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			t.child.emit("close", 0, null);
			await pending.catch(() => {});
		}
	});
});
