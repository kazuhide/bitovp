import { FEEDER_ACTIVE_STATUSES, feederOccupancyWhere } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSdk } from "../orchestrator/fake-sdk";
import {
	createProviderLifecycleReconciler,
	providerTerminalMessage,
	type RunLifecycleRow,
} from "./provider-lifecycle";

/**
 *  (audit 5c3d97ca BLOCKER-1) — the reconciler in isolation: what
 * each provider answer does to the run row, the channel row, the feeders and
 * the emitter, and what the fences refuse.
 */

const NOW = "2026-08-30T12:00:00.000Z";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";

function run(over: Partial<RunLifecycleRow> = {}): RunLifecycleRow {
	return {
		id: "run-1",
		seq: 1,
		status: "RUNNING",
		error: null,
		bitmovinEncodingId: "enc-1",
		providerStatus: null,
		providerStatusObservedAt: null,
		providerUnknownSince: null,
		providerUnknownAlertedAt: null,
		providerTerminalAt: null,
		providerFeederStopsEnqueuedAt: null,
		heartbeatPollEpoch: 3,
		lastHeartbeatAt: null,
		createdAt: new Date("2026-08-30T11:00:00.000Z"),
		...over,
	};
}

function harness(now: () => string = () => NOW) {
	const runUpdateMany = vi.fn(async (_args?: unknown) => ({ count: 1 }));
	const runFindFirst = vi.fn(
		async (): Promise<Partial<RunLifecycleRow> | null> => null,
	);
	const runFindMany = vi.fn(
		async (): Promise<Partial<RunLifecycleRow>[]> => [],
	);
	const channelUpdateMany = vi.fn(async (_args?: unknown) => ({ count: 1 }));
	const feederFindMany = vi.fn(async () => [] as { id: string }[]);
	let prisma: AppPrismaClient;
	const transaction = vi.fn(
		async <T>(fn: (tx: AppPrismaClient) => Promise<T>): Promise<T> =>
			fn(prisma),
	);
	prisma = {
		liveChannelRun: {
			findFirst: runFindFirst,
			findMany: runFindMany,
			updateMany: runUpdateMany,
		},
		liveChannel: { updateMany: channelUpdateMany },
		feederSession: { findMany: feederFindMany },
		$transaction: transaction,
	} as unknown as AppPrismaClient;
	const enqueueFeederJob = vi.fn(async () => {});
	const emitChannel = vi.fn(async () => {});
	const reconciler = createProviderLifecycleReconciler({
		prisma,
		now,
		enqueueFeederJob,
		emitChannel,
	});
	return {
		reconciler,
		runFindFirst,
		runFindMany,
		runUpdateMany,
		channelUpdateMany,
		transaction,
		feederFindMany,
		enqueueFeederJob,
		emitChannel,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reconcile — identity guards", () => {
	it("projects a completed RUNNING airing as STOPPED, not an encoding error", async () => {
		const h = harness();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			}),
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "RUNNING" }),
				data: expect.objectContaining({
					status: "STOPPED",
					error: null,
					providerStatus: "FINISHED",
				}),
			}),
		);
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "STOPPED", error: null }),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(CHANNEL, null);
	});

	it("repairs a completed STOPPED airing projection without rewriting its retained run", async () => {
		const h = harness();
		const sdk = fakeSdk();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({
				status: "STOPPED",
				providerStatus: "FINISHED",
				providerTerminalAt: new Date(NOW),
				providerFeederStopsEnqueuedAt: new Date(NOW),
			}),
			encodingId: "enc-1",
			sdk,
		});
		expect(h.runUpdateMany).not.toHaveBeenCalled();
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "STOPPED", error: null }),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(CHANNEL, null);
	});

	it.each([
		"ERROR",
		"TRANSFER_ERROR",
	])("keeps provider %s on the error path", async (status) => {
		const h = harness();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({ getEncodingStatus: vi.fn(async () => ({ status })) }),
		});
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(
			CHANNEL,
			providerTerminalMessage(status, NOW),
		);
	});

	it.each([
		"CREATED",
		"PROVISIONING",
		"ERROR",
		"STOPPING",
	])("FINISHED does not convert %s startup or cleanup into a successful airing", async (status) => {
		const h = harness();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({ status, error: "retained startup failure" }),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			}),
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ERROR",
					error: "retained startup failure",
				}),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(
			CHANNEL,
			"retained startup failure",
		);
	});

	it.each([
		"CREATED",
		"PROVISIONING",
		"ERROR",
		"STOPPING",
	])("FINISHED without an error string still does not prove %s ever reached RUNNING", async (status) => {
		const h = harness();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({ status, error: null }),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			}),
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ERROR",
					error: providerTerminalMessage("FINISHED", NOW),
				}),
			}),
		);
	});

	it("does not clear an independent STOPPED cleanup failure on persisted FINISHED repair", async () => {
		const h = harness();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({
				status: "STOPPED",
				error: "feeder cleanup unconfirmed",
				providerStatus: "FINISHED",
				providerTerminalAt: new Date(NOW),
				providerFeederStopsEnqueuedAt: new Date(NOW),
			}),
			encodingId: "enc-1",
			sdk: fakeSdk(),
		});
		expect(h.runUpdateMany).not.toHaveBeenCalled();
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ERROR",
					error: "feeder cleanup unconfirmed",
				}),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(
			CHANNEL,
			"feeder cleanup unconfirmed",
		);
	});

	it("repairs a still-live projection from a persisted CANCELED stamp without rereading or replaying", async () => {
		const h = harness();
		const sdk = fakeSdk();
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			encodingId: "enc-1",
			sdk,
			run: run({
				status: "STOPPED",
				providerStatus: "CANCELED",
				providerTerminalAt: new Date(NOW),
				providerFeederStopsEnqueuedAt: new Date(NOW),
			}),
		});
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(h.runUpdateMany).not.toHaveBeenCalled();
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "STOPPED", error: null }),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledWith(CHANNEL, null);
	});

	it("projects CANCELED as STOPPED while retaining its provider identity and stopping feeders", async () => {
		const h = harness();
		h.feederFindMany.mockResolvedValueOnce([{ id: "feed-1" }]);
		await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "CANCELED" })),
			}),
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "run-1",
					bitmovinEncodingId: "enc-1",
					providerTerminalAt: null,
				}),
				data: expect.objectContaining({
					status: "STOPPED",
					error: null,
					providerStatus: "CANCELED",
					providerTerminalAt: new Date(NOW),
				}),
			}),
		);
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "STOPPED",
					error: null,
					streamKey: null,
					encoderIp: null,
				}),
			}),
		);
		expect(h.enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "feed-1",
			action: "stop",
		});
		expect(h.emitChannel).toHaveBeenCalledWith(CHANNEL, null);
	});

	it("commits provider evidence, run RUNNING and channel RUNNING in one transaction while clearing absent coordinates", async () => {
		const h = harness();
		const currentRun = run({ status: "PROVISIONING" });
		const heldAt = new Date("2026-08-30T11:59:00.000Z");
		const stepLog = [{ step: "await", status: "DONE" }];

		await expect(
			h.reconciler.commitRunning({
				channel: { id: CHANNEL },
				run: currentRun,
				encodingId: "enc-1",
				observation: { ok: true, status: "RUNNING", observedAt: NOW },
				coordinates: {},
				provisionClaimedAt: heldAt,
				stepLog,
			}),
		).resolves.toBe(true);

		expect(h.transaction).toHaveBeenCalledTimes(1);
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				liveChannelId: CHANNEL,
				bitmovinEncodingId: "enc-1",
				providerTerminalAt: null,
			},
			data: {
				status: "RUNNING",
				error: null,
				runningSince: new Date(NOW),
				streamKey: null,
				encoderIp: null,
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(NOW),
				providerUnknownSince: null,
				providerUnknownAlertedAt: null,
				stepLog,
			},
		});
		expect(h.channelUpdateMany).toHaveBeenCalledWith({
			where: {
				id: CHANNEL,
				status: { in: ["PROVISIONING"] },
				bitmovinEncodingId: "enc-1",
				provisionClaimedAt: heldAt,
			},
			data: {
				status: "RUNNING",
				error: null,
				runningSince: new Date(NOW),
				streamKey: null,
				encoderIp: null,
				provisionClaimedAt: null,
				stepLog,
			},
		});
	});

	it("aborts the transaction before the channel write when the exact run fence is lost", async () => {
		const h = harness();
		h.runUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			h.reconciler.commitRunning({
				channel: { id: CHANNEL },
				run: run(),
				encodingId: "enc-1",
				observation: { ok: true, status: "RUNNING", observedAt: NOW },
				coordinates: { streamKey: "fresh", encoderIp: "203.0.113.10" },
			}),
		).resolves.toBe(false);

		expect(h.channelUpdateMany).not.toHaveBeenCalled();
	});

	it("aborts and rolls back when the exact channel or provision-lease fence is lost", async () => {
		const h = harness();
		h.channelUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			h.reconciler.commitRunning({
				channel: { id: CHANNEL },
				run: run(),
				encodingId: "enc-1",
				observation: { ok: true, status: "RUNNING", observedAt: NOW },
				coordinates: { streamKey: "fresh", encoderIp: "203.0.113.10" },
				provisionClaimedAt: new Date("2026-08-30T11:59:00.000Z"),
			}),
		).resolves.toBe(false);

		expect(h.runUpdateMany).toHaveBeenCalledTimes(1);
		expect(h.transaction).toHaveBeenCalledTimes(1);
		await expect(h.transaction.mock.results[0]?.value).rejects.toBeInstanceOf(
			Error,
		);
	});

	it("never opens a RUNNING transaction from a terminal, transitional or unreadable provider observation", async () => {
		const h = harness();
		for (const observation of [
			{ ok: true as const, status: "FINISHED", observedAt: NOW },
			{ ok: true as const, status: "QUEUED", observedAt: NOW },
			{ ok: false as const, error: "timeout", observedAt: NOW },
		]) {
			await expect(
				h.reconciler.commitRunning({
					channel: { id: CHANNEL },
					run: run(),
					encodingId: "enc-1",
					observation,
					coordinates: {},
				}),
			).resolves.toBe(false);
		}

		expect(h.transaction).not.toHaveBeenCalled();
	});

	it("claims a heartbeat poll through the lifecycle door under run, encoding and prior epoch", async () => {
		const h = harness();
		const token = await h.reconciler.claimHeartbeatPoll(run());
		expect(token).toEqual({
			runId: "run-1",
			encodingId: "enc-1",
			epoch: 4,
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 3,
			},
			data: { heartbeatPollEpoch: { increment: 1 } },
		});
	});

	it("claims an UNKNOWN alert once under the exact run, encoding, epoch and open window", async () => {
		const h = harness();
		const currentRun = run({
			providerUnknownSince: new Date("2026-08-30T11:55:00.000Z"),
			heartbeatPollEpoch: 4,
		});
		h.runUpdateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const at = new Date(NOW);
		const token = { runId: "run-1", encodingId: "enc-1", epoch: 4 };

		expect(await h.reconciler.claimUnknownAlert(currentRun, token, at)).toBe(
			true,
		);
		expect(await h.reconciler.claimUnknownAlert(currentRun, token, at)).toBe(
			false,
		);
		expect(h.runUpdateMany).toHaveBeenNthCalledWith(1, {
			where: {
				id: "run-1",
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 4,
				providerUnknownSince: { not: null },
				providerUnknownAlertedAt: null,
			},
			data: { providerUnknownAlertedAt: at },
		});
	});

	it("timestamps a slow provider readback when it settles, not when it starts", async () => {
		let clock = "2026-08-30T12:00:00.000Z";
		let release: ((value: { status: string }) => void) | undefined;
		const h = harness(() => clock);
		const observed = h.reconciler.observe(
			fakeSdk({
				getEncodingStatus: vi.fn(
					() =>
						new Promise<{ status: string }>((resolve) => {
							release = resolve;
						}),
				),
			}),
			"enc-1",
		);
		clock = "2026-08-30T12:02:00.000Z";
		release?.({ status: "RUNNING" });
		expect(await observed).toEqual({
			ok: true,
			status: "RUNNING",
			observedAt: "2026-08-30T12:02:00.000Z",
		});
	});

	it("timestamps a failed provider readback when the rejection settles", async () => {
		let clock = "2026-08-30T12:00:00.000Z";
		let reject: ((reason: Error) => void) | undefined;
		const h = harness(() => clock);
		const observed = h.reconciler.observe(
			fakeSdk({
				getEncodingStatus: vi.fn(
					() =>
						new Promise<{ status: string }>((_resolve, rejectPromise) => {
							reject = rejectPromise;
						}),
				),
			}),
			"enc-1",
		);
		clock = "2026-08-30T12:02:00.000Z";
		reject?.(new Error("provider timeout"));
		expect(await observed).toEqual({
			ok: false,
			error: "provider timeout",
			observedAt: "2026-08-30T12:02:00.000Z",
		});
	});

	it("no run row → UNKNOWN, no provider call, no writes", async () => {
		const h = harness();
		const sdk = fakeSdk();
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: null,
			encodingId: "enc-1",
			sdk,
		});
		expect(out.lifecycle).toBe("UNKNOWN");
		expect(out.reason).toMatch(/no run row/);
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(h.runUpdateMany).not.toHaveBeenCalled();
		expect(h.channelUpdateMany).not.toHaveBeenCalled();
	});

	it("a run bound to ANOTHER encoding → UNKNOWN, refusing to reconcile across identities", async () => {
		const h = harness();
		const sdk = fakeSdk();
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({ bitmovinEncodingId: "enc-other" }),
			encodingId: "enc-1",
			sdk,
		});
		expect(out.lifecycle).toBe("UNKNOWN");
		expect(out.reason).toMatch(/enc-other, not enc-1/);
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(h.runUpdateMany).not.toHaveBeenCalled();
	});
});

describe("reconcile — UNKNOWN keeps everything", () => {
	it.each([
		["timeout", "request timed out after 10000ms"],
		["credential", "401 Unauthorized"],
		["single 404", "404 Not Found"],
	])("a failed readback (%s) opens the window first-writer-wins and touches nothing else", async (_label, error) => {
		const h = harness();
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(async () => {
				throw new Error(error);
			}),
		});
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk,
			fence: { epoch: 4 },
		});
		expect(out.lifecycle).toBe("UNKNOWN");
		expect(out.reason).toBe(error);
		expect(out.refusal).toMatch(/cannot be confirmed/);
		expect(out.unknownSince).toEqual(new Date(NOW));
		expect(h.runUpdateMany).toHaveBeenCalledTimes(1);
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 4,
				providerUnknownSince: null,
			},
			data: {
				providerUnknownSince: new Date(NOW),
				providerUnknownAlertedAt: null,
			},
		});
		expect(h.channelUpdateMany).not.toHaveBeenCalled();
		expect(h.enqueueFeederJob).not.toHaveBeenCalled();
		expect(h.emitChannel).not.toHaveBeenCalled();
	});

	it("an already-open window keeps its ORIGINAL start", async () => {
		const h = harness();
		const since = new Date("2026-08-30T11:50:00.000Z");
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({ providerUnknownSince: since }),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => {
					throw new Error("ECONNRESET");
				}),
			}),
		});
		expect(out.unknownSince).toEqual(since);
		expect(out.landed).toBe(true);
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: { id: "run-1", bitmovinEncodingId: "enc-1" },
			data: { providerUnknownSince: since },
		});
	});

	it("an unrecognised status word is UNKNOWN too — never alive, never gone", async () => {
		const h = harness();
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "PAUSED" })),
			}),
		});
		expect(out.lifecycle).toBe("UNKNOWN");
		expect(out.reason).toMatch(/unrecognised status "PAUSED"/);
		expect(h.channelUpdateMany).not.toHaveBeenCalled();
	});
});

describe("reconcile — RUNNING / TRANSITIONAL record the observation", () => {
	it("persists a slow RUNNING readback at its completion time", async () => {
		let clock = "2026-08-30T12:00:00.000Z";
		let release: ((value: { status: string }) => void) | undefined;
		const h = harness(() => clock);
		const reconciled = h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(
					() =>
						new Promise<{ status: string }>((resolve) => {
							release = resolve;
						}),
				),
			}),
		});
		clock = "2026-08-30T12:02:00.000Z";
		release?.({ status: "RUNNING" });
		expect(await reconciled).toMatchObject({
			lifecycle: "RUNNING",
			observedAt: "2026-08-30T12:02:00.000Z",
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					providerStatusObservedAt: new Date("2026-08-30T12:02:00.000Z"),
				}),
			}),
		);
	});

	it("RUNNING writes the word and time and closes the window, fenced on run + encoding (+ epoch)", async () => {
		const h = harness();
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({ providerUnknownSince: new Date("2026-08-30T11:59:00Z") }),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "RUNNING" })),
			}),
			fence: { epoch: 4 },
		});
		expect(out).toMatchObject({
			lifecycle: "RUNNING",
			status: "RUNNING",
			landed: true,
			refusal: null,
			unknownSince: null,
		});
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				bitmovinEncodingId: "enc-1",
				heartbeatPollEpoch: 4,
			},
			data: {
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(NOW),
				providerUnknownSince: null,
				providerUnknownAlertedAt: null,
			},
		});
		expect(h.channelUpdateMany).not.toHaveBeenCalled();
	});

	it("a fenced-out RUNNING write reports landed:false (a later tick owns the row)", async () => {
		const h = harness();
		h.runUpdateMany.mockResolvedValueOnce({ count: 0 });
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "QUEUED" })),
			}),
			fence: { epoch: 1 },
		});
		expect(out.lifecycle).toBe("TRANSITIONAL");
		expect(out.landed).toBe(false);
	});
});

describe("reconcile — TERMINAL is reconciled once, onto exactly this run", () => {
	it("treats a persisted terminal stamp as sticky and never trusts a later RUNNING wire answer", async () => {
		const h = harness();
		h.channelUpdateMany.mockResolvedValueOnce({ count: 0 });
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(async () => ({ status: "RUNNING" })),
		});
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({
				providerStatus: "FINISHED",
				providerStatusObservedAt: new Date(NOW),
				providerTerminalAt: new Date(NOW),
				providerFeederStopsEnqueuedAt: new Date(NOW),
			}),
			encodingId: "enc-1",
			sdk,
		});
		expect(out).toMatchObject({
			lifecycle: "TERMINAL",
			status: "FINISHED",
			terminalised: false,
			channelLanded: false,
		});
		expect(out.refusal).toMatch(/fresh run/);
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(h.runUpdateMany).not.toHaveBeenCalled();
		expect(h.transaction).toHaveBeenCalledTimes(1);
		expect(h.channelUpdateMany).toHaveBeenCalledTimes(1);
		expect(h.emitChannel).not.toHaveBeenCalled();
	});

	it("repairs a channel left live after a persisted terminal run stamp without trusting the provider again", async () => {
		const h = harness();
		const sdk = fakeSdk({
			getEncodingStatus: vi.fn(async () => ({ status: "RUNNING" })),
		});
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run({
				status: "ERROR",
				providerStatus: "FINISHED",
				providerStatusObservedAt: new Date(NOW),
				providerTerminalAt: new Date(NOW),
			}),
			encodingId: "enc-1",
			sdk,
		});

		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
		expect(out).toMatchObject({
			lifecycle: "TERMINAL",
			terminalised: false,
			channelLanded: true,
		});
		expect(h.channelUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: CHANNEL,
					bitmovinEncodingId: "enc-1",
					status: {
						in: ["CREATED", "PROVISIONING", "RUNNING", "STOPPING"],
					},
				}),
				data: expect.objectContaining({
					status: "ERROR",
					liveEffectFenceVersion: { increment: 1 },
					streamKey: null,
					encoderIp: null,
				}),
			}),
		);
		expect(h.emitChannel).toHaveBeenCalledTimes(1);
	});

	it("commits a fresh terminal run and channel together before any feeder stop or event", async () => {
		const h = harness();
		h.feederFindMany.mockResolvedValueOnce([{ id: "feed-1" }]);
		h.channelUpdateMany.mockRejectedValueOnce(
			new Error("channel write failed"),
		);

		await expect(
			h.reconciler.reconcile({
				channel: { id: CHANNEL },
				run: run(),
				encodingId: "enc-1",
				sdk: fakeSdk({
					getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
				}),
			}),
		).rejects.toThrow("channel write failed");

		expect(h.transaction).toHaveBeenCalledTimes(1);
		expect(h.feederFindMany).not.toHaveBeenCalled();
		expect(h.enqueueFeederJob).not.toHaveBeenCalled();
		expect(h.emitChannel).not.toHaveBeenCalled();
	});

	it("stamps the run, moves the channel with coordinates cleared and id kept, stops the run's feeders, emits once", async () => {
		const h = harness();
		h.feederFindMany.mockResolvedValueOnce([
			{ id: "feed-1" },
			{ id: "feed-2" },
		]);
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			}),
			channelWrite: {
				where: { provisionClaimedAt: new Date("2026-08-30T11:59:59Z") },
				data: { provisionClaimedAt: null },
			},
		});
		const message = providerTerminalMessage("FINISHED", NOW);
		expect(out).toMatchObject({
			lifecycle: "TERMINAL",
			status: "FINISHED",
			terminalised: true,
			channelLanded: true,
			reason: message,
		});
		expect(out.refusal).toMatch(/fresh run/);
		expect(h.runUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				bitmovinEncodingId: "enc-1",
				providerTerminalAt: null,
				status: "RUNNING",
				error: null,
			},
			data: {
				status: "STOPPED",
				error: null,
				endedAt: new Date(NOW),
				providerStatus: "FINISHED",
				providerStatusObservedAt: new Date(NOW),
				providerUnknownSince: null,
				providerUnknownAlertedAt: null,
				providerTerminalAt: new Date(NOW),
			},
		});
		expect(h.channelUpdateMany).toHaveBeenCalledWith({
			where: {
				id: CHANNEL,
				bitmovinEncodingId: "enc-1",
				status: {
					in: ["CREATED", "PROVISIONING", "RUNNING", "STOPPING"],
				},
				provisionClaimedAt: new Date("2026-08-30T11:59:59Z"),
				error: null,
			},
			data: expect.objectContaining({
				status: "STOPPED",
				liveEffectFenceVersion: { increment: 1 },
				error: null,
				runningSince: null,
				streamKey: null,
				encoderIp: null,
				provisionClaimedAt: null,
			}),
		});
		// The provider id is NOT in the cleared set.
		const channelData = h.channelUpdateMany.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(channelData.data).not.toHaveProperty("bitmovinEncodingId");
		expect(h.feederFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					liveChannelRunId: "run-1",
					OR: [
						feederOccupancyWhere(),
						{ status: { in: [...FEEDER_ACTIVE_STATUSES] } },
					],
				},
			}),
		);
		expect(h.enqueueFeederJob).toHaveBeenCalledTimes(2);
		expect(h.enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "feed-1",
			action: "stop",
		});
		expect(h.emitChannel).toHaveBeenCalledTimes(1);
		expect(h.emitChannel).toHaveBeenCalledWith(CHANNEL, null);
	});

	it("a fresh terminal observation whose run CAS loses writes no channel, stops no feeder and emits nothing", async () => {
		const h = harness();
		h.runUpdateMany.mockResolvedValueOnce({ count: 0 });
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "CANCELED" })),
			}),
			fence: { epoch: 1 },
		});
		expect(out.lifecycle).toBe("TERMINAL");
		expect(out.terminalised).toBe(false);
		expect(out.channelLanded).toBe(false);
		expect(h.channelUpdateMany).not.toHaveBeenCalled();
		expect(h.feederFindMany).not.toHaveBeenCalled();
		expect(h.emitChannel).not.toHaveBeenCalled();
	});

	it("uses a caller-supplied observation instead of calling the provider again", async () => {
		const h = harness();
		const sdk = fakeSdk();
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk,
			observation: { ok: true, status: "ERROR", observedAt: NOW },
		});
		expect(out.lifecycle).toBe("TERMINAL");
		expect(sdk.getEncodingStatus).not.toHaveBeenCalled();
	});

	it("stops the old run's feeders but emits no channel error after the channel has re-aired", async () => {
		const h = harness();
		h.channelUpdateMany.mockResolvedValueOnce({ count: 0 });
		h.feederFindMany.mockResolvedValueOnce([{ id: "feed-old" }]);
		const out = await h.reconciler.reconcile({
			channel: { id: CHANNEL },
			run: run(),
			encodingId: "enc-1",
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			}),
		});
		expect(out).toMatchObject({
			terminalised: true,
			channelLanded: false,
		});
		expect(h.enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "feed-old",
			action: "stop",
		});
		expect(h.emitChannel).not.toHaveBeenCalled();
	});

	it("keeps a failed feeder-stop enqueue pending and retries it until every stop intent is accepted", async () => {
		const h = harness();
		h.feederFindMany.mockResolvedValue([{ id: "feed-1" }]);
		h.enqueueFeederJob.mockRejectedValueOnce(new Error("redis down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const out = await h.reconciler.reconcile({
				channel: { id: CHANNEL },
				run: run(),
				encodingId: "enc-1",
				sdk: fakeSdk({
					getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
				}),
			});
			expect(out.terminalised).toBe(true);
			expect(out.channelLanded).toBe(true);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringMatching(/failed to enqueue feeder stop for feed-1/),
				"redis down",
			);
			expect(h.emitChannel).toHaveBeenCalledTimes(1);
			expect(h.runUpdateMany).not.toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						providerFeederStopsEnqueuedAt: expect.any(Date),
					}),
				}),
			);

			h.runFindMany.mockResolvedValueOnce([
				run({
					status: "ERROR",
					providerStatus: "FINISHED",
					providerTerminalAt: new Date(NOW),
				}),
			]);
			h.enqueueFeederJob.mockResolvedValue(undefined);
			await expect(
				h.reconciler.retryPendingTerminalFeederStops(),
			).resolves.toEqual({ pending: 1, completed: 1, failed: 0 });
			expect(h.enqueueFeederJob).toHaveBeenLastCalledWith({
				feederSessionId: "feed-1",
				action: "stop",
			});
			expect(h.runUpdateMany).toHaveBeenLastCalledWith({
				where: {
					id: "run-1",
					bitmovinEncodingId: "enc-1",
					providerTerminalAt: new Date(NOW),
					providerFeederStopsEnqueuedAt: null,
				},
				data: { providerFeederStopsEnqueuedAt: new Date(NOW) },
			});
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("awaitRunning / effectRefusal", () => {
	it("returns on the first RUNNING, ends at once on a terminal word, and exhausts on transitional/unknown readings", async () => {
		const h = harness();
		const sleep = vi.fn(async () => {});
		const running = await h.reconciler.awaitRunning({
			sdk: fakeSdk({
				getEncodingStatus: vi
					.fn()
					.mockResolvedValueOnce({ status: "QUEUED" })
					.mockResolvedValueOnce({ status: "RUNNING" }),
			}),
			encodingId: "enc-1",
			attempts: 5,
			intervalMs: 10,
			sleep,
		});
		expect(running.lifecycle).toBe("RUNNING");
		expect(sleep).toHaveBeenCalledTimes(1);

		const terminal = await h.reconciler.awaitRunning({
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "ERROR" })),
			}),
			encodingId: "enc-1",
			attempts: 5,
			intervalMs: 10,
			sleep,
		});
		expect(terminal.lifecycle).toBe("TERMINAL");

		const exhausted = await h.reconciler.awaitRunning({
			sdk: fakeSdk({
				getEncodingStatus: vi.fn(async () => {
					throw new Error("504");
				}),
			}),
			encodingId: "enc-1",
			attempts: 3,
			intervalMs: 10,
			sleep,
		});
		expect(exhausted.lifecycle).toBe("UNKNOWN");
		expect(exhausted.reason).toBe("504");
	});

	it("effectRefusal permits only a fresh RUNNING observation for the exact run and encoding", async () => {
		const h = harness();
		const nowMs = Date.parse(NOW);
		const expected = { runId: "run-1", encodingId: "enc-1" };
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/cannot be identified/,
		);
		h.runFindFirst.mockResolvedValueOnce(run());
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/not been observed/,
		);
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "QUEUED",
				providerStatusObservedAt: new Date(nowMs - 10_000),
			}),
		);
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/not RUNNING/,
		);
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(nowMs - 10_000),
			}),
		);
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toBeNull();
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(nowMs - 10_000),
			}),
		);
		expect(
			await h.reconciler.effectRefusal(CHANNEL, {
				runId: "run-other",
				encodingId: "enc-1",
			}),
		).toMatch(/run changed/);
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(nowMs - 10_000),
			}),
		);
		expect(
			await h.reconciler.effectRefusal(CHANNEL, {
				runId: "run-1",
				encodingId: "enc-other",
			}),
		).toMatch(/encoding changed/);
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(nowMs - 10_000),
				providerUnknownSince: new Date(nowMs - 5_000),
			}),
		);
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/cannot be confirmed/,
		);
		h.runFindFirst.mockResolvedValueOnce(
			run({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(nowMs - 10 * 60_000),
			}),
		);
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/cannot be confirmed/,
		);
		h.runFindFirst.mockResolvedValueOnce(
			run({ providerStatus: "FINISHED", providerTerminalAt: new Date(NOW) }),
		);
		expect(await h.reconciler.effectRefusal(CHANNEL, expected)).toMatch(
			/fresh run/,
		);
	});

	it("loadCurrentRun tolerates a row missing the new columns (pre-migration / stub) by reading them as null and epoch 0", async () => {
		const h = harness();
		h.runFindFirst.mockResolvedValueOnce({
			id: "run-9",
			seq: 9,
			status: "RUNNING",
		});
		const loaded = await h.reconciler.loadCurrentRun(CHANNEL);
		expect(loaded).toMatchObject({
			id: "run-9",
			bitmovinEncodingId: null,
			providerStatus: null,
			providerUnknownSince: null,
			providerUnknownAlertedAt: null,
			providerTerminalAt: null,
			providerFeederStopsEnqueuedAt: null,
			heartbeatPollEpoch: 0,
		});
	});
});
