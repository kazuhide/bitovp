import { afterEach, expect, it, vi } from "vitest";
import { ResetRowDeleted, whileRowExists } from "./row-liveness";

afterEach(() => vi.useRealTimers());
it("never starts a deleted work item", async () => {
	const work = vi.fn();
	await expect(whileRowExists(async () => false, work)).rejects.toBeInstanceOf(
		ResetRowDeleted,
	);
	expect(work).not.toHaveBeenCalled();
});
it("aborts an active process after reset and refuses a successful result", async () => {
	vi.useFakeTimers();
	let present = true;
	let aborted = false;
	const result = whileRowExists(
		async () => present,
		(signal) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve("late output");
				});
			}),
	);
	const assertion = expect(result).rejects.toBeInstanceOf(ResetRowDeleted);
	await vi.advanceTimersByTimeAsync(1);
	present = false;
	await vi.advanceTimersByTimeAsync(1_000);
	await assertion;
	expect(aborted).toBe(true);
});
it("preserves normal work", async () => {
	await expect(
		whileRowExists(
			async () => true,
			async () => "ok",
		),
	).resolves.toBe("ok");
});
