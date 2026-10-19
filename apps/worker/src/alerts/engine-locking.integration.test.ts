import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProviderLifecycleReconciler } from "../live/provider-lifecycle";
import { fakeSdk } from "../orchestrator/fake-sdk";
import { createHeartbeatDoor } from "../orchestrator/run-mirror";
import { createAlertEngine } from "./engine";

const runtimeUrl = process.env.BITOVP_MONITORING_TEST_DATABASE_URL;
const adminUrl = process.env.BITOVP_MONITORING_TEST_ADMIN_URL;

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

/** Preserve real queries, transactions and row locks while controlling one boundary. */
function instrumentTransactions(
	base: AppPrismaClient,
	decorate: (tx: AppTransactionClient) => Promise<AppTransactionClient>,
): AppPrismaClient {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction") {
				return (fn: (tx: AppTransactionClient) => Promise<unknown>) =>
					target.$transaction(async (tx) => fn(await decorate(tx)), {
						maxWait: 5_000,
						timeout: 10_000,
					});
			}
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function backendPid(tx: AppTransactionClient): Promise<number> {
	const [row] = await tx.$queryRaw<
		{ pid: number }[]
	>`SELECT pg_backend_pid() AS pid`;
	if (!row) throw new Error("Missing PostgreSQL backend");
	return row.pid;
}

async function waitForBlockedBy(
	admin: AppPrismaClient,
	waiter: number,
	owner: number,
) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [row] = await admin.$queryRaw<{ blocked: boolean }[]>`
			SELECT ${owner}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`;
		if (row?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Alert transaction did not wait for the poll's row lock");
}

describe.runIf(Boolean(runtimeUrl && adminUrl))(
	"real PostgreSQL monitoring deadline and alert lock ordering",
	() => {
		const organizationId = randomUUID();
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let tenant: AppPrismaClient;

		beforeAll(async () => {
			for (const value of [runtimeUrl, adminUrl]) {
				if (
					!value ||
					!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
				) {
					throw new Error(
						"Monitoring integration tests require dedicated loopback PostgreSQL URLs",
					);
				}
			}
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			tenant = createTenantPrismaClient(runtime, organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					name: "Monitoring lock test",
					slug: `test-${organizationId}`,
				},
			});
		});

		afterAll(async () => {
			try {
				if (admin) {
					await admin.liveChannel.deleteMany({ where: { organizationId } });
					await admin.organization.deleteMany({
						where: { id: organizationId },
					});
				}
			} finally {
				if (runtime) await runtime.$disconnect();
				if (admin) await admin.$disconnect();
			}
		});

		it.each([
			"heartbeat",
			"provider terminal",
		] as const)("a deadline during %s persistence rolls the poll back and lets stale alert finalization finish", async (kind) => {
			const liveChannelId = randomUUID();
			const runId = randomUUID();
			const encodingId = `test-${randomUUID()}`;
			const now = new Date("2026-10-19T00:00:00Z");
			const createdAt = new Date(now.getTime() - 90_000);
			await tenant.liveChannel.create({
				data: {
					id: liveChannelId,
					name: "Monitoring deadline",
					status: "RUNNING",
					plan: {},
					bitmovinEncodingId: encodingId,
				},
			});
			const run = await tenant.liveChannelRun.create({
				data: {
					id: runId,
					liveChannelId,
					seq: 1,
					status: "RUNNING",
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
					heartbeatPollEpoch: 7,
					createdAt,
				},
			});
			await tenant.alertRule.create({
				data: {
					liveChannelId,
					metric: "HEARTBEAT_STALE",
					windowPolls: 2,
				},
			});
			const pollAtChannel = barrier();
			const releaseChannel = barrier();
			const alertStarted = barrier();
			let pollPid = 0;
			let alertPid = 0;
			const pollClient = instrumentTransactions(tenant, async (tx) => {
				pollPid = await backendPid(tx);
				return new Proxy(tx, {
					get(target, key) {
						if (key === "liveChannel")
							return new Proxy(target.liveChannel, {
								get(delegate, method) {
									if (method === "updateMany")
										return async (
											...args: Parameters<typeof delegate.updateMany>
										) => {
											// The production caller already holds its run lock and
											// has passed the abort guard before entering this update.
											pollAtChannel.release();
											await releaseChannel.ready;
											return delegate.updateMany(...args);
										};
									return Reflect.get(delegate, method);
								},
							});
						return Reflect.get(target, key);
					},
				});
			});
			const alertClient = instrumentTransactions(tenant, async (tx) => {
				alertPid = await backendPid(tx);
				alertStarted.release();
				return tx;
			});
			const controller = new AbortController();
			const reason = new Error(
				"Monitoring deadline expired during persistence",
			);
			const token = { runId, encodingId, epoch: 7 };
			const emitEvent = vi.fn(async () => {});
			const engine = createAlertEngine({
				prisma: alertClient,
				now: () => now,
				sweepIntervalMs: 30_000,
				emitEvent,
			});
			const poll =
				kind === "heartbeat"
					? createHeartbeatDoor(pollClient).recordHeartbeat(
							liveChannelId,
							encodingId,
							now,
							{ at: now.toISOString(), raw: {} },
							token,
							{ raw: {}, deltas: {} },
							controller.signal,
						)
					: createProviderLifecycleReconciler({
							prisma: pollClient,
							now: () => now.toISOString(),
							enqueueFeederJob: async () => {},
							emitChannel: async () => {},
						}).reconcile({
							channel: { id: liveChannelId },
							run,
							encodingId,
							sdk: fakeSdk({
								getEncodingStatus: async () => ({ status: "FINISHED" }),
							}),
							fence: { epoch: 7 },
							signal: controller.signal,
						});
			const pollResult = Promise.allSettled([poll]);
			let alertResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await Promise.race([
					pollAtChannel.ready,
					pollResult.then((result) => {
						throw new Error("Poll settled before the channel barrier", {
							cause: result,
						});
					}),
				]);
				await new Promise<void>((resolve) =>
					setTimeout(() => {
						controller.abort(reason);
						resolve();
					}, 0),
				);
				alertResult = Promise.allSettled([
					engine(
						liveChannelId,
						"RUNNING",
						createdAt.toISOString(),
						{ programStartAt: null, programEndAt: null },
						{ id: runId, createdAt },
						token,
					),
				]);
				await Promise.race([
					alertStarted.ready,
					alertResult.then((result) => {
						throw new Error("Alert settled before its transaction started", {
							cause: result,
						});
					}),
				]);
				await waitForBlockedBy(admin, alertPid, pollPid);
				releaseChannel.release();
				expect(await pollResult).toEqual([{ status: "rejected", reason }]);
				expect(await alertResult).toEqual([
					{ status: "fulfilled", value: { opened: 1, resolved: 0 } },
				]);
				expect(
					await tenant.liveChannelRun.findUnique({
						where: { id: runId },
						select: {
							status: true,
							lastHeartbeat: true,
							providerTerminalAt: true,
						},
					}),
				).toEqual({
					status: "RUNNING",
					lastHeartbeat: null,
					providerTerminalAt: null,
				});
				expect(
					(
						await tenant.liveChannel.findUnique({
							where: { id: liveChannelId },
						})
					)?.lastHeartbeat,
				).toBeNull();
				expect(
					await tenant.liveHeartbeat.count({ where: { liveChannelId } }),
				).toBe(0);
				expect(
					await tenant.alertEvent.count({
						where: { liveChannelId, resolvedAt: null },
					}),
				).toBe(1);
				expect(emitEvent).toHaveBeenCalledTimes(1);
			} finally {
				releaseChannel.release();
				await pollResult;
				await alertResult;
			}
		}, 15_000);
		it("skips an alert while cancel-start owns the channel and waits for its run", async () => {
			const liveChannelId = randomUUID();
			const runId = randomUUID();
			const encodingId = `test-${randomUUID()}`;
			const now = new Date("2026-10-19T00:00:00Z");
			const createdAt = new Date(now.getTime() - 90_000);
			await tenant.liveChannel.create({
				data: {
					id: liveChannelId,
					name: "Cancel-start lock test",
					status: "RUNNING",
					plan: {},
					bitmovinEncodingId: encodingId,
				},
			});
			await tenant.liveChannelRun.create({
				data: {
					id: runId,
					liveChannelId,
					seq: 1,
					status: "RUNNING",
					createdAt,
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
					heartbeatPollEpoch: 7,
				},
			});
			await tenant.alertRule.create({
				data: {
					liveChannelId,
					metric: "HEARTBEAT_STALE",
					windowPolls: 2,
				},
			});
			const cancelAtChannel = barrier();
			const releaseCancelRun = barrier();
			const alertAtRun = barrier();
			const releaseAlertChannel = barrier();
			// The Web cancel-start transition claims the channel before updating
			// its retained latest run, including when the channel is RUNNING.
			const cancellation = tenant.$transaction(
				async (tx) => {
					const current = await tx.liveChannel.findUnique({
						where: { id: liveChannelId },
					});
					const latest = await tx.liveChannelRun.findFirst({
						where: { liveChannelId },
						orderBy: { seq: "desc" },
					});
					if (current?.status !== "RUNNING" || latest?.id !== runId)
						throw new Error("Test cancellation changed");
					const claimed = await tx.liveChannel.updateMany({
						where: {
							id: liveChannelId,
							status: current.status,
							liveEffectFenceVersion: current.liveEffectFenceVersion,
						},
						data: { status: "STOPPING" },
					});
					if (claimed.count !== 1)
						throw new Error("Test cancellation claim lost");
					cancelAtChannel.release();
					await releaseCancelRun.ready;
					await tx.liveChannelRun.update({
						where: { id: latest.id },
						data: { cancelRequested: true, status: "STOPPING" },
					});
					return latest.id;
				},
				{ maxWait: 5_000, timeout: 10_000 },
			);
			const cancelResult = Promise.allSettled([cancellation]);
			let alertResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
			const emitEvent = vi.fn(async () => {});
			try {
				await Promise.race([
					cancelAtChannel.ready,
					cancelResult.then((result) => {
						throw new Error("Cancellation settled before its channel barrier", {
							cause: result,
						});
					}),
				]);
				const alertClient = instrumentTransactions(
					tenant,
					async (tx) =>
						new Proxy(tx, {
							get(target, key) {
								if (key === "liveChannelRun")
									return new Proxy(target.liveChannelRun, {
										get(delegate, method) {
											if (method === "updateMany")
												return async (
													...args: Parameters<typeof delegate.updateMany>
												) => {
													const result = await delegate.updateMany(...args);
													alertAtRun.release();
													await releaseAlertChannel.ready;
													return result;
												};
											return Reflect.get(delegate, method);
										},
									});
								return Reflect.get(target, key);
							},
						}),
				);
				const engine = createAlertEngine({
					prisma: alertClient,
					now: () => now,
					sweepIntervalMs: 30_000,
					emitEvent,
				});
				const evaluate = () =>
					engine(
						liveChannelId,
						"RUNNING",
						createdAt.toISOString(),
						{ programStartAt: null, programEndAt: null },
						{ id: runId, createdAt },
						{ runId, encodingId, epoch: 7 },
					);
				alertResult = Promise.allSettled([evaluate()]);
				await Promise.race([
					alertAtRun.ready,
					alertResult.then((result) => {
						throw new Error("Alert settled before its run barrier", {
							cause: result,
						});
					}),
				]);
				releaseAlertChannel.release();
				releaseCancelRun.release();
				expect(await alertResult).toEqual([
					{ status: "fulfilled", value: { opened: 0, resolved: 0 } },
				]);
				expect(await cancelResult).toEqual([
					{ status: "fulfilled", value: runId },
				]);
				expect(
					(
						await tenant.liveChannel.findUnique({
							where: { id: liveChannelId },
						})
					)?.status,
				).toBe("STOPPING");
				expect(
					await tenant.liveChannelRun.findUnique({
						where: { id: runId },
						select: { status: true, cancelRequested: true },
					}),
				).toEqual({ status: "STOPPING", cancelRequested: true });
				// A stale caller must also lose after the transition commits.
				await expect(evaluate()).resolves.toEqual({ opened: 0, resolved: 0 });
				await tenant.liveChannel.update({
					where: { id: liveChannelId },
					data: {
						status: "RUNNING",
						bitmovinEncodingId: `new-${encodingId}`,
					},
				});
				await expect(evaluate()).resolves.toEqual({ opened: 0, resolved: 0 });
				await tenant.liveChannelRun.update({
					where: { id: runId },
					data: { status: "STOPPED" },
				});
				await tenant.liveChannelRun.create({
					data: {
						liveChannelId,
						seq: 2,
						status: "RUNNING",
						outputPrefix: "",
						createdAt: now,
						bitmovinEncodingId: `new-${encodingId}`,
					},
				});
				await tenant.liveChannel.update({
					where: { id: liveChannelId },
					data: { bitmovinEncodingId: encodingId },
				});
				await expect(evaluate()).resolves.toEqual({ opened: 0, resolved: 0 });
				expect(
					await tenant.alertEvent.count({ where: { liveChannelId } }),
				).toBe(0);
				expect(emitEvent).not.toHaveBeenCalled();
			} finally {
				releaseAlertChannel.release();
				releaseCancelRun.release();
				await alertResult;
				await cancelResult;
			}
		}, 15_000);
	},
);
