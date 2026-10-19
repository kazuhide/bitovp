import { randomUUID } from "node:crypto";
import type { LiveToVodRecord } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	appendLiveEffectStepLogEntry,
	createPrismaClient,
	createTenantPrismaClient,
	type LiveChannelStatus,
	persistLiveToVodAttempt,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeSdk } from "../orchestrator/fake-sdk";
import {
	createProviderLifecycleReconciler,
	type RunLifecycleRow,
} from "./provider-lifecycle";

const runtimeUrl = process.env.BITOVP_MONITORING_TEST_DATABASE_URL;
const adminUrl = process.env.BITOVP_MONITORING_TEST_ADMIN_URL;

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

function instrumentTransactions(
	base: AppPrismaClient,
	decorate: (tx: AppTransactionClient) => Promise<AppTransactionClient>,
): AppPrismaClient {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return (fn: (tx: AppTransactionClient) => Promise<unknown>) =>
					target.$transaction(async (tx) => fn(await decorate(tx)), {
						maxWait: 5_000,
						timeout: 10_000,
					});
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function backendPid(tx: AppTransactionClient) {
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
	throw new Error("Owned finalizer did not wait for the channel owner");
}

async function reach(gate: Promise<void>, settled: Promise<unknown>) {
	await Promise.race([
		gate,
		settled.then((result) => {
			throw new Error("Transaction settled before its barrier", {
				cause: result,
			});
		}),
	]);
}

describe.runIf(Boolean(runtimeUrl && adminUrl))(
	"real PostgreSQL owned Live transition lock ordering",
	() => {
		const organizationIds: [string, string] = [randomUUID(), randomUUID()];
		const now = new Date("2026-10-19T00:00:00Z");
		const lease = new Date(now.getTime() - 30_000);
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let tenant: AppPrismaClient;
		let otherTenant: AppPrismaClient;

		beforeAll(async () => {
			for (const value of [runtimeUrl, adminUrl]) {
				if (
					!value ||
					!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
				)
					throw new Error(
						"Owned transition tests require dedicated loopback PostgreSQL URLs",
					);
			}
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			tenant = createTenantPrismaClient(runtime, organizationIds[0]);
			otherTenant = createTenantPrismaClient(runtime, organizationIds[1]);
			for (const id of organizationIds)
				await admin.organization.create({
					data: { id, name: "Owned transition lock test", slug: `test-${id}` },
				});
		});

		afterAll(async () => {
			try {
				if (admin) {
					await admin.liveChannel.deleteMany({
						where: { organizationId: { in: organizationIds } },
					});
					await admin.organization.deleteMany({
						where: { id: { in: organizationIds } },
					});
				}
			} finally {
				if (runtime) await runtime.$disconnect();
				if (admin) await admin.$disconnect();
			}
		});

		async function fixture(
			status: LiveChannelStatus = "PROVISIONING",
			heldAt: Date | null = lease,
		) {
			const encodingId = `test-${randomUUID()}`;
			const channel = await tenant.liveChannel.create({
				data: {
					name: "Owned transition lock test",
					status,
					plan: {},
					bitmovinEncodingId: encodingId,
					provisionClaimedAt: heldAt,
				},
			});
			const run = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status,
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
					heartbeatPollEpoch: 7,
				},
			});
			return { channel, run, encodingId };
		}

		function reconciler(prisma = tenant) {
			const emitChannel = vi.fn(async () => {});
			const enqueueFeederJob = vi.fn(async () => {});
			return {
				door: createProviderLifecycleReconciler({
					prisma,
					now: () => now.toISOString(),
					emitChannel,
					enqueueFeederJob,
				}),
				emitChannel,
				enqueueFeederJob,
			};
		}

		function running(
			door: ReturnType<typeof reconciler>["door"],
			f: Awaited<ReturnType<typeof fixture>>,
			heldAt = f.channel.provisionClaimedAt,
		) {
			return door.commitRunning({
				channel: f.channel,
				run: f.run,
				encodingId: f.encodingId,
				observation: {
					ok: true,
					status: "RUNNING",
					observedAt: now.toISOString(),
				},
				coordinates: { streamKey: "synthetic-key", encoderIp: "192.0.2.1" },
				provisionClaimedAt: heldAt,
			});
		}

		function terminal(
			door: ReturnType<typeof reconciler>["door"],
			f: Awaited<ReturnType<typeof fixture>>,
			run: RunLifecycleRow = f.run,
		) {
			return door.reconcile({
				channel: f.channel,
				run,
				encodingId: f.encodingId,
				sdk: fakeSdk(),
				observation: {
					ok: true,
					status: "ERROR",
					observedAt: now.toISOString(),
				},
				channelWrite: {
					where: { provisionClaimedAt: f.channel.provisionClaimedAt },
				},
			});
		}

		it.each([
			"provision",
			"restart",
		] as const)("lets cancel-start win over %s RUNNING finalization without a deadlock", async (kind) => {
			const f = await fixture(
				"PROVISIONING",
				kind === "provision" ? lease : null,
			);
			const writerAtChannel = barrier();
			const releaseWriterRun = barrier();
			let writerPid = 0;
			let finalizerPid = 0;
			const finalizerStarted = barrier();
			const writer = Promise.allSettled([
				tenant.$transaction(
					async (tx) => {
						writerPid = await backendPid(tx);
						const claimed = await tx.liveChannel.updateMany({
							where: {
								id: f.channel.id,
								status: "PROVISIONING",
								liveEffectFenceVersion: f.channel.liveEffectFenceVersion,
							},
							data: { status: "STOPPING" },
						});
						if (claimed.count !== 1) throw new Error("Cancellation claim lost");
						writerAtChannel.release();
						await releaseWriterRun.ready;
						await tx.liveChannelRun.update({
							where: { id: f.run.id },
							data: { status: "STOPPING", cancelRequested: true },
						});
						return f.run.id;
					},
					{ maxWait: 5_000, timeout: 10_000 },
				),
			]);
			let finalizer: Promise<PromiseSettledResult<boolean>[]> | undefined;
			try {
				await reach(writerAtChannel.ready, writer);
				const client = instrumentTransactions(tenant, async (tx) => {
					finalizerPid = await backendPid(tx);
					finalizerStarted.release();
					return tx;
				});
				finalizer = Promise.allSettled([running(reconciler(client).door, f)]);
				await reach(finalizerStarted.ready, finalizer);
				await waitForBlockedBy(admin, finalizerPid, writerPid);
				releaseWriterRun.release();
				expect(await writer).toEqual([
					{ status: "fulfilled", value: f.run.id },
				]);
				expect(await finalizer).toEqual([
					{ status: "fulfilled", value: false },
				]);
				expect(
					await tenant.liveChannelRun.findUnique({
						where: { id: f.run.id },
						select: {
							status: true,
							cancelRequested: true,
							providerStatus: true,
						},
					}),
				).toEqual({
					status: "STOPPING",
					cancelRequested: true,
					providerStatus: null,
				});
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).status,
				).toBe("STOPPING");
			} finally {
				releaseWriterRun.release();
				await writer;
				await finalizer;
			}
		}, 15_000);

		it("serializes an unfenced terminal observation after a channel-first revive", async () => {
			const f = await fixture("ERROR");
			const writerAtChannel = barrier();
			const releaseWriterRun = barrier();
			const finalizerStarted = barrier();
			let writerPid = 0;
			let finalizerPid = 0;
			const writer = Promise.allSettled([
				tenant.$transaction(
					async (tx) => {
						writerPid = await backendPid(tx);
						const claimed = await tx.liveChannel.updateMany({
							where: {
								id: f.channel.id,
								status: "ERROR",
								liveEffectFenceVersion: f.channel.liveEffectFenceVersion,
								runs: {
									none: { cancelRequested: true, status: { not: "STOPPED" } },
								},
								effectClaims: {
									none: {
										state: { in: ["CLAIMED", "DISPATCHING", "AMBIGUOUS"] },
									},
								},
							},
							data: {
								status: "PROVISIONING",
								provisionClaimedAt: null,
								liveEffectFenceVersion: { increment: 1 },
							},
						});
						if (claimed.count !== 1) throw new Error("Revive claim lost");
						writerAtChannel.release();
						await releaseWriterRun.ready;
						await tx.liveChannelRun.update({
							where: { id: f.run.id },
							data: { status: "PROVISIONING", error: null, endedAt: null },
						});
						return true;
					},
					{ maxWait: 5_000, timeout: 10_000 },
				),
			]);
			let finalizer: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await reach(writerAtChannel.ready, writer);
				const client = instrumentTransactions(tenant, async (tx) => {
					finalizerPid = await backendPid(tx);
					finalizerStarted.release();
					return tx;
				});
				const h = reconciler(client);
				finalizer = Promise.allSettled([terminal(h.door, f)]);
				await reach(finalizerStarted.ready, finalizer);
				await waitForBlockedBy(admin, finalizerPid, writerPid);
				releaseWriterRun.release();
				expect(await writer).toEqual([{ status: "fulfilled", value: true }]);
				const [outcome] = await finalizer;
				expect(outcome?.status).toBe("fulfilled");
				if (outcome?.status === "fulfilled")
					expect(outcome.value).toMatchObject({
						landed: true,
						channelLanded: false,
					});
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).status,
				).toBe("PROVISIONING");
				expect(
					(
						await tenant.liveChannelRun.findUniqueOrThrow({
							where: { id: f.run.id },
						})
					).providerTerminalAt,
				).toEqual(now);
				expect(h.emitChannel).not.toHaveBeenCalled();
			} finally {
				releaseWriterRun.release();
				await writer;
				await finalizer;
			}
		}, 15_000);

		it("serializes unfenced terminalization with actual Live-to-VOD persistence", async () => {
			const f = await fixture("RUNNING", null);
			const attemptId = randomUUID();
			const record: LiveToVodRecord = {
				status: "RUNNING",
				attemptId,
				revision: 0,
				queueJobId: "synthetic-job",
				liveChannelRunId: f.run.id,
				manifests: [],
				families: [{ type: "HLS", status: "PENDING" }],
			};
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveToVod: record },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { liveToVod: record },
			});
			const writerAtChannel = barrier();
			const releaseWriterRun = barrier();
			const finalizerStarted = barrier();
			let writerPid = 0;
			let finalizerPid = 0;
			const client = instrumentTransactions(tenant, async (tx) => {
				writerPid = await backendPid(tx);
				return new Proxy(tx, {
					get(target, key) {
						if (key === "liveChannel")
							return new Proxy(target.liveChannel, {
								get(delegate, method) {
									if (method === "updateMany")
										return async (
											...args: Parameters<typeof delegate.updateMany>
										) => {
											const result = await delegate.updateMany(...args);
											writerAtChannel.release();
											await releaseWriterRun.ready;
											return result;
										};
									return Reflect.get(delegate, method);
								},
							});
						return Reflect.get(target, key);
					},
				});
			});
			const writer = Promise.allSettled([
				persistLiveToVodAttempt(client, {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					encodingId: f.encodingId,
					attemptId,
					expectedRevision: 0,
					record,
				}),
			]);
			let finalizer: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await reach(writerAtChannel.ready, writer);
				const finalizerClient = instrumentTransactions(tenant, async (tx) => {
					finalizerPid = await backendPid(tx);
					finalizerStarted.release();
					return tx;
				});
				finalizer = Promise.allSettled([
					terminal(reconciler(finalizerClient).door, f),
				]);
				await reach(finalizerStarted.ready, finalizer);
				await waitForBlockedBy(admin, finalizerPid, writerPid);
				releaseWriterRun.release();
				expect((await writer)[0]?.status).toBe("fulfilled");
				const [outcome] = await finalizer;
				expect(outcome?.status).toBe("fulfilled");
				if (outcome?.status === "fulfilled")
					expect(outcome.value).toMatchObject({
						landed: true,
						channelLanded: true,
					});
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).liveToVod,
				).toMatchObject({ revision: 1 });
				expect(
					(
						await tenant.liveChannelRun.findUniqueOrThrow({
							where: { id: f.run.id },
						})
					).liveToVod,
				).toMatchObject({ revision: 1 });
			} finally {
				releaseWriterRun.release();
				await writer;
				await finalizer;
			}
		}, 15_000);

		it.each([
			lease,
			null,
		])("commits valid owned RUNNING state with provision lease %s", async (heldAt) => {
			const f = await fixture("PROVISIONING", heldAt);
			expect(await running(reconciler().door, f)).toBe(true);
			expect(
				await tenant.liveChannel.findUnique({
					where: { id: f.channel.id },
					select: { status: true, provisionClaimedAt: true },
				}),
			).toEqual({ status: "RUNNING", provisionClaimedAt: null });
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).status,
			).toBe("RUNNING");
		});

		it("serializes actual effect evidence append with owned terminalization", async () => {
			const f = await fixture("RUNNING", null);
			const claim = {
				id: randomUUID(),
				idempotencyKey: `synthetic:${randomUUID()}`,
				token: randomUUID(),
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				action: "SCTE35" as const,
				generation: f.channel.liveEffectFenceVersion,
				expiresAt: new Date(now.getTime() + 60_000),
			};
			await tenant.liveEffectClaim.create({
				data: { ...claim, state: "DISPATCHING", ownerId: "synthetic-owner" },
			});
			const entry = {
				step: "synthetic-cue",
				kind: "SCTE35_CUE" as const,
				payload: { providerEntryId: "synthetic-cue-id" },
				refs: {},
				status: "DONE" as const,
			};
			const appendAtRun = barrier();
			const releaseAppend = barrier();
			const finalizerStarted = barrier();
			let appendPid = 0;
			let finalizerPid = 0;
			const appendClient = instrumentTransactions(tenant, async (tx) => {
				appendPid = await backendPid(tx);
				return new Proxy(tx, {
					get(target, key) {
						if (key === "$executeRaw")
							return async (
								sql: TemplateStringsArray,
								...values: unknown[]
							) => {
								const result = await target.$executeRaw(sql, ...values);
								if (sql.join("?").includes('UPDATE "LiveChannelRun"')) {
									appendAtRun.release();
									await releaseAppend.ready;
								}
								return result;
							};
						return Reflect.get(target, key);
					},
				});
			});
			const append = Promise.allSettled([
				appendLiveEffectStepLogEntry(appendClient, claim, entry),
			]);
			let finalizer: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await reach(appendAtRun.ready, append);
				const finalizerClient = instrumentTransactions(tenant, async (tx) => {
					finalizerPid = await backendPid(tx);
					finalizerStarted.release();
					return tx;
				});
				finalizer = Promise.allSettled([
					terminal(reconciler(finalizerClient).door, f),
				]);
				await reach(finalizerStarted.ready, finalizer);
				await waitForBlockedBy(admin, finalizerPid, appendPid);
				releaseAppend.release();
				expect(await append).toEqual([
					{ status: "fulfilled", value: { runUpdated: 1, channelUpdated: 1 } },
				]);
				expect((await finalizer)[0]?.status).toBe("fulfilled");
				expect(
					(
						await tenant.liveChannelRun.findUniqueOrThrow({
							where: { id: f.run.id },
						})
					).stepLog,
				).toEqual([entry]);
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).stepLog,
				).toEqual([entry]);
				const lateEntry = { ...entry, step: "late-synthetic-cue" };
				expect(
					await appendLiveEffectStepLogEntry(otherTenant, claim, lateEntry),
				).toEqual({ runUpdated: 0, channelUpdated: 0 });
				expect(
					await appendLiveEffectStepLogEntry(tenant, claim, lateEntry),
				).toEqual({ runUpdated: 1, channelUpdated: 0 });
				expect(
					(
						await tenant.liveChannelRun.findUniqueOrThrow({
							where: { id: f.run.id },
						})
					).stepLog,
				).toEqual([entry, lateEntry]);
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).stepLog,
				).toEqual([entry]);
			} finally {
				releaseAppend.release();
				await append;
				await finalizer;
			}
		}, 15_000);

		it("rejects stale lease, run, encoding, latest run and foreign tenant without partial RUNNING writes", async () => {
			for (const stale of [
				"lease",
				"run",
				"encoding",
				"latest run",
				"tenant",
			] as const) {
				const f = await fixture();
				if (stale === "lease")
					await tenant.liveChannel.update({
						where: { id: f.channel.id },
						data: { provisionClaimedAt: new Date(now.getTime() + 1_000) },
					});
				if (stale === "run") f.run.id = randomUUID();
				if (stale === "encoding") {
					await tenant.liveChannel.update({
						where: { id: f.channel.id },
						data: { bitmovinEncodingId: `new-${f.encodingId}` },
					});
					await tenant.liveChannelRun.update({
						where: { id: f.run.id },
						data: { bitmovinEncodingId: `new-${f.encodingId}` },
					});
				}
				if (stale === "latest run") {
					await tenant.liveChannelRun.update({
						where: { id: f.run.id },
						data: { status: "ERROR" },
					});
					await tenant.liveChannelRun.create({
						data: {
							liveChannelId: f.channel.id,
							seq: 2,
							status: "PROVISIONING",
							outputPrefix: "",
						},
					});
				}
				const before = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				});
				const beforeRuns = await tenant.liveChannelRun.findMany({
					where: { liveChannelId: f.channel.id },
					orderBy: { seq: "asc" },
				});
				expect(
					await running(
						reconciler(stale === "tenant" ? otherTenant : tenant).door,
						f,
					),
				).toBe(false);
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toEqual(before);
				expect(
					await tenant.liveChannelRun.findMany({
						where: { liveChannelId: f.channel.id },
						orderBy: { seq: "asc" },
					}),
				).toEqual(beforeRuns);
			}
		});

		it("retains an old run's terminal fact and queues only its feeders after a re-air", async () => {
			const f = await fixture("ERROR", null);
			const currentEncoding = `new-${f.encodingId}`;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "RUNNING", bitmovinEncodingId: currentEncoding },
			});
			const currentRun = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: currentEncoding,
					outputPrefix: "",
				},
			});
			const feeders = [];
			for (const run of [f.run, currentRun])
				feeders.push(
					await tenant.feederSession.create({
						data: {
							liveChannelId: f.channel.id,
							liveChannelRunId: run.id,
							status: "CREATED",
							commitAt: now,
							sourceCredentialId: randomUUID(),
							sourceBucket: "synthetic",
							sourceKey: "fixture.mp4",
							protocol: "RTMP",
							target: {},
						},
					}),
				);
			const before = await tenant.liveChannel.findUniqueOrThrow({
				where: { id: f.channel.id },
			});
			const h = reconciler();
			expect(await terminal(reconciler(otherTenant).door, f)).toMatchObject({
				landed: false,
				channelLanded: false,
			});
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).providerTerminalAt,
			).toBeNull();
			expect(await terminal(h.door, f)).toMatchObject({
				landed: true,
				channelLanded: false,
			});
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toEqual(before);
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: currentRun.id },
					})
				).providerTerminalAt,
			).toBeNull();
			expect(h.enqueueFeederJob).toHaveBeenCalledExactlyOnceWith({
				feederSessionId: feeders[0]?.id,
				action: "stop",
			});
			expect(h.emitChannel).not.toHaveBeenCalled();
		});
	},
);
