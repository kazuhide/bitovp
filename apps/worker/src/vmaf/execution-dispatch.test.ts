import { expect, it, vi } from "vitest";
import {
	cloudJobConcurrency,
	createLocalExecutionGate,
} from "./execution-dispatch";

it("serializes local work and recovers after local failure", async () => {
	const gate = createLocalExecutionGate();
	let release!: () => void;
	const first = gate(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const secondRun = vi.fn(async () => 2);
	const second = gate(secondRun);
	await Promise.resolve();
	expect(secondRun).not.toHaveBeenCalled();
	release();
	await first;
	expect(await second).toBe(2);
	await expect(
		gate(async () => {
			throw Error("failed");
		}),
	).rejects.toThrow("failed");
	expect(await gate(async () => 3)).toBe(3);
});
it("validates explicit concurrency and preserves local-only default", () => {
	expect(cloudJobConcurrency(undefined, false)).toBe(1);
	expect(cloudJobConcurrency(undefined, true)).toBe(2);
	for (const value of ["0", "NaN", "33", "1.5"])
		expect(() => cloudJobConcurrency(value, true)).toThrow();
	expect(cloudJobConcurrency("8", true)).toBe(8);
});
