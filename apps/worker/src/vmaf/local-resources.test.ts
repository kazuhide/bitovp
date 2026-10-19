import { describe, expect, it, vi } from "vitest";
import { createLocalVmafResources } from "./local-resources";
import type { ResourcePair } from "./resource-plan";

const GiB = 1024 ** 3;
const pair: ResourcePair = {
	reference: {
		width: 1920,
		height: 1080,
		fps: 24,
		bitDepth: 8,
		chromaFactor: 1,
		codec: "h264",
		durationSeconds: 10,
	},
	distorted: {
		width: 1920,
		height: 1080,
		fps: 24,
		bitDepth: 8,
		chromaFactor: 1,
		codec: "h264",
		durationSeconds: 10,
	},
	model: "vmaf_v0.6.1",
};

describe("shared local VMAF resource service", () => {
	it("connects the selected plan to atomic launch and records actual units", async () => {
		const service = createLocalVmafResources({
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 1.5 * GiB,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const calls: string[] = [];
		const first = session.run("first", pair, 2, async (plan) => {
			expect(plan.threads).toBe(2);
			calls.push("first");
			await held;
		});
		const second = session.run("second", pair, 2, async () =>
			calls.push("second"),
		);
		await Promise.resolve();
		expect(calls).toEqual(["first", "second"]);
		finish();
		await Promise.all([first, second]);
		expect(session.report().units).toHaveLength(2);
		expect(session.report().configured.concurrency).toBe(2);
	});

	it("retains explicit threads but serializes a concurrency ceiling when memory is tighter", async () => {
		const service = createLocalVmafResources({
			threads: 4,
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 1.5 * GiB,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		let finish!: () => void;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = session.run("first", pair, 2, async (plan) => {
			expect(plan.threads).toBe(4);
			await held;
		});
		const next = vi.fn();
		const second = session.run("second", pair, 2, async () => next());
		await Promise.resolve();
		expect(next).not.toHaveBeenCalled();
		finish();
		await Promise.all([first, second]);
		expect(next).toHaveBeenCalledOnce();
	});

	it("admits an exclusive conservative estimate below reduced headroom and reports its distinct reservation", async () => {
		let budget = 3 * GiB;
		const service = createLocalVmafResources({
			concurrency: 2,
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: budget,
				reserveBytes: 0.5 * GiB,
			}),
		});
		const session = service.begin(new AbortController().signal);
		budget = 2.5 * GiB;
		const unmeasured = { ...pair, model: "vmaf_v0.6.1neg" };
		await session.run("unmeasured", unmeasured, 2, async (plan) =>
			expect(plan.exclusive).toBe(true),
		);
		const unit = session.report().units[0];
		expect(unit?.estimatedBytes).toBeLessThan(budget);
		expect(unit?.reservationBytes).toBe(3 * GiB);
	});

	it("diagnoses the explicit manual fallback once without claiming memory protection", async () => {
		const diagnostic = vi.fn();
		const service = createLocalVmafResources({
			threads: 3,
			concurrency: 2,
			onDiagnostic: diagnostic,
			readResources: () => ({ cpuCapacity: 1, reserveBytes: 0.5 * GiB }),
		});
		for (let n = 0; n < 2; n++) {
			const session = service.begin(new AbortController().signal);
			await session.run("manual", pair, 2, async (plan) => {
				expect(plan.threads).toBe(3);
				expect(plan.decoderThreads).toBeUndefined();
			});
			expect(session.report().units[0]?.manualFallback).toBe(true);
		}
		expect(diagnostic).toHaveBeenCalledOnce();
		expect(diagnostic.mock.calls[0]?.[0]).toContain("unavailable");
	});
});
