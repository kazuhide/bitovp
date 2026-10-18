import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "./runner";
import { awaitTerminal, awaitVmafTerminal } from "./runner";

/**
 * The per-scenario budget, and what it is allowed to charge a scenario for.
 *
 * A real 38-scenario corpus run reported `PASS 2 · FAIL 26 · SKIP 38 · INVALID 7`, and the
 * INVALIDs were dominated by one line:
 *
 *   INVALID  harness error: timed out after 900s at step 0/26 (status QUEUED)
 *
 * Six of the seven were at `step 0` and `QUEUED` — jobs the orchestrator had never picked up,
 * because its BullMQ worker ran at the default concurrency of 1 while the runner submitted
 * four at a time. The harness spent 900s waiting in a queue and then blamed the encoding.
 *
 * Two distinct defects, and this file pins both:
 *
 *   1. the budget must measure WORK, not queueing — a job with nothing done yet has not
 *      started, so its clock has not started either
 *   2. when the queue really never serves it, the message must say so, because
 *      "timed out at step 0/26" reads as a slow encoding and sent me looking at Bitmovin
 *
 * The interval AND the clock are injected. The clock matters: my first version compared real
 * elapsed time against a 5ms budget, and it failed because 40 polls take longer than 4×5ms —
 * the test's own arithmetic, not the code. A budget test that races the machine it runs on
 * proves nothing either way, so time here is a counter the test advances itself.
 */

/**
 * A prisma stand-in that replays a fixed sequence of rows, and a clock that advances once per
 * POLL rather than once per read.
 *
 * The distinction is what makes the numbers below legible. A clock that ticks on every `now`
 * advances two or three times per loop iteration depending on which branch runs, so "12 polls
 * at 100ms" silently means 2,400ms — and my second attempt at this test also failed on its own
 * arithmetic. Tying the tick to the row read makes elapsed time exactly `polls × stepMs`.
 */
function fakeWorld(rows: Array<Record<string, unknown>>, stepMs: number) {
	let calls = 0;
	let t = 1_000_000;
	return {
		polls: () => calls,
		now: () => t,
		client: {
			encodingJob: {
				findUnique: async () => {
					const row = rows[Math.min(calls, rows.length - 1)];
					calls++;
					t += stepMs;
					return row;
				},
			},
		} as unknown as RunnerConfig["prisma"],
	};
}

function configWith(
	prisma: RunnerConfig["prisma"],
	perScenarioTimeoutMs: number,
): RunnerConfig {
	// Only the two fields awaitTerminal reads; anything else would be decoration that
	// implies this test covers more than it does.
	return { prisma, perScenarioTimeoutMs } as unknown as RunnerConfig;
}

const queued = {
	status: "QUEUED",
	error: null,
	bitmovinEncodingId: null,
	doneSteps: 0,
	totalSteps: 26,
};
const running = (done: number) => ({
	status: "RUNNING",
	error: null,
	bitmovinEncodingId: "enc-1",
	doneSteps: done,
	totalSteps: 26,
});

describe("awaitTerminal — the budget measures work, not queueing", () => {
	it("returns as soon as the row reaches a terminal status", async () => {
		const world = fakeWorld(
			[
				queued,
				running(3),
				{
					status: "SUCCEEDED",
					error: null,
					bitmovinEncodingId: "enc-1",
					doneSteps: 26,
					totalSteps: 26,
				},
			],
			1_000,
		);
		const out = await awaitTerminal(
			configWith(world.client, 600_000),
			"job-1",
			0,
			world.now,
		);
		expect(out).toEqual({
			status: "SUCCEEDED",
			error: null,
			encodingId: "enc-1",
		});
	});

	it("does NOT charge a scenario for time spent QUEUED at step 0", async () => {
		/**
		 * The regression, stated as the thing that must not happen: a job that sits QUEUED for
		 * longer than the per-scenario budget and THEN starts working must still get its full
		 * budget. Before the fix this threw "timed out after Xs at step 0/26 (status QUEUED)".
		 */
		const world = fakeWorld(
			[
				...Array.from({ length: 12 }, () => queued),
				running(1),
				{
					status: "SUCCEEDED",
					error: null,
					bitmovinEncodingId: "enc-1",
					doneSteps: 26,
					totalSteps: 26,
				},
			],
			1_000,
		);
		/**
		 * 12 polls × 1s = 12s of queueing against a 5s per-scenario budget: 2.4× past the
		 * deadline this used to throw on, and still inside the 20s queue budget. So the job must
		 * be awaited, not killed — and then get its full 5s once step 1 lands.
		 */
		const out = await awaitTerminal(
			configWith(world.client, 5_000),
			"job-1",
			0,
			world.now,
		);
		expect(out.status).toBe("SUCCEEDED");
		expect(world.polls(), "polled until it reached a terminal row").toBe(14);
	});

	it("still gives up when the queue never serves the job — and says that, not 'timed out'", async () => {
		const world = fakeWorld([queued], 3_000);
		// Queue budget = 4 × 5s = 20s and the clock jumps 3s a poll, so it expires on poll 8 —
		// the give-up is a real elapsed budget, not an artefact of a zero one.
		await expect(
			awaitTerminal(configWith(world.client, 5_000), "job-1", 0, world.now),
		).rejects.toThrow(/still QUEUED after 20s and step 0\/26/);
		expect(world.polls(), "waited out the whole queue budget").toBeGreaterThan(
			6,
		);
		// The message has to name the cause, or the next person reads it as a slow encoding —
		// which is exactly the wrong turn a real run cost me.
		const again = fakeWorld([queued], 3_000);
		await expect(
			awaitTerminal(configWith(again.client, 5_000), "job-1", 0, again.now),
		).rejects.toThrow(/never picked this job up.*ORCHESTRATOR_CONCURRENCY/);
	});

	it("does time out a job that IS working but never finishes", async () => {
		// The complement: the loosened clock must not have made the budget unenforceable.
		const world = fakeWorld([running(4)], 3_000);
		await expect(
			awaitTerminal(configWith(world.client, 5_000), "job-1", 0, world.now),
		).rejects.toThrow(/timed out after 5s at step 4\/26 \(status RUNNING\)/);
	});

	it("times out a job that regressed to QUEUED after doing work", async () => {
		/**
		 * A stalled BullMQ job goes back to waiting with its step count intact. That is a real
		 * failure and must still be caught — the exemption is for step 0 only, or a job that
		 * flaps between QUEUED and RUNNING would reset its clock forever.
		 */
		const world = fakeWorld([{ ...queued, doneSteps: 7 }], 3_000);
		await expect(
			awaitTerminal(configWith(world.client, 5_000), "job-1", 0, world.now),
		).rejects.toThrow(/timed out after 5s at step 7\/26 \(status QUEUED\)/);
	});

	it("reports a vanished row rather than waiting out the budget", async () => {
		const world = fakeWorld(
			[undefined as unknown as Record<string, unknown>],
			1_000,
		);
		await expect(
			awaitTerminal(configWith(world.client, 5_000), "job-9", 0, world.now),
		).rejects.toThrow(/job-9 disappeared/);
	});
});

describe("awaitTerminal — a QC park is not an end (ledger #207)", () => {
	it("keeps polling through AWAITING_QC until the continuation lands", async () => {
		const world = fakeWorld(
			[
				running(20),
				{
					status: "AWAITING_QC",
					error: null,
					bitmovinEncodingId: "enc-1",
					doneSteps: 24,
					totalSteps: 26,
				},
				{
					status: "AWAITING_QC",
					error: null,
					bitmovinEncodingId: "enc-1",
					doneSteps: 24,
					totalSteps: 26,
				},
				{
					status: "QC_FAILED",
					error: "QC gate failed: 1 of 1 rule(s) below threshold",
					bitmovinEncodingId: "enc-1",
					doneSteps: 24,
					totalSteps: 26,
				},
			],
			100,
		);
		const result = await awaitTerminal(
			configWith(world.client, 10_000),
			"job-1",
			0,
			world.now,
		);
		expect(result.status).toBe("QC_FAILED");
		expect(world.polls()).toBe(4);
	});
});

/**
 * A prisma stand-in for the AUTO VmafJob read, replaying rows and recording the WHERE —
 * the row that gated delivery is the `vod-auto:` one, and a filter that read "the latest"
 * would hand a lab-manual re-run  to the verifier.
 */
function fakeVmafWorld(
	rows: Array<Record<string, unknown> | null>,
	stepMs: number,
) {
	let calls = 0;
	let t = 5_000_000;
	const wheres: unknown[] = [];
	return {
		wheres,
		now: () => t,
		client: {
			vmafJob: {
				findFirst: async (args: { where: unknown }) => {
					wheres.push(args.where);
					const row = rows[Math.min(calls, rows.length - 1)];
					calls++;
					t += stepMs;
					return row;
				},
			},
		} as unknown as RunnerConfig["prisma"],
	};
}

describe("awaitVmafTerminal — the measurement is part of the scenario (ledger #207)", () => {
	it("waits through absent → RUNNING → FINISHED and asks for the AUTO row", async () => {
		const world = fakeVmafWorld(
			[
				null,
				{ status: "PENDING" },
				{ status: "RUNNING" },
				{ status: "FINISHED" },
			],
			100,
		);
		const result = await awaitVmafTerminal(
			configWith(world.client, 10_000),
			"job-1",
			0,
			world.now,
		);
		expect(result).toEqual({ status: "FINISHED", polls: 4 });
		expect(world.wheres[0]).toEqual({
			encodingJobId: "job-1",
			triggerKey: "vod-auto:job-1",
		});
	});

	it("returns ERROR as soon as the row says so — the report FAILs it, not the harness", async () => {
		const world = fakeVmafWorld([{ status: "ERROR" }], 100);
		const result = await awaitVmafTerminal(
			configWith(world.client, 10_000),
			"job-1",
			0,
			world.now,
		);
		expect(result).toEqual({ status: "ERROR", polls: 1 });
	});

	it("gives up on a row that never appears after the absent grace", async () => {
		const world = fakeVmafWorld([null], 100);
		const result = await awaitVmafTerminal(
			configWith(world.client, 10_000),
			"job-1",
			0,
			world.now,
			350,
		);
		expect(result.status).toBe("ABSENT");
		expect(result.polls).toBe(4);
	});

	it("times out a measurement that outlives the scenario budget", async () => {
		const world = fakeVmafWorld([{ status: "RUNNING" }], 100);
		const result = await awaitVmafTerminal(
			configWith(world.client, 250),
			"job-1",
			0,
			world.now,
		);
		expect(result.status).toBe("TIMEOUT");
		expect(result.polls).toBe(3);
	});
});
