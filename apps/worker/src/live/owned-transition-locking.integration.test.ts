import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	compileLiveChannel,
	initStepLog,
	type LiveToVodRecord,
	liveAutoShutdownUpdateReceiptSchema,
	productEventSchema,
	readLiveAutoShutdownUpdate,
	type StepLogEntry,
} from "@bitovp/core";
import { AisaLiveError } from "@bitovp/core/aisa-live-client";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	appendLiveEffectStepLogEntry,
	archivedStopRevision,
	beginLiveEffect,
	bindArchivedStopTarget,
	claimLiveStopSend,
	createPrismaClient,
	createTenantPrismaClient,
	type LiveChannelStatus,
	liveEffectSendUncertainty,
	markLiveEffectAmbiguous,
	persistLiveToVodAttempt,
	readLockedLiveStartState,
	recordLiveStopFailure,
	resolveLiveEffectsAfterConfirmedStop,
} from "@bitovp/db";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNotifyProcessor } from "../notify/processor";
import { createAisaLiveOps } from "../orchestrator/aisa-live-ops";
import { fakeSdk } from "../orchestrator/fake-sdk";
import {
	createLiveChannelProcessor,
	type LiveChannelDeps,
} from "../orchestrator/live-processor";
import { recordScheduleOutcome } from "../scheduler/schedule-outcome";
import { createScheduleSweep } from "../scheduler/sweep";
import { admitInactiveOrganization } from "../tenant/admission";
import { createTenantConsumer } from "../tenant/consumer";
import {
	createExpiredRestartReconciler,
	recordDeadJobScheduleOutcomes,
	recordFinalRestartFailure,
	recordFinalStopFailure,
} from "./dead-job-outcome";
import { createExhaustedLegacyStopRecovery } from "./exhausted-legacy-stops";
import { requestProbeStop } from "./probe-runner";
import {
	createProviderLifecycleReconciler,
	type RunLifecycleRow,
} from "./provider-lifecycle";
import { commitProvisionEnd } from "./provision-outcome";
import { resolveProvisionAdmission } from "./provision-admission";
import {
	createStrandedRunReconciler,
	recordExpiredProvisionFailure,
	STRANDED_RUN_ERROR,
} from "./reconcile-stranded-runs";
import { createUncertainStopReconciler } from "./reconcile-uncertain-stops";
import { createStopNotificationSweep } from "./stop-notifications";

const provider = vi.hoisted(() => ({ aisa: vi.fn() }));
vi.mock("@bitovp/core/aisa-live-client", async (original) => ({
	...(await original<typeof import("@bitovp/core/aisa-live-client")>()),
	createAisaLiveClient: provider.aisa,
}));
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
					await admin.bitmovinAccount.deleteMany({
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
			encodingId: string = `test-${randomUUID()}`,
		) {
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

		it.each([
			"CANCELED",
			"RUNNING",
		] as const)("a RESTART preflight returning %s and its failed callback both yield to the exact STOP owner", async (status) => {
			const f = await fixture("PROVISIONING", null);
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			plan.bitmovin.accountId = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan },
			});
			const reading = barrier();
			const reply = barrier();
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(async () => {
					reading.release();
					await reply.ready;
					return { status };
				}),
			});
			const emitEvent = vi.fn(async () => {});
			const enqueueFeederJob = vi.fn(async () => {});
			const process = createLiveChannelProcessor({
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => sdk,
				sleep: async () => {},
				pollIntervalMs: 10,
				pollTimeoutMs: 250,
				enqueueFeederJob,
				emitEvent,
				resolveCredential: async () => {
					throw new Error("no storage credential required");
				},
				revealBitmovinAccount: async () => ({
					apiKey: "offline",
					tenantOrgId: null,
				}),
			});
			const effect = {
				idempotencyKey: `manual:restart:${randomUUID()}`,
				action: "RESTART" as const,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				admissionFenceVersion: 0,
			};
			const job = { liveChannelId: f.channel.id, action: "restart", effect };
			const processing = Promise.allSettled([process(job)]);
			try {
				await reach(reading.ready, processing);
				// A duplicate provision delivery while RESTART owns the run must
				// return before creating an SDK or changing the null lease.
				expect(
					await process({ liveChannelId: f.channel.id, action: "provision" }),
				).toMatchObject({ status: "PROVISIONING" });
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({
					provisionClaimedAt: null,
					liveEffectFenceVersion: 1,
				});
				expect(sdk.createEncoding).not.toHaveBeenCalled();
				const stop = await beginLiveEffect(tenant, {
					idempotencyKey: `manual:stop:${f.channel.id}:${f.run.id}`,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					action: "STOP",
					expectedFenceVersion: 0,
					supersedeOpen: true,
					allowedChannelStatuses: ["RUNNING"],
					ownerId: "stop-owner",
					now,
					expiresAt: new Date(now.getTime() + 60_000),
				});
				expect(stop.kind).toBe("EXECUTE");
				const channel = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				});
				const run = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				expect(channel).toMatchObject({
					status: "STOPPING",
					liveEffectFenceVersion: 2,
				});
				reply.release();
				expect((await processing)[0]?.status).toBe("rejected");
				expect(
					await recordExpiredProvisionFailure(
						tenant,
						f.channel.id,
						"delayed provision failure",
						now,
						now,
						{ runId: f.run.id },
					),
				).toBe(false);
				expect(
					await recordFinalRestartFailure(
						tenant,
						{ data: job, attemptsMade: 3, opts: { attempts: 3 } },
						"restart failed",
						now,
						emitEvent,
					),
				).toBe(false);
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: channel.id },
					}),
				).toEqual(channel);
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: run.id },
					}),
				).toEqual(run);
				expect(sdk.getEncodingStatus).toHaveBeenCalledOnce();
				expect(sdk.restartLiveEncoding).not.toHaveBeenCalled();
				expect(emitEvent).not.toHaveBeenCalled();
				expect(enqueueFeederJob).not.toHaveBeenCalled();
			} finally {
				reply.release();
				await processing;
			}
		}, 15_000);

		it("retires a stranded RESTART admission only on final delivery and only once", async () => {
			const f = await fixture("PROVISIONING", null);
			const data = {
				liveChannelId: f.channel.id,
				action: "restart",
				effect: {
					idempotencyKey: `manual:restart:${randomUUID()}`,
					action: "RESTART",
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					admissionFenceVersion: 0,
				},
			};
			const job = { data, attemptsMade: 1, opts: { attempts: 2 } };
			const emit = vi.fn(async () => {});
			expect(
				await recordFinalRestartFailure(
					tenant,
					job,
					"restart failed",
					now,
					emit,
				),
			).toBe(false);
			expect(emit).not.toHaveBeenCalled();
			job.attemptsMade = 2;
			// Provisioning may claim the same channel, run, encoder and generation
			// while the queue-failure callback waits. Its token is its write authority.
			for (const token of [
				now,
				new Date(now.getTime() - 24 * 60 * 60 * 1000),
			]) {
				const leased = await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { provisionClaimedAt: token },
				});
				const previousRun = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				expect(
					await beginLiveEffect(tenant, {
						...data.effect,
						action: "RESTART",
						liveChannelId: f.channel.id,
						expectedFenceVersion: 0,
						ownerId: "delayed",
						now,
						expiresAt: new Date(now.getTime() + 60000),
					}),
				).toMatchObject({ kind: "STALE" });
				expect(
					await recordFinalRestartFailure(
						tenant,
						job,
						"restart failed",
						now,
						emit,
					),
				).toBe(false);
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toEqual(leased);
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					}),
				).toEqual(previousRun);
			}
			expect(emit).not.toHaveBeenCalled();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { provisionClaimedAt: null },
			});

			expect(
				await recordFinalRestartFailure(
					tenant,
					job,
					"restart failed",
					now,
					emit,
				),
			).toBe(true);
			expect(
				await recordFinalRestartFailure(tenant, job, "late failure", now, emit),
			).toBe(false);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "CHANNEL_ERROR",
					liveChannelId: f.channel.id,
					error: "restart failed",
				}),
				now,
			);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "ERROR",
				error: "restart failed",
				provisionClaimedAt: null,
			});
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				status: "ERROR",
				error: "restart failed",
				endedAt: now,
			});
		});

		it("suppresses an inactive RESTART only for its own undispatched airing and generation", async () => {
			const f = await fixture("PROVISIONING", lease);
			const old = await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPED" },
			});
			const successor = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "PROVISIONING",
					bitmovinEncodingId: "successor",
					outputPrefix: "",
				},
			});
			const channel = await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					bitmovinEncodingId: "successor",
					liveEffectFenceVersion: 1,
					stepLog: [{ kind: "START_LIVE_ENCODING", status: "DONE" }],
				},
			});
			const handler = vi.fn(async () => ({}));
			const consume = createTenantConsumer({
				prisma: tenant,
				forEachOrganization: async () => {},
				isOrganizationActive: async () => false,
			})("liveChannel", handler);
			const deliver = (runId: string, encodingId: string, generation: number) =>
				consume({
					data: {
						organizationId: organizationIds[0],
						payload: {
							liveChannelId: channel.id,
							action: "restart",
							effect: {
								action: "RESTART",
								idempotencyKey: "manual:restart:" + randomUUID(),
								liveChannelRunId: runId,
								providerEncodingId: encodingId,
								admissionFenceVersion: generation,
							},
						},
					},
				} as Job);
			await expect(deliver(old.id, f.encodingId, 0)).rejects.toThrow(
				"Organization is inactive",
			);
			await expect(deliver(successor.id, "successor", 0)).rejects.toThrow(
				"Organization is inactive",
			);
			await expect(deliver(successor.id, "successor", 1)).rejects.toThrow(
				"Organization is inactive",
			);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: channel.id },
				}),
			).toEqual(channel);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: successor.id },
				}),
			).toEqual(successor);
			await tenant.liveChannel.update({
				where: { id: channel.id },
				data: { provisionClaimedAt: null },
			});
			await expect(deliver(successor.id, "successor", 1)).rejects.toThrow(
				"Organization is inactive",
			);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: channel.id },
				}),
			).toMatchObject({ status: "ERROR" });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: successor.id },
				}),
			).toMatchObject({ status: "ERROR" });
			expect(handler).not.toHaveBeenCalled();
		});

		it("a heartbeat verifies the whole rental, commits one notification and retires a queued manual STOP", async () => {
			const f = await fixture("RUNNING", null);
			const accountId = randomUUID();
			const previous = "retained-" + randomUUID();
			const channel = await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan: { bitmovin: { accountId } } },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					previousProviderEncodingIds: [previous],
					archivedRtmpAttempt: 1,
				},
			});
			const h = reconciler();
			let archivedStatus: "RUNNING" | "FINISHED" = "RUNNING";
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(async (id: string) => ({
					status: id === previous ? archivedStatus : "FINISHED",
				})),
			});
			const tick = async () =>
				h.door.reconcile({
					channel,
					run: await h.door.loadCurrentRun(channel.id),
					encodingId: f.encodingId,
					sdk,
					fence: { epoch: 7 },
				});
			expect(await tick()).toMatchObject({
				lifecycle: "UNKNOWN",
				channelLanded: false,
			});
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: channel.id },
				}),
			).toMatchObject({ status: "RUNNING" });
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			archivedStatus = "FINISHED";
			expect(await tick()).toMatchObject({
				lifecycle: "TERMINAL",
				channelLanded: true,
			});
			const run = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(run).toMatchObject({
				status: "STOPPED",
				providerStatus: "FINISHED",
				stopNotificationKind: "CHANNEL_STOPPED",
				stopNotificationAt: now,
				stopNotificationState: "PENDING",
				rtmpRetirementEvidence: [
					{
						accountId,
						encodingId: previous,
						disposition: "TERMINAL",
						providerStatus: "FINISHED",
					},
				],
			});
			const effect = await beginLiveEffect(tenant, {
				liveChannelId: channel.id,
				liveChannelRunId: run.id,
				providerEncodingId: f.encodingId,
				idempotencyKey: "manual:stop:" + run.id,
				ownerId: "delayed-queued-job",
				expectedFenceVersion: 0,
				action: "STOP",
				supersedeOpen: true,
				allowedChannelStatuses: ["RUNNING", "STOPPED"],
				now,
				expiresAt: new Date(now.getTime() + 60_000),
			});
			expect(effect.kind).toBe("STALE");
			expect(
				await tenant.liveEffectClaim.count({
					where: { liveChannelRunId: run.id },
				}),
			).toBe(0);
			expect(
				await tenant.liveStopNotification.findMany({ where: { id: run.id } }),
			).toMatchObject([
				{ channelId: channel.id, kind: "CHANNEL_STOPPED", occurredAt: now },
			]);
			expect(h.emitChannel).not.toHaveBeenCalled();
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});

		it.each([
			"channel-log",
			"run-log",
			"effect-history",
			"late-log",
		] as const)("refuses passive completion until the second encoder in %s terminates", async (source) => {
			const f = await dispatchFixture();
			const secondary = `second-${randomUUID()}`;
			const stepLog = [
				{
					kind: "CREATE_ENCODING",
					step: "old",
					status: "DONE",
					resourceId: secondary,
					refs: {},
					payload: {},
				},
			];
			const addLog = () =>
				tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { stepLog },
				});
			if (source === "channel-log") await addLog();
			if (source === "run-log")
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: { stepLog },
				});
			if (source === "effect-history")
				await tenant.liveEffectClaim.create({
					data: {
						action: "RESTART",
						state: "FAILED",
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						providerEncodingId: secondary,
						ownerId: "previous",
						generation: 0,
						token: randomUUID(),
						idempotencyKey: randomUUID(),
						expiresAt: now,
					},
				});
			let finished = false;
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(async (id: string) => {
					if (source === "late-log" && id === f.encodingId && !finished)
						await addLog();
					return {
						status: id === secondary && !finished ? "RUNNING" : "FINISHED",
					};
				}),
			});
			const h = reconciler().door;
			const tick = async () =>
				h.reconcile({
					channel: await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
					run: await h.loadCurrentRun(f.channel.id),
					encodingId: f.encodingId,
					sdk,
					fence: { epoch: 7 },
				});
			expect((await tick()).channelLanded).toBe(false);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			finished = true;
			expect((await tick()).channelLanded).toBe(true);
			expect(sdk.getEncodingStatus).toHaveBeenCalledWith(secondary);
		});
		it.each([
			true,
			false,
		])("keeps the airing open until the publishing feeder exits (run bound=%s)", async (bound) => {
			const f = await dispatchFixture();
			const feeder = await tenant.feederSession.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: bound ? f.run.id : null,
					sourceCredentialId: randomUUID(),
					sourceBucket: "fixture",
					sourceKey: "fixture.mp4",
					protocol: "RTMP",
					target: {},
					status: "PUSHING",
				},
			});
			const h = reconciler();
			const tick = async () =>
				h.door.reconcile({
					channel: await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
					run: await h.door.loadCurrentRun(f.channel.id),
					encodingId: f.encodingId,
					sdk: f.sdk,
					fence: { epoch: 7 },
				});
			expect((await tick()).channelLanded).toBe(false);
			expect(h.enqueueFeederJob).toHaveBeenCalledWith({
				feederSessionId: feeder.id,
				action: "stop",
			});
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "RUNNING" });
			await tenant.feederSession.delete({ where: { id: feeder.id } });
			expect((await tick()).channelLanded).toBe(true);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(1);
		});
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

		it("snapshots only pending upgrade generations across tenant-scoped START and STOP histories", async () => {
			const pending = await fixture("PROVISIONING", null);
			const stopped = await fixture("STOPPED", null);
			const other = await otherTenant.liveChannel.create({
				data: {
					name: "other org pending STOP",
					plan: {},
					status: "STOPPING",
					liveEffectFenceVersion: 8,
				},
			});
			const migration = readFileSync(
				new URL(
					"../../../../packages/db/prisma/migrations/20261125133000_live_start_admission/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			const bootstrap = migration.slice(migration.indexOf("DO $$"));
			await admin.$executeRawUnsafe(bootstrap);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: pending.channel.id },
					})
				).legacyAdmissionFenceVersion,
			).toBe(0);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: stopped.channel.id },
					})
				).legacyAdmissionFenceVersion,
			).toBeNull();
			expect(
				(
					await otherTenant.liveChannel.findUniqueOrThrow({
						where: { id: other.id },
					})
				).legacyAdmissionFenceVersion,
			).toBe(8);
			expect(
				await tenant.liveChannel.findUnique({ where: { id: other.id } }),
			).toBeNull();
		});

		it("keeps a scheduled re-air invisible to outbox recovery until its new airing and generation commit", async () => {
			const f = await fixture("STOPPED", null);
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan },
			});
			const row = await tenant.liveSchedule.create({
				data: {
					action: "START",
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					fireAt: now,
				},
			});
			const locked = barrier(),
				resume = barrier();
			const gated = instrumentTransactions(
				tenant,
				async (tx) =>
					new Proxy(tx, {
						get(client, key) {
							if (key === "liveChannel")
								return new Proxy(client.liveChannel, {
									get(delegate, prop) {
										if (prop === "updateMany")
											return async (
												args: Parameters<typeof delegate.updateMany>[0],
											) => {
												if (args?.data?.status === "PROVISIONING") {
													locked.release();
													await resume.ready;
												}
												return delegate.updateMany(args);
											};
										return Reflect.get(delegate, prop);
									},
								});
							return Reflect.get(client, key);
						},
					}),
			);
			const enqueue = vi.fn(
				async (_job: import("@bitovp/core").LiveChannelJob, _id: string) => {},
			);
			const original = createScheduleSweep({
				prisma: gated,
				now: () => now,
				enqueue,
			})();
			try {
				await reach(locked.ready, original);
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: row.id },
					}),
				).toMatchObject({ status: "ARMED", startAdmissionFenceVersion: null });
				await createScheduleSweep({
					prisma: tenant,
					now: () => new Date(now.getTime() + 600000),
					enqueue,
				}).dispatchPending();
				expect(enqueue).not.toHaveBeenCalled();
			} finally {
				resume.release();
				await original;
			}
			const saved = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(saved.status).toBe("FIRED");
			expect(saved.liveChannelRunId).not.toBe(f.run.id);
			expect(saved.startAdmissionFenceVersion).toBe(1);
			expect(enqueue).toHaveBeenCalledWith(
				{
					action: "provision",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: saved.liveChannelRunId,
					provisionFenceVersion: 1,
				},
				`sched-${row.id}`,
			);
		});

		it("reports an unbound pre-upgrade FIRED start against an ended broadcast as unknown without creating an encoder", async () => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPED" },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPED" },
			});
			const createStart = () =>
				tenant.liveSchedule.create({
					data: {
						liveChannelId: f.channel.id,
						action: "START",
						fireAt: now,
						firedAt: now,
						status: "FIRED",
					},
				});
			const [old, other] = await Promise.all([createStart(), createStart()]);
			const makeSdk = vi.fn(f.deps.makeSdk);
			await expect(
				createLiveChannelProcessor({ ...f.deps, makeSdk })(
					{ liveChannelId: f.channel.id, action: "provision" },
					`sched-${old.id}`,
				),
			).resolves.toMatchObject({ status: "SKIPPED_STALE_GENERATION" });
			expect(makeSdk).not.toHaveBeenCalled();
			expect(
				(await tenant.liveSchedule.findUniqueOrThrow({ where: { id: old.id } }))
					.outcome,
			).toBe("UNKNOWN");
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: other.id },
				}),
			).toEqual(other);
		});

		it("an older scheduled START cannot retire a revived admission or replace another airing's delivery", async () => {
			const f = await fixture("PROVISIONING", null);
			const latest = await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 4 },
			});
			const base = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "START" as const,
				status: "FIRED" as const,
				fireAt: now,
				firedAt: now,
			};
			const old = await tenant.liveSchedule.create({
				data: { ...base, startAdmissionFenceVersion: 3, outcome: "DELIVERED" },
			});
			const current = await tenant.liveSchedule.create({
				data: { ...base, startAdmissionFenceVersion: 4 },
			});
			const job = {
				id: `sched-${old.id}`,
				data: {
					liveChannelId: f.channel.id,
					action: "provision",
					plannedLiveChannelRunId: f.run.id,
					provisionFenceVersion: 3,
				},
				finishedOn: now.getTime(),
			};
			const admission = await resolveProvisionAdmission(
				tenant,
				f.channel.id,
				job.data,
				job.id,
			);
			if (!admission) throw new Error("missing prior START receipt");
			expect(
				await recordExpiredProvisionFailure(
					tenant,
					f.channel.id,
					"old failed",
					now,
					now,
					admission,
				),
			).toBe(false);
			await recordDeadJobScheduleOutcomes(tenant, job, "old failed", now);
			expect(
				await admitInactiveOrganization(tenant, "liveChannel", job.data, job),
			).toBe(false);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toEqual(latest);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: old.id } }),
			).toEqual(old);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: current.id },
				}),
			).toEqual(current);
			await recordScheduleOutcome(
				tenant,
				{
					scheduledStart: {
						id: current.id,
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						startAdmissionFenceVersion: 4,
					},
				},
				"DELIVERED",
				"current start",
				now,
				"PROVIDER_RUNNING",
			);
			expect(
				(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: current.id },
					})
				).outcome,
			).toBe("DELIVERED");
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPED" },
			});
			const successor = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "PROVISIONING",
					outputPrefix: "new/",
				},
			});
			const held = new Date();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 5, provisionClaimedAt: held },
			});
			const consumer = createTenantConsumer({
				prisma: tenant,
				forEachOrganization: async () => {},
				isOrganizationActive: async () => false,
			});
			const handler = vi.fn();
			await expect(
				consumer(
					"liveChannel",
					handler,
				)({
					...job,
					data: { organizationId: organizationIds[0], payload: job.data },
				} as Job),
			).rejects.toThrow("inactive");
			expect(handler).not.toHaveBeenCalled();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "PROVISIONING", provisionClaimedAt: held });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: successor.id },
				}),
			).toMatchObject({ status: "PROVISIONING" });
		});

		it.each([
			"manual",
			"scheduled",
		])("recovers a retained %s provision exhausted before its first lease only at its upgrade fence", async (kind) => {
			const f = await fixture("PROVISIONING", null);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { legacyAdmissionFenceVersion: 5, liveEffectFenceVersion: 5 },
			});
			const at = new Date(Date.now() + 1000);
			const row = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					action: "START",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
					dispatchedAt: at,
				},
			});
			const id =
				kind === "manual"
					? `${f.channel.id}-provision-${at.getTime()}`
					: `sched-${row.id}`;
			const admission = await resolveProvisionAdmission(
				tenant,
				f.channel.id,
				{},
				id,
				at.getTime(),
			);
			expect(admission).toEqual({ runId: f.run.id, generation: 5 });
			if (!admission) throw new Error("missing retained job");
			expect(
				await recordExpiredProvisionFailure(
					tenant,
					f.channel.id,
					"exhausted",
					at,
					at,
					admission,
				),
			).toBe(true);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ status: "ERROR", endedAt: at });
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "PROVISIONING", liveEffectFenceVersion: 6 },
			});
			const retained = await resolveProvisionAdmission(
				tenant,
				f.channel.id,
				{},
				id,
				at.getTime(),
			);
			if (kind === "manual") expect(retained).toBeNull();
			else {
				expect(retained).toEqual(admission);
				if (retained)
					expect(
						await recordExpiredProvisionFailure(
							tenant,
							f.channel.id,
							"old",
							at,
							at,
							retained,
						),
					).toBe(false);
			}
		});

		it.each([
			"unknown",
			"failed",
			"purged",
			"waiting",
			"successor",
		] as const)("reconciles only an exhausted legacy STOP by observation (%s)", async (scenario) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					legacyAdmissionFenceVersion: 2,
					liveEffectFenceVersion: 2,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const row = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
					outcome: ["unknown", "successor"].includes(scenario)
						? "UNKNOWN"
						: "PENDING",
					dispatchedAt: now,
				},
			});
			await tenant.liveSchedule.update({
				where: { id: row.id },
				data: { dispatchJobId: `sched-${row.id}` },
			});
			if (scenario === "successor")
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { liveEffectFenceVersion: 3 },
				});
			const queue = vi.fn(async () =>
				scenario === "purged"
					? undefined
					: {
							data: {
								liveChannelId: f.channel.id,
								action: "stop",
								plannedLiveChannelRunId: f.run.id,
							},
							getState: async () =>
								scenario === "waiting" ? "waiting" : "failed",
						},
			);
			const probe = createExhaustedLegacyStopRecovery(f.deps, queue);
			await probe();
			const key = { idempotencyKey: `schedule:${row.id}:stop` };
			const claim = await tenant.liveEffectClaim.findFirst({ where: key });
			if (scenario === "waiting" || scenario === "successor") {
				expect(claim).toBeNull();
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "STOPPING" });
				return;
			}
			expect(claim).toMatchObject({
				action: "STOP",
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				state: "DISPATCHING",
				stopProtocolVersion: null,
			});
			const resume = vi.fn();
			const observe = createUncertainStopReconciler(f.deps, resume);
			for (let i = 0; i < 5; i++) await observe();
			expect(resume).not.toHaveBeenCalled();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "STOPPED" });
			expect(
				await tenant.liveEffectClaim.findFirst({ where: key }),
			).toMatchObject({ state: "ACKED" });
			expect(
				(await tenant.liveSchedule.findUniqueOrThrow({ where: { id: row.id } }))
					.outcome,
			).toBe(scenario === "unknown" ? "UNKNOWN" : "DELIVERED");
		});

		it("never exposes a scheduled STOP job before its exact STOPPING generation commits", async () => {
			const f = await dispatchFixture();
			const original = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					fireAt: now,
				},
			});
			const reached = barrier(),
				resume = barrier();
			const proxy = new Proxy(tenant, {
				get(target, key) {
					if (key === "$transaction")
						return (
							fn: (
								client: import("@bitovp/db").AppTransactionClient,
							) => Promise<unknown>,
						) =>
							target.$transaction((tx) =>
								fn(
									new Proxy(tx, {
										get(client, key) {
											if (key === "liveChannel")
												return new Proxy(client.liveChannel, {
													get(delegate, method) {
														if (method === "updateMany")
															return async (
																args: Parameters<typeof delegate.updateMany>[0],
															) => {
																if (args?.data?.status === "STOPPING") {
																	reached.release();
																	await resume.ready;
																}
																return delegate.updateMany(args);
															};
														return Reflect.get(delegate, method);
													},
												});
											return Reflect.get(client, key);
										},
									}),
								),
							);
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const retained = new Map<string, import("@bitovp/core").LiveChannelJob>();
			const enqueue = async (
				job: import("@bitovp/core").LiveChannelJob,
				id: string,
			) => {
				if (!retained.has(id)) retained.set(id, job);
			};
			const pending = createScheduleSweep({
				prisma: proxy,
				now: () => now,
				enqueue,
			})();
			try {
				await reach(reached.ready, pending);
				await createScheduleSweep({
					prisma: tenant,
					now: () => new Date(now.getTime() + 600_000),
					enqueue,
				}).dispatchPending();
			} finally {
				resume.release();
			}
			await pending;
			const job = retained.get(`sched-${original.id}`);
			expect(job?.effect?.liveChannelRunId).toBe(f.run.id);
			const channel = await tenant.liveChannel.findUniqueOrThrow({
				where: { id: f.channel.id },
			});
			expect(job?.effect?.admissionFenceVersion).toBe(
				channel.liveEffectFenceVersion,
			);
			const result = await createLiveChannelProcessor(f.deps)(job);
			expect(result.status).toBe("STOPPED");
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
				f.encodingId,
			);
		});

		it.each([
			"ARMED",
			"FIRED",
		] as const)("recovers the archived encoder of an archive-only STOP at %s", async (status) => {
			const f = await dispatchFixture();
			const initial = status === "ARMED" ? "ERROR" : "STOPPING";
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: initial, bitmovinEncodingId: null, purpose: "PROBE" },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: initial,
					bitmovinEncodingId: null,
					previousProviderEncodingIds: [f.encodingId],
				},
			});
			const active = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					status,
					action: "STOP",
					fireAt: lease,
					...(status === "FIRED" ? { firedAt: lease } : {}),
				},
			});
			const enqueue = vi.fn(
				async (_job: import("@bitovp/core").LiveChannelJob, _id: string) => {},
			);
			const sweep = createScheduleSweep({
				prisma: tenant,
				now: () => new Date(now.getTime() + 600_000),
				enqueue,
			});
			if (status === "ARMED") await sweep();
			else await sweep.dispatchPending();
			const job = enqueue.mock.calls.find(
				([, id]) => id === `sched-${active.id}`,
			)?.[0];
			expect(job?.effect?.providerEncodingId).toBe(f.encodingId);
			expect((await createLiveChannelProcessor(f.deps)(job)).status).toBe(
				"STOPPED",
			);
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
				f.encodingId,
			);
		});

		it.each([
			"legacy",
			"fenced",
		] as const)("records native exhaustion before %s STOP adoption and publishes one exact schedule notification", async (format) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPING" },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const row = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					status: "FIRED",
					action: "STOP",
					fireAt: lease,
				},
			});
			const job = {
				id: `sched-${row.id}`,
				data: {
					action: "stop",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
					...(format === "fenced" && {
						effect: {
							...f.job.effect,
							scheduleId: row.id,
							idempotencyKey: `schedule:${row.id}:stop`,
						},
					}),
				},
				attemptsMade: 1,
				opts: { attempts: 3 },
				finishedOn: now.getTime(),
			};
			if (format === "fenced")
				expect(
					await recordFinalStopFailure(
						tenant,
						job,
						"exhausted before execution",
					),
				).toBe(true);
			await recordDeadJobScheduleOutcomes(
				tenant,
				job,
				"retained stop exhausted before adoption",
				now,
			);
			await recordDeadJobScheduleOutcomes(
				tenant,
				job,
				"duplicate failed callback",
				now,
			);
			const durableClaim = await tenant.liveEffectClaim.findUnique({
				where: { idempotencyKey: `schedule:${row.id}:stop` },
			});
			if (format === "legacy")
				expect(durableClaim).toMatchObject({
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					state: "AMBIGUOUS",
					stopProtocolVersion: null,
				});
			else expect(durableClaim).toBeNull();
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: row.id } }),
			).toMatchObject({
				outcome: "UNKNOWN",
				dispatchJobId: job.id,
				dispatchedAt: now,
			});
			expect(
				await tenant.liveStopNotification.count({
					where: { scheduleId: row.id },
				}),
			).toBe(1);
			const delivered: unknown[] = [];
			const notify = createStopNotificationSweep(
				tenant,
				async ({ data, beforeSend }) => {
					const event = productEventSchema.parse(data);
					if (event.kind === "SCHEDULE_FIRED" && event.scheduleId === row.id) {
						await beforeSend?.();
						delivered.push(event);
					}
					return [{ outcome: "DELIVERED" as const }];
				},
				"https://operator.example",
				() => now,
			);
			for (let pass = 0; pass < 20 && !delivered.length; pass++) await notify();
			await notify();
			expect(delivered).toEqual([
				{
					eventVersion: 1,
					kind: "SCHEDULE_FIRED",
					scheduleId: row.id,
					liveChannelId: f.channel.id,
					occurredAt: now.toISOString(),
					link: `https://operator.example/live/${f.channel.id}`,
				},
			]);
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});

		it("blocks both a same-airing resume and a fresh start while any retained broadcast has an unverified displaced encoder", async () => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "ERROR", bitmovinEncodingId: null },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "ERROR",
					bitmovinEncodingId: null,
					previousProviderEncodingIds: [f.encodingId],
				},
			});
			const guard = () =>
				tenant.$transaction((tx) => readLockedLiveStartState(tx, f.channel.id));
			expect((await guard()).archivesRetired).toBe(false);
			await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "STOPPED",
					outputPrefix: "",
				},
			});
			expect((await guard()).archivesRetired).toBe(false);
			const account = (
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				})
			).plan as { bitmovin: { accountId: string } };
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					rtmpRetirementEvidence: [
						{
							encodingId: f.encodingId,
							accountId: account.bitmovin.accountId,
							disposition: "TERMINAL",
							providerStatus: "FINISHED",
							observedAt: now.toISOString(),
						},
					],
				},
			});
			expect((await guard()).archivesRetired).toBe(true);
		});

		it("a cap paused after scanning a previous airing leaves its successor on air, then caps it at its own deadline", async () => {
			const f = await fixture("RUNNING", null);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					runningSince: new Date(now.getTime() - 120000),
					maxRunMinutes: 1,
				},
			});
			const scanned = barrier(),
				resume = barrier();
			const paused = new Proxy(tenant, {
				get(target, key) {
					if (key === "liveChannel")
						return new Proxy(target.liveChannel, {
							get(channels, method) {
								if (method === "findMany")
									return async (
										args: Parameters<typeof channels.findMany>[0],
									) => {
										const rows = await channels.findMany(args);
										scanned.release();
										await resume.ready;
										return rows;
									};
								return Reflect.get(channels, method);
							},
						});
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			let at = now;
			const enqueue = vi.fn(async () => {});
			const sweep = createScheduleSweep({
				prisma: paused,
				now: () => at,
				enqueue,
			});
			const previous = sweep();
			let successorId: string;
			try {
				await scanned.ready;
				const next = await tenant.$transaction(async (tx) => {
					await tx.liveChannel.update({
						where: { id: f.channel.id },
						data: {
							runningSince: now,
							bitmovinEncodingId: "next-cap-encoder",
							liveEffectFenceVersion: { increment: 1 },
						},
					});
					await tx.liveChannelRun.update({
						where: { id: f.run.id },
						data: { status: "STOPPED", endedAt: now },
					});
					return tx.liveChannelRun.create({
						data: {
							liveChannelId: f.channel.id,
							seq: 2,
							outputPrefix: "",
							status: "RUNNING",
							bitmovinEncodingId: "next-cap-encoder",
						},
					});
				});
				successorId = next.id;
			} finally {
				resume.release();
			}
			await previous;
			expect(enqueue).not.toHaveBeenCalled();
			expect(
				await tenant.liveSchedule.count({
					where: { liveChannelId: f.channel.id },
				}),
			).toBe(0);
			at = new Date(now.getTime() + 61000);
			expect((await sweep()).capStops).toBe(1);
			const row = await tenant.liveSchedule.findFirstOrThrow({
				where: { liveChannelId: f.channel.id },
			});
			expect(row).toMatchObject({
				status: "FIRED",
				liveChannelRunId: successorId,
				dispatchJobId: `sched-${row.id}`,
			});
			expect(enqueue).toHaveBeenCalledWith(
				expect.objectContaining({
					effect: expect.objectContaining({
						liveChannelRunId: successorId,
						providerEncodingId: "next-cap-encoder",
						scheduleId: row.id,
					}),
				}),
				`sched-${row.id}`,
			);
		});

		it("releases a failed provision with its own run and rejects the lease after a successor appears", async () => {
			const f = await fixture();
			const target = {
				liveChannelId: f.channel.id,
				runId: f.run.id,
				generation: f.channel.liveEffectFenceVersion,
				lease,
			};
			const outcome = { status: "ERROR", error: "finalize failed" } as const;
			expect(await commitProvisionEnd(tenant, target, outcome)).toBe(true);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ ...outcome, provisionClaimedAt: null });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ ...outcome, endedAt: expect.any(Date) });
			const successor = await tenant.$transaction(async (tx) => {
				await tx.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						status: "PROVISIONING",
						error: null,
						provisionClaimedAt: lease,
						liveEffectFenceVersion: { increment: 1 },
					},
				});
				return tx.liveChannelRun.create({
					data: {
						liveChannelId: f.channel.id,
						seq: 2,
						status: "PROVISIONING",
						outputPrefix: "next",
					},
				});
			});
			expect(await commitProvisionEnd(tenant, target, outcome)).toBe(false);
			expect(
				await commitProvisionEnd(
					tenant,
					{ ...target, generation: target.generation + 1 },
					outcome,
				),
			).toBe(false);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: successor.id },
				}),
			).toMatchObject({ status: "PROVISIONING", error: null, endedAt: null });
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "PROVISIONING",
				error: null,
				provisionClaimedAt: lease,
			});
		});

		async function stopFixture() {
			const f = await fixture("STOPPING", null);
			const accountId = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan: { bitmovin: { accountId } }, liveEffectFenceVersion: 2 },
			});
			const fields = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				ownerId: "fixture",
				expiresAt: now,
				dispatchedAt: lease,
			};
			const claim = await tenant.liveEffectClaim.create({
				data: {
					...fields,
					generation: 2,
					token: randomUUID(),
					action: "STOP",
					state: "DISPATCHING",
					idempotencyKey: randomUUID(),
				},
			});
			const proof = {
				...fields,
				stopClaimId: claim.id,
				stopIdempotencyKey: claim.idempotencyKey,
				at: now,
				ownerReadbacks: {
					generation: 2,
					token: claim.token,
					bitmovinAccountId: accountId,
					encodings: [{ id: f.encodingId, status: "FINISHED" }],
				},
			};
			return { ...f, fields, claim, proof };
		}

		async function dispatchFixture(encodingId?: string) {
			const f = await fixture("RUNNING", null, encodingId);
			const accountId = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan: { bitmovin: { accountId } } },
			});
			const identity = {
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				action: "STOP" as const,
			};
			const job = {
				liveChannelId: f.channel.id,
				action: "stop" as const,
				effect: {
					...identity,
					idempotencyKey: `manual:stop:${f.channel.id}:${f.run.id}:0`,
					admissionFenceVersion: 0,
				},
			};
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
			});
			const deps: LiveChannelDeps = {
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => sdk,
				revealBitmovinAccount: async () => ({
					apiKey: "unused",
					tenantOrgId: null,
				}),
				resolveCredential: async () => {
					throw new Error("unexpected storage operation");
				},
				sleep: async () => {},
				pollIntervalMs: 1,
				pollTimeoutMs: 200,
				enqueueFeederJob: vi.fn(async () => {}),
			};
			return { ...f, accountId, identity, job, sdk, deps };
		}

		it.each([
			"terminal",
			"active",
			"unreadable",
		] as const)("rechecks an unsent encoder on native STOP redelivery: %s", async (providerState) => {
			const f = await dispatchFixture();
			const begun = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				idempotencyKey: f.job.effect.idempotencyKey,
				expectedFenceVersion: 0,
				supersedeOpen: true,
				ownerId: "dead",
				now: lease,
				expiresAt: lease,
			});
			if (begun.kind !== "EXECUTE") throw new Error("missing fixture claim");
			let posted = false;
			f.sdk.getEncodingStatus = vi.fn(async () => {
				if (providerState === "unreadable") throw new Error("read failed");
				return {
					status:
						providerState === "active" && !posted ? "RUNNING" : "FINISHED",
				};
			});
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				posted = true;
			});
			const pending = createLiveChannelProcessor(f.deps)(f.job);
			if (providerState === "unreadable")
				await expect(pending).rejects.toThrow();
			else await expect(pending).resolves.toMatchObject({ status: "STOPPED" });
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledTimes(
				providerState === "active" ? 1 : 0,
			);
		});

		it("recovers the first STOP for an archived live encoder after a pre-journal clean ACK", async () => {
			const f = await dispatchFixture(),
				secondary = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPED", error: null, liveEffectFenceVersion: 1 },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPED",
					error: null,
					providerStatus: "FINISHED",
					providerTerminalAt: lease,
					providerStatusObservedAt: lease,
					previousProviderEncodingIds: [secondary],
				},
			});
			await tenant.liveEffectClaim.create({
				data: {
					...f.identity,
					liveChannelId: f.channel.id,
					generation: 1,
					ownerId: "legacy",
					expiresAt: lease,
					token: randomUUID(),
					idempotencyKey: f.job.effect.idempotencyKey,
					state: "ACKED",
					acknowledgedAt: lease,
				},
			});
			let posted = false;
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === secondary && !posted ? "RUNNING" : "FINISHED",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				posted = true;
			});
			const proc = createLiveChannelProcessor(f.deps);
			expect(await proc(f.job)).toMatchObject({ status: "STOPPED" });
			await proc(f.job);
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(secondary);
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { idempotencyKey: f.job.effect.idempotencyKey },
				}),
			).toMatchObject({
				state: "ACKED",
				stopProtocolVersion: null,
				legacyUnsentStopIds: [secondary],
			});
		});

		it("retains known unsent archives even when the log cannot establish a complete stop", async () => {
			const f = await dispatchFixture(),
				secondary = randomUUID();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					stepLog: { malformed: true },
					previousProviderEncodingIds: [secondary],
				},
			});
			const begun = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				idempotencyKey: f.job.effect.idempotencyKey,
				expectedFenceVersion: 0,
				supersedeOpen: true,
				ownerId: "dead",
				now: lease,
				expiresAt: now,
			});
			if (begun.kind !== "EXECUTE") throw new Error("missing claim");
			await tenant.liveEffectClaim.update({
				where: { id: begun.claim.id },
				data: { stopSendEncodingIds: [f.encodingId] },
			});
			let posted = false;
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === secondary && !posted ? "RUNNING" : "FINISHED",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				posted = true;
			});
			const proc = createLiveChannelProcessor(f.deps);
			const tick = createUncertainStopReconciler(f.deps, (job, active) =>
				proc(job, undefined, false, active),
			);
			await tick();
			await tick();
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(secondary);
			expect(
				(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { id: begun.claim.id },
					})
				).state,
			).not.toBe("ACKED");
		});

		it("a manual STOP invalidates a provision lease while its last details GET is delayed", async () => {
			const f = await dispatchFixture(randomUUID());
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			await tenant.bitmovinAccount.create({
				data: {
					id: f.accountId,
					label: "offline provision fixture",
					encryptedApiKey: "fixture-only",
				},
			});
			plan.bitmovin.accountId = f.accountId;
			const stepLog = JSON.parse(
				JSON.stringify(
					initStepLog(compileLiveChannel(plan)).map((e) => ({
						...e,
						status: "DONE",
						resourceId:
							e.kind === "CREATE_ENCODING" ? f.encodingId : randomUUID(),
					})),
				),
			);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "PROVISIONING", plan, stepLog },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "PROVISIONING", stepLog },
			});
			const entered = barrier(),
				reply = barrier();
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			f.sdk.getLiveEncodingDetails = vi.fn(async () => {
				entered.release();
				await reply.ready;
				throw new Error("old details request failed");
			});
			const proc = createLiveChannelProcessor(f.deps);
			const provisioning = Promise.allSettled([
				proc({
					action: "provision",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
				}),
			]);
			try {
				await Promise.race([
					entered.ready,
					provisioning.then(([result]) => {
						throw new Error(
							"Provision finished before final details: " +
								(result?.status === "rejected"
									? String(result.reason)
									: JSON.stringify(result)),
						);
					}),
				]);
				const held = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				});
				expect(held.provisionClaimedAt).not.toBeNull();
				const stop = await beginLiveEffect(tenant, {
					...f.identity,
					liveChannelId: f.channel.id,
					idempotencyKey: f.job.effect.idempotencyKey,
					expectedFenceVersion: 0,
					supersedeOpen: true,
					allowedChannelStatuses: ["RUNNING", "ERROR"],
					ownerId: "stop",
					now,
					expiresAt: new Date(now.getTime() + 60000),
				});
				expect(stop.kind).toBe("EXECUTE");
			} finally {
				reply.release();
				await provisioning;
			}
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "STOPPING",
				provisionClaimedAt: null,
				error: null,
			});
		});

		it("a callback for a former airing cannot retire an unleased successor", async () => {
			const f = await fixture("STOPPED", null);
			const next = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "PROVISIONING",
					outputPrefix: "two/",
				},
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "PROVISIONING", provisionClaimedAt: null },
			});
			const staleId = `manual-provision-${f.channel.id}-${next.id}-0`;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 1 },
			});
			const offlineDeps = (await dispatchFixture()).deps;
			const sdkForStale = vi.fn(offlineDeps.makeSdk);
			expect(
				await createLiveChannelProcessor({
					...offlineDeps,
					makeSdk: sdkForStale,
				})(
					{
						action: "provision",
						liveChannelId: f.channel.id,
						plannedLiveChannelRunId: next.id,
					},
					staleId,
				),
			).toMatchObject({ status: "STALE_RUN" });
			expect(sdkForStale).not.toHaveBeenCalled();
			expect(
				await recordExpiredProvisionFailure(
					tenant,
					f.channel.id,
					"old generation",
					now,
					now,
					{ runId: next.id, generation: 0 },
				),
			).toBe(false);
			for (const admission of [{ runId: f.run.id }, { initial: true as const }])
				expect(
					await recordExpiredProvisionFailure(
						tenant,
						f.channel.id,
						"old",
						now,
						now,
						admission,
					),
				).toBe(false);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: next.id },
				}),
			).toMatchObject({ status: "PROVISIONING" });
			expect(
				await recordExpiredProvisionFailure(
					tenant,
					f.channel.id,
					"actual",
					now,
					now,
					{ runId: next.id },
				),
			).toBe(true);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "PROVISIONING" },
			});
			const testDeps = (await dispatchFixture()).deps;
			const makeSdk = vi.fn(testDeps.makeSdk);
			expect(
				await createLiveChannelProcessor({ ...testDeps, makeSdk })({
					action: "provision",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: next.id,
				}),
			).toMatchObject({ status: "STALE_RUN" });
			expect(makeSdk).not.toHaveBeenCalled();
		});

		it.each([
			false,
			true,
		])("preserves a legacy partial STOP during startup and after a prior legacy sweep (%s)", async (alreadySwept) => {
			const f = await stopFixture(),
				secondary = randomUUID();
			const error = `stop did not confirm — ${secondary}: response unavailable; try later`;
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { state: "AMBIGUOUS", failure: liveEffectSendUncertainty(error) },
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "ERROR", error },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: alreadySwept
					? { status: "ERROR", error: STRANDED_RUN_ERROR }
					: { status: "STOPPING", error: null },
			});
			await createStrandedRunReconciler({ prisma: tenant })();
			const status = vi.fn(async () => ({ status: "FINISHED" as const }));
			const tick = createUncertainStopReconciler({
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => fakeSdk({ getEncodingStatus: status }),
				revealBitmovinAccount: async () => ({
					apiKey: "unused",
					tenantOrgId: null,
				}),
			});
			await tick();
			expect(status).toHaveBeenCalledWith(secondary);
			expect(
				(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { id: f.claim.id },
					})
				).state,
			).toBe("ACKED");
		});

		it("stops the agreeing primary despite a corrupt log and retains its incomplete ownership evidence", async () => {
			const f = await dispatchFixture();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { stepLog: { unreadable: true } },
			});
			expect(await createLiveChannelProcessor(f.deps)(f.job)).toMatchObject({
				status: "EFFECT_AMBIGUOUS",
			});
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
				f.encodingId,
			);
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { idempotencyKey: f.job.effect.idempotencyKey },
				}),
			).toMatchObject({
				state: "AMBIGUOUS",
				stopSendEncodingIds: [f.encodingId],
			});
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).status,
			).not.toBe("STOPPED");
		});

		it("binds only the current unresolved archived encoder for manual Stop under tenant isolation", async () => {
			const f = await dispatchFixture(),
				archive = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPED", bitmovinEncodingId: null },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPED",
					bitmovinEncodingId: null,
					previousProviderEncodingIds: [archive],
					providerStatus: "FINISHED",
					providerTerminalAt: lease,
					providerStatusObservedAt: lease,
					encoderStoppedConfirmedFor: f.encodingId,
				},
			});
			const canReair = () =>
				tenant.$transaction(
					async (tx) =>
						(await readLockedLiveStartState(tx, f.channel.id)).archivesRetired,
				);
			expect(await canReair()).toBe(false);
			expect(
				await bindArchivedStopTarget(otherTenant, f.channel.id),
			).toBeNull();
			expect(
				await bindArchivedStopTarget(tenant, f.channel.id, randomUUID()),
			).toBeNull();
			const [displayedChannel, displayedRun] = await Promise.all([
				tenant.liveChannel.findUniqueOrThrow({ where: { id: f.channel.id } }),
				tenant.liveChannelRun.findUniqueOrThrow({ where: { id: f.run.id } }),
			]);
			const revision = archivedStopRevision(displayedChannel, displayedRun);
			if (!revision) throw new Error("expected a displayed archive");
			expect(
				await bindArchivedStopTarget(
					tenant,
					f.channel.id,
					f.run.id,
					"0".repeat(64),
				),
			).toBeNull();
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).bitmovinEncodingId,
			).toBeNull();
			expect(
				await bindArchivedStopTarget(tenant, f.channel.id, f.run.id, revision),
			).toBe(archive);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				bitmovinEncodingId: archive,
				providerStatus: null,
				providerTerminalAt: null,
				providerStatusObservedAt: null,
				encoderStoppedConfirmedFor: null,
				heartbeatPollEpoch: 8,
			});
			const job = {
				...f.job,
				effect: { ...f.job.effect, providerEncodingId: archive },
			};
			expect(await createLiveChannelProcessor(f.deps)(job)).toMatchObject({
				status: "STOPPED",
			});
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(archive);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				rtmpRetirementEvidence: [
					{
						accountId: f.accountId,
						encodingId: archive,
						providerStatus: "FINISHED",
						disposition: "TERMINAL",
						observedAt: now.toISOString(),
					},
				],
			});
			expect(
				await bindArchivedStopTarget(tenant, f.channel.id, f.run.id),
			).toBeNull();
			// An upgraded ACKED run may lack the second encoder's retirement receipt.
			// Keep the confirmed primary binding and recover only the other encoder.
			expect(await canReair()).toBe(true);
			const oldSecondary = randomUUID();
			vi.mocked(f.sdk.getEncodingStatus).mockImplementation(async (id) => ({
				status:
					id === oldSecondary &&
					!vi
						.mocked(f.sdk.stopLiveEncoding)
						.mock.calls.some(([sent]) => sent === id)
						? "RUNNING"
						: "FINISHED",
			}));
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { previousProviderEncodingIds: [archive, oldSecondary] },
			});
			expect(await bindArchivedStopTarget(tenant, f.channel.id, f.run.id)).toBe(
				archive,
			);
			expect(await createLiveChannelProcessor(f.deps)(job)).toMatchObject({
				status: "STOPPED",
			});
			expect(
				vi.mocked(f.sdk.stopLiveEncoding).mock.calls.map(([id]) => id),
			).toEqual([archive, oldSecondary]);
			expect(
				await bindArchivedStopTarget(tenant, f.channel.id, f.run.id),
			).toBeNull();
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(1);
		});

		it("retires an exhausted still-current RESTART after lease expiry without touching its provider", async () => {
			const f = await fixture("PROVISIONING", null);
			const expiresAt = new Date(now.getTime() + 60_000);
			const effect = {
				action: "RESTART" as const,
				idempotencyKey: "restart:" + randomUUID(),
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				admissionFenceVersion: 0,
			};
			const admission = await beginLiveEffect(tenant, {
				...effect,
				liveChannelId: f.channel.id,
				expectedFenceVersion: 0,
				ownerId: "worker",
				now,
				expiresAt,
			});
			if (admission.kind !== "EXECUTE") throw new Error("not admitted");
			const dead = {
				data: { action: "restart", liveChannelId: f.channel.id, effect },
				attemptsMade: 3,
				opts: { attempts: 3 },
			};
			expect(
				await recordFinalRestartFailure(tenant, dead, "worker lost", now),
			).toBe(false);
			const sweep = createExpiredRestartReconciler(tenant);
			await sweep(now);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).status,
			).toBe("PROVISIONING");
			const replay = await beginLiveEffect(tenant, {
				...effect,
				liveChannelId: f.channel.id,
				expectedFenceVersion: 0,
				ownerId: "retry",
				now: expiresAt,
				expiresAt: new Date(expiresAt.getTime() + 1000),
			});
			expect(replay).toMatchObject({ kind: "BLOCKED", state: "AMBIGUOUS" });
			await sweep(expiresAt);
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "ERROR", bitmovinEncodingId: f.encodingId });
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: admission.claim.id },
				}),
			).toMatchObject({ state: "AMBIGUOUS", attempt: 1 });
			expect(await sweep(expiresAt)).toBe(0);
		});

		it.each([
			false,
			true,
		])("recovers only the original unreserved STOP targets after process death (primary was reserved: %s)", async (primarySent) => {
			const f = await dispatchFixture(),
				secondary = randomUUID(),
				finished = randomUUID();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { previousProviderEncodingIds: [secondary, finished] },
			});
			const old = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				idempotencyKey: f.job.effect.idempotencyKey,
				expectedFenceVersion: 0,
				supersedeOpen: true,
				ownerId: "interrupted",
				now,
				expiresAt: new Date(now.getTime() + 1000),
			});
			if (old.kind !== "EXECUTE") throw new Error("not admitted");
			if (primarySent)
				expect(
					await claimLiveStopSend(tenant, old.claim, f.encodingId, now),
				).toBe(true);
			vi.mocked(f.sdk.getEncodingStatus).mockImplementation(async (id) => ({
				status:
					id === finished ||
					(id === f.encodingId && primarySent) ||
					vi
						.mocked(f.sdk.stopLiveEncoding)
						.mock.calls.some(([sent]) => sent === id)
						? "FINISHED"
						: "RUNNING",
			}));
			f.deps.now = () => new Date(now.getTime() + 2000).toISOString();
			const process = createLiveChannelProcessor(f.deps);
			const tick = createUncertainStopReconciler(f.deps, (job, activeTargets) =>
				process(job, undefined, false, activeTargets),
			);
			for (let i = 0; i < 3; i++) await tick();
			expect(
				vi.mocked(f.sdk.stopLiveEncoding).mock.calls.map(([id]) => id),
			).toEqual(primarySent ? [secondary] : [f.encodingId, secondary]);
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: old.claim.id },
				}),
			).toMatchObject({ state: "ACKED", attempt: 2 });
		});

		it.each([
			"manual-after-schedule",
			"expired-manual",
			"encoding-first",
		] as const)("sends the first Analysis STOP and fences the interrupted binding GET (%s)", async (scenario) => {
			const f = await dispatchFixture(randomUUID()),
				analysisId = randomUUID();
			const snapshot = {
				analysisId,
				encodingId: f.encodingId,
				isFinal: true,
				sequence: 1,
				producedAt: now.toISOString(),
				mediaTimeOriginUnixMs: now.getTime(),
				analyzedStartTimeSeconds: 0,
				analyzedEndTimeSeconds: 60,
				metadata: { version: "1", disclaimer: "Preview" },
				observations: [],
				keyMoments: [],
				sourceGaps: [],
			};
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { aisaAnalysisId: analysisId, aisaStatus: "RUNNING" },
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					plan: {
						bitmovin: { accountId: f.accountId },
						...(scenario === "encoding-first"
							? {}
							: { start: { aiSceneAnalysisLive: {} } }),
					},
				},
			});
			const first = barrier(),
				release = barrier();
			let intercept = true,
				stopped = false;
			const client = {
				get: vi.fn(async () => {
					const status = stopped ? "FINISHED" : "RUNNING";
					if (intercept && scenario === "encoding-first") {
						intercept = false;
						throw new AisaLiveError(502);
					}
					if (intercept) {
						intercept = false;
						first.release();
						await release.ready;
					}
					return { analysisId, encodingId: f.encodingId, status };
				}),
				stop: vi.fn(async () => {
					stopped = true;
				}),
				latest: vi.fn(async () => snapshot),
			};
			provider.aisa.mockReturnValue(client);
			f.deps.makeSdk = (options) => ({
				...f.sdk,
				...createAisaLiveOps(
					{
						options,
						audited: (_method, _path, _body, fn) => fn(),
					},
					f.sdk,
					f.sdk,
				),
			});
			if (scenario === "encoding-first") {
				let encoderActive = true;
				f.sdk.stopLiveEncoding = vi.fn(async () => {
					encoderActive = false;
				});
				f.sdk.getEncodingStatus = vi.fn(async () => ({
					status: encoderActive ? "RUNNING" : "FINISHED",
				}));
				const proc = createLiveChannelProcessor(f.deps);
				await expect(proc(f.job)).rejects.toThrow();
				expect(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { idempotencyKey: f.job.effect.idempotencyKey },
					}),
				).toMatchObject({
					stopSendEncodingIds: [f.encodingId],
					stopAnalysisSendId: null,
				});
				expect(await proc(f.job)).toMatchObject({ status: "STOPPED" });
				expect(client.stop).toHaveBeenCalledExactlyOnceWith(analysisId);
				expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
					f.encodingId,
				);
				return;
			}
			const schedule =
				scenario === "manual-after-schedule"
					? await tenant.liveSchedule.create({
							data: {
								action: "STOP",
								fireAt: lease,
								liveChannelId: f.channel.id,
								liveChannelRunId: f.run.id,
								status: "FIRED",
							},
						})
					: null;
			const process = createLiveChannelProcessor(f.deps);
			f.job.effect.idempotencyKey = `manual:stop:${f.channel.id}:${f.run.id}`;
			const old = Promise.allSettled([
				process(
					schedule
						? {
								...f.job,
								effect: {
									...f.job.effect,
									idempotencyKey: "schedule:" + schedule.id + ":stop",
									scheduleId: schedule.id,
								},
							}
						: f.job,
				),
			]);
			try {
				await reach(first.ready, old);
				if (!schedule) {
					const interrupted = await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { idempotencyKey: f.job.effect.idempotencyKey },
					});
					expect(interrupted).toMatchObject({
						state: "DISPATCHING",
						stopProtocolVersion: 1,
						stopSendEncodingIds: [],
						stopAnalysisSendId: null,
					});
					await tenant.liveEffectClaim.update({
						where: { id: interrupted.id },
						data: { expiresAt: lease },
					});
				}
				expect(await process(f.job)).toMatchObject({ status: "STOPPED" });
			} finally {
				release.release();
				await old;
			}
			expect(client.stop).toHaveBeenCalledExactlyOnceWith(analysisId);
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				aisaStatus: "FINISHED",
				aisaSnapshot: snapshot,
				status: "STOPPED",
			});
			expect(
				await tenant.liveEffectClaim.findMany({
					where: { liveChannelRunId: f.run.id, stopAnalysisSendId: analysisId },
				}),
			).toHaveLength(1);
		});

		it("recovers complete managed AISA through readback alone after its final feeder exits", async () => {
			const f = await dispatchFixture(randomUUID()),
				analysisId = randomUUID();
			const snapshot = {
				analysisId,
				encodingId: f.encodingId,
				isFinal: true,
				sequence: 1,
				producedAt: now.toISOString(),
				mediaTimeOriginUnixMs: now.getTime(),
				analyzedStartTimeSeconds: 0,
				analyzedEndTimeSeconds: 60,
				metadata: { version: "1", disclaimer: "Preview" },
				observations: [],
				keyMoments: [],
				sourceGaps: [],
			};
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					plan: {
						bitmovin: { accountId: f.accountId },
						start: { aiSceneAnalysisLive: {} },
					},
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					aisaAnalysisId: analysisId,
					aisaStatus: "FINISHED",
					aisaSnapshot: snapshot,
				},
			});
			const stop = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				idempotencyKey: f.job.effect.idempotencyKey,
				expectedFenceVersion: 0,
				supersedeOpen: true,
				ownerId: "owner",
				now,
				expiresAt: new Date(now.getTime() + 60000),
			});
			if (stop.kind !== "EXECUTE") throw new Error("not admitted");
			const feeder = await tenant.feederSession.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					sourceCredentialId: randomUUID(),
					sourceBucket: "fixture",
					sourceKey: "fixture.mp4",
					protocol: "RTMP",
					target: {},
					status: "PUSHING",
				},
			});
			const error =
				"stop did not confirm — feeder " +
				feeder.id +
				": stop was enqueued but publisher termination was not confirmed";
			await recordLiveStopFailure(tenant, stop.claim, {
				status: "STOPPED",
				state: "AMBIGUOUS",
				failure: error,
				error,
				at: now,
				accountId: f.accountId,
				requiredEncodingIds: [f.encodingId],
				encodings: [{ id: f.encodingId, status: "FINISHED" }],
			});
			const tick = createUncertainStopReconciler(f.deps);
			await tick();
			expect(
				(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { id: stop.claim.id },
					})
				).state,
			).toBe("AMBIGUOUS");
			await tenant.feederSession.update({
				where: { id: feeder.id },
				data: { status: "STOPPED", stoppedAt: now },
			});
			for (let i = 0; i < 3; i++) await tick();
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: stop.claim.id },
				}),
			).toMatchObject({ state: "ACKED", attempt: 1 });
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(f.sdk.stopAisaLiveAnalysis).not.toHaveBeenCalled();
		});

		it.each([
			"RUNNING",
			"STOPPING",
		] as const)("delivers a probe's %s teardown through the scheduler to the exact run and provider", async (initial) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { purpose: "PROBE", status: initial },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: initial },
			});
			expect(
				await requestProbeStop(otherTenant, f.channel.id, f.run.id, now),
			).toBe("unconfirmed");
			expect(
				await requestProbeStop(tenant, f.channel.id, randomUUID(), now),
			).toBe("unconfirmed");
			expect(
				(
					await Promise.all([
						requestProbeStop(tenant, f.channel.id, f.run.id, now),
						requestProbeStop(tenant, f.channel.id, f.run.id, now),
					])
				).sort(),
			).toEqual(["pending", "scheduled"]);
			const schedule = await tenant.liveSchedule.findFirstOrThrow({
				where: { liveChannelId: f.channel.id },
			});
			const enqueue = vi.fn(
				async (_data: import("@bitovp/core").LiveChannelJob, _id: string) => {},
			);
			const sweep = createScheduleSweep({
				prisma: tenant,
				enqueue,
				now: () => new Date(now.getTime() + 600_000),
			});
			if (initial === "RUNNING") await sweep();
			else await sweep.dispatchPending();
			const jobs = enqueue.mock.calls.filter(
				([job]) => job.liveChannelId === f.channel.id,
			);
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toEqual([
				expect.objectContaining({
					action: "stop",
					plannedLiveChannelRunId: f.run.id,
					effect: expect.objectContaining({
						action: "STOP",
						liveChannelRunId: f.run.id,
						providerEncodingId: f.encodingId,
						scheduleId: schedule.id,
					}),
				}),
				`sched-${schedule.id}`,
			]);
			const result = await createLiveChannelProcessor(f.deps)(jobs[0]?.[0]);
			expect(result.status).toBe("STOPPED");
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
				f.encodingId,
			);
		});

		it.each([
			true,
			false,
		])("adopts an exact preclaimed legacy scheduled STOP and preserves first-delivery send authority (%s)", async (firstDelivery) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPING" },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			if (!firstDelivery) {
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { bitmovinEncodingId: null },
				});
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: {
						bitmovinEncodingId: null,
						previousProviderEncodingIds: [f.encodingId],
					},
				});
			}
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
				},
			});
			const job = {
				liveChannelId: f.channel.id,
				action: "stop",
				...(firstDelivery ? { plannedLiveChannelRunId: f.run.id } : {}),
			};
			const process = createLiveChannelProcessor(f.deps);
			expect(
				(await process(job, `sched-${randomUUID()}`, firstDelivery)).status,
			).toBe("EFFECT_REFUSED");
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			const result = await process(job, `sched-${schedule.id}`, firstDelivery);
			expect(result.status).toBe("STOPPED");
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledTimes(
				firstDelivery ? 1 : 0,
			);
			expect(
				await tenant.liveEffectClaim.findFirst({
					where: { scheduleId: schedule.id },
				}),
			).toMatchObject({
				state: "ACKED",
				providerEncodingId: f.encodingId,
				liveChannelRunId: f.run.id,
			});
		});

		it.each([
			false,
			true,
		])("manual supersession accounts for precisely one provider call (scheduled first send reserved: %s)", async (alreadySent) => {
			const f = await dispatchFixture();
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					fireAt: lease,
					status: "FIRED",
				},
			});
			const old = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				expectedFenceVersion: 0,
				idempotencyKey: `schedule:${schedule.id}:stop`,
				scheduleId: schedule.id,
				ownerId: "first",
				now,
				expiresAt: new Date(now.getTime() + 60000),
			});
			if (old.kind !== "EXECUTE")
				throw new Error("scheduled claim not admitted");
			if (alreadySent) {
				expect(
					await claimLiveStopSend(tenant, old.claim, f.encodingId, now),
				).toBe(true);
				await f.sdk.stopLiveEncoding(f.encodingId);
			}
			vi.mocked(f.sdk.getEncodingStatus).mockImplementation(async () => ({
				status: vi.mocked(f.sdk.stopLiveEncoding).mock.calls.length
					? "FINISHED"
					: "RUNNING",
			}));
			expect(await createLiveChannelProcessor(f.deps)(f.job)).toMatchObject({
				status: "STOPPED",
			});
			expect(
				await claimLiveStopSend(tenant, old.claim, f.encodingId, now),
			).toBe(false);
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledTimes(1);
			const claims = await tenant.liveEffectClaim.findMany({
				where: { liveChannelRunId: f.run.id },
			});
			expect(claims.map((c) => c.state)).toEqual(["ACKED", "ACKED"]);
			expect(claims.flatMap((c) => c.stopSendEncodingIds)).toEqual([
				f.encodingId,
			]);
		});

		it("an expired worker cannot mark or enqueue feeder stops on the successor broadcast", async () => {
			const f = await dispatchFixture();
			const feeder = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				sourceCredentialId: randomUUID(),
				sourceBucket: "fixture",
				sourceKey: "fixture.mp4",
				protocol: "RTMP" as const,
				target: {},
				status: "PUSHING" as const,
			};
			const old = await tenant.feederSession.create({ data: feeder });
			const captured = barrier(),
				resume = barrier();
			let seen = false;
			const prisma = new Proxy(tenant, {
				get(target, key) {
					if (key === "$transaction")
						return async (
							fn: (tx: AppTransactionClient) => Promise<unknown>,
						) => {
							const result = await target.$transaction(fn);
							if (
								!seen &&
								Array.isArray(result) &&
								result.some((item) => item?.id === old.id)
							) {
								seen = true;
								captured.release();
								await resume.ready;
							}
							return result;
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const owner = Promise.allSettled([
				createLiveChannelProcessor({ ...f.deps, prisma })(f.job),
			]);
			try {
				await reach(captured.ready, owner);
				await tenant.feederSession.update({
					where: { id: old.id },
					data: { status: "STOPPED" },
				});
				await tenant.liveEffectClaim.updateMany({
					where: { liveChannelRunId: f.run.id },
					data: { expiresAt: lease },
				});
				await createUncertainStopReconciler(f.deps)();
				expect(
					await tenant.liveEffectClaim.findFirstOrThrow({
						where: { liveChannelRunId: f.run.id },
					}),
				).toMatchObject({ state: "ACKED" });
				const next = await tenant.liveChannelRun.create({
					data: {
						liveChannelId: f.channel.id,
						seq: 2,
						status: "RUNNING",
						bitmovinEncodingId: randomUUID(),
						outputPrefix: "next",
					},
				});
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						status: "RUNNING",
						bitmovinEncodingId: next.bitmovinEncodingId,
					},
				});
				const nextFeeder = await tenant.feederSession.create({
					data: { ...feeder, liveChannelRunId: next.id },
				});
				resume.release();
				expect(await owner).toEqual([
					{
						status: "fulfilled",
						value: expect.objectContaining({
							status: "EFFECT_ALREADY_ACKNOWLEDGED",
						}),
					},
				]);
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: next.id },
					}),
				).toMatchObject({ status: "RUNNING" });
				expect(
					await tenant.feederSession.findUniqueOrThrow({
						where: { id: nextFeeder.id },
					}),
				).toMatchObject({ status: "PUSHING" });
				expect(f.deps.enqueueFeederJob).not.toHaveBeenCalled();
				expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			} finally {
				resume.release();
				await owner;
			}
		});

		it("keeps the secondary terminal receipt on the exact account and settles after the primary finishes", async () => {
			const f = await dispatchFixture();
			const secondary = randomUUID();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { previousProviderEncodingIds: [secondary] },
			});
			vi.mocked(f.sdk.getEncodingStatus).mockImplementation(async (id) => ({
				status: id === secondary ? "CANCELED" : "RUNNING",
			}));
			expect(await createLiveChannelProcessor(f.deps)(f.job)).toMatchObject({
				status: "EFFECT_AMBIGUOUS",
			});
			const failed = await tenant.liveEffectClaim.findFirstOrThrow({
				where: { liveChannelRunId: f.run.id },
			});
			expect(failed.stopOutcomeEvidence).toMatchObject({
				accountId: f.accountId,
				requiredEncodingIds: [f.encodingId, secondary],
				encodings: [{ id: secondary, status: "CANCELED" }],
			});
			vi.mocked(f.sdk.getEncodingStatus)
				.mockClear()
				.mockImplementation(async (id) => {
					if (id !== f.encodingId) throw new Error("unexpected repeated GET");
					return { status: "FINISHED" };
				});
			await createUncertainStopReconciler(f.deps)();
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: failed.id },
				}),
			).toMatchObject({ state: "ACKED" });
			expect(f.sdk.getEncodingStatus).toHaveBeenCalledWith(f.encodingId);
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledTimes(2);
		});

		it("settles same-encoder STOP siblings only after proving a failed restart's other encoder terminal", async () => {
			const f = await stopFixture();
			const other = "historical-" + randomUUID();
			const older = await tenant.liveEffectClaim.create({
				data: {
					...f.fields,
					generation: 1,
					token: randomUUID(),
					action: "STOP",
					state: "AMBIGUOUS",
					failure: "a prior STOP lost its response",
					idempotencyKey: randomUUID(),
				},
			});
			const restart = await tenant.liveEffectClaim.create({
				data: {
					...f.fields,
					generation: 0,
					token: randomUUID(),
					action: "RESTART",
					state: "FAILED",
					failure: "refused pre-send",
					providerEncodingId: other,
					idempotencyKey: randomUUID(),
				},
			});
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "BLOCKED" });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				status: "STOPPING",
				stopNotificationAt: null,
				endedAt: null,
			});
			f.proof.ownerReadbacks.encodings.push({ id: other, status: "CANCELED" });
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: older.id },
				}),
			).toMatchObject({ state: "ACKED", failure: older.failure });
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: restart.id },
				}),
			).toMatchObject({ state: "FAILED", failure: restart.failure });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				status: "STOPPED",
				heartbeatPollEpoch: 8,
				stopNotificationAt: now,
				endedAt: now,
			});
		});

		it.each([
			"FAILED",
			"AMBIGUOUS",
		] as const)("only a positively pre-send legacy failure permits a new STOPPED notification (%s)", async (state) => {
			const f = await stopFixture();
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { stopProtocolVersion: 1 },
			});
			await tenant.liveEffectClaim.create({
				data: {
					...f.fields,
					action: "STOP",
					state,
					token: randomUUID(),
					idempotencyKey: randomUUID(),
					generation: 1,
					failure: "prior credentials unavailable",
				},
			});
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(state === "FAILED" ? 1 : 0);
		});

		it.each([
			1, 2, 4,
		])("upgrades the same ordinary legacy STOP key after %i pre-send failures", async (attempt) => {
			const f = await dispatchFixture();
			await tenant.liveEffectClaim.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					action: "STOP",
					state: "FAILED",
					attempt,
					token: randomUUID(),
					generation: 0,
					ownerId: "legacy",
					idempotencyKey: f.job.effect.idempotencyKey,
					expiresAt: lease,
					dispatchedAt: lease,
					failure: "no credentials",
				},
			});
			const result = await createLiveChannelProcessor(f.deps)(f.job);
			expect(result.status).toBe("STOPPED");
			expect(
				await tenant.liveStopNotification.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ kind: "CHANNEL_STOPPED" });
		});

		it("records an ambiguous scheduled retry over its own earlier failed receipt in the same transaction", async () => {
			const f = await dispatchFixture();
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: lease,
					outcome: "FAILED",
					outcomeEvidenceKind: "EFFECT_FAILED",
				},
			});
			await tenant.liveEffectClaim.create({
				data: {
					...f.identity,
					liveChannelId: f.channel.id,
					state: "FAILED",
					token: randomUUID(),
					generation: 0,
					ownerId: "legacy",
					scheduleId: schedule.id,
					idempotencyKey: `schedule:${schedule.id}:stop`,
					expiresAt: lease,
				},
			});
			const claim = await beginLiveEffect(tenant, {
				...f.identity,
				liveChannelId: f.channel.id,
				expectedFenceVersion: 0,
				idempotencyKey: `schedule:${schedule.id}:stop`,
				scheduleId: schedule.id,
				ownerId: "retry",
				now,
				expiresAt: new Date(now.getTime() + 60000),
			});
			if (claim.kind !== "EXECUTE") throw new Error("expected retry claim");
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).toMatchObject({ outcome: "PENDING" });
			await claimLiveStopSend(tenant, claim.claim, f.encodingId, now);
			expect(
				await markLiveEffectAmbiguous(
					tenant,
					claim.claim,
					"archive proof unavailable",
				),
			).toBe(true);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: claim.claim.id },
				}),
			).toMatchObject({ state: "AMBIGUOUS" });
		});

		it("a worker that wins the race with the enqueue reply records one schedule handoff and one fired event", async () => {
			const f = await dispatchFixture();
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: lease,
					firedAt: lease,
				},
			});
			const emitEvent = vi.fn(async () => {});
			const process = createLiveChannelProcessor({ ...f.deps, emitEvent });
			const job = {
				...f.job,
				plannedLiveChannelRunId: f.run.id,
				effect: {
					...f.job.effect,
					scheduleId: schedule.id,
					idempotencyKey: `schedule:${schedule.id}:stop`,
				},
			};
			const id = `sched-${schedule.id}`;
			await process(job, id);
			await process(job, id);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).toMatchObject({
				dispatchedAt: now,
				dispatchJobId: id,
				outcome: "DELIVERED",
			});
			expect(
				await tenant.liveStopNotification.findMany({
					where: { scheduleId: schedule.id },
				}),
			).toEqual([
				expect.objectContaining({
					kind: "SCHEDULE_FIRED",
					channelId: f.channel.id,
					occurredAt: now,
				}),
			]);
		});

		it("delivers the original pending stop after the channel and run have been deleted", async () => {
			// Other cases exercise the same organization's dispatcher. This case needs its
			// own pending row in the first bounded page regardless of generated UUID order.
			await tenant.liveStopNotification.deleteMany({});
			const f = await stopFixture();
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { stopProtocolVersion: 1 },
			});
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			await tenant.liveChannel.delete({ where: { id: f.channel.id } });
			const where = { id: f.run.id };
			expect(await tenant.liveChannelRun.findUnique({ where })).toBeNull();
			expect(
				await otherTenant.liveStopNotification.findUnique({ where }),
			).toBeNull();
			expect(
				await tenant.liveStopNotification.findUnique({ where }),
			).toMatchObject({ channelName: f.channel.name, kind: "CHANNEL_STOPPED" });
			let clock = now;
			let failed = false;
			const calls: unknown[] = [];
			const sweep = createStopNotificationSweep(
				tenant,
				async ({ data, beforeSend }) => {
					if (
						(data as { liveChannelId: string }).liveChannelId !== f.channel.id
					)
						return [];
					await beforeSend?.();
					calls.push(data);
					if (!failed) {
						failed = true;
						throw new Error("test delivery failure");
					}
					return [{ outcome: "DELIVERED" }];
				},
				"https://bitovp.example",
				() => clock,
			);
			// Other schedules and broadcasts can precede this event in the bounded tenant queue.
			for (let pass = 0; pass < 20 && calls.length === 0; pass++) await sweep();
			expect(
				await tenant.liveStopNotification.findUnique({ where }),
			).toMatchObject({ failures: 1, leaseToken: null });
			await sweep();
			expect(calls).toHaveLength(1);
			clock = new Date(now.getTime() + 1_000);
			await sweep();
			expect(calls).toEqual([
				expect.objectContaining({
					name: f.channel.name,
					kind: "CHANNEL_STOPPED",
					link: `https://bitovp.example/live/${f.channel.id}`,
				}),
				calls[0],
			]);
			expect(
				await tenant.liveStopNotification.findUnique({ where }),
			).toMatchObject({
				failures: 1,
				nextAttemptAt: null,
				finishedAt: clock,
				failureReason: null,
			});
			await sweep();
			expect(calls).toHaveLength(2);
			expect(
				await otherTenant.liveStopNotification.findUnique({ where }),
			).toBeNull();
		});

		it("prevents an expired consumer from sending after a replacement has settled the broadcast notification", async () => {
			const f = await stopFixture();
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { stopProtocolVersion: 1 },
			});
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			let clock = now;
			const entered = barrier();
			const resume = barrier();
			const delivered = vi.fn();
			const slow = createStopNotificationSweep(
				tenant,
				async ({ data, beforeSend }) => {
					if (
						(data as { liveChannelId: string }).liveChannelId !== f.channel.id
					)
						return [];
					entered.release();
					await resume.ready;
					await beforeSend?.();
					delivered("stale");
					return [{ outcome: "DELIVERED" }];
				},
				undefined,
				() => clock,
			)();
			try {
				await entered.ready;
				clock = new Date(now.getTime() + 120_000);
				await createStopNotificationSweep(
					tenant,
					async ({ beforeSend, data }) => {
						if (
							(data as { liveChannelId: string }).liveChannelId !== f.channel.id
						)
							return [];
						await beforeSend?.();
						delivered("replacement");
						return [{ outcome: "DELIVERED" }];
					},
					undefined,
					() => clock,
				)();
			} finally {
				resume.release();
				await slow;
			}
			expect(delivered.mock.calls).toEqual([["replacement"]]);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ stopNotificationState: "PROCESSED" });
		});

		it("keeps the newest completed and failed STOP delivery histories for each tenant", async () => {
			const channelId = randomUUID();
			const base = {
				channelId,
				channelName: "retention",
				kind: "CHANNEL_STOPPED",
				occurredAt: lease,
			};
			try {
				for (const [failures, limit] of [
					[0, 1000],
					[5, 5000],
				] as const) {
					await otherTenant.liveStopNotification.createMany({
						data: Array.from({ length: limit }, () => ({
							...base,
							id: randomUUID(),
							failures,
							finishedAt: lease,
							nextAttemptAt: null,
							failureReason: failures ? "expired" : null,
						})),
					});
					await otherTenant.liveStopNotification.create({
						data: {
							...base,
							id: randomUUID(),
							failures: failures ? 4 : 0,
							kind: failures ? "CHANNEL_ERROR" : "CHANNEL_STOPPED",
							nextAttemptAt: now,
						},
					});
				}
				await createStopNotificationSweep(
					otherTenant,
					async ({ data }) => {
						if ((data as { kind: string }).kind === "CHANNEL_ERROR")
							throw new Error("private destination");
						return [{ outcome: "DELIVERED" }];
					},
					undefined,
					() => now,
				)();
				for (const [reason, limit] of [
					[false, 1000],
					[true, 5000],
				] as const) {
					const where = {
						channelId,
						finishedAt: { not: null },
						failureReason: reason ? { not: null } : null,
					};
					expect(await otherTenant.liveStopNotification.count({ where })).toBe(
						limit,
					);
					expect(await tenant.liveStopNotification.count({ where })).toBe(0);
					expect(
						await otherTenant.liveStopNotification.count({
							where: { ...where, finishedAt: now },
						}),
					).toBe(1);
				}
			} finally {
				await otherTenant.liveStopNotification.deleteMany({
					where: { channelId },
				});
			}
		});

		it.each([
			"host",
			"config",
			"none",
			"partial",
		] as const)("records actual webhook delivery with %s destinations", async (mode) => {
			const f = await stopFixture();
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { stopProtocolVersion: 1 },
			});
			await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof);
			const ch = {
				id: randomUUID(),
				name: "private-name",
				kind: "GENERIC_WEBHOOK",
				credentialId: "refused",
				rules: [{ events: ["CHANNEL_STOPPED"], filter: {} }],
			};
			const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
			const deliver = createNotifyProcessor({
				prisma: {
					notificationChannel: {
						findMany: async () =>
							mode === "none"
								? []
								: [
										ch,
										...(mode === "partial"
											? [{ ...ch, id: randomUUID(), credentialId: "ok" }]
											: []),
									],
					},
				},
				egressAllowlist: () => ["allowed.example"],
				revealWebhookUrl: async (id) =>
					id === "ok"
						? "https://allowed.example/events"
						: mode === "config"
							? "malformed"
							: "https://refused.example/events",
				fetchImpl,
			});
			const process = createStopNotificationSweep(
				tenant,
				async (job) =>
					(job.data as { liveChannelId: string }).liveChannelId === f.channel.id
						? deliver(job)
						: [],
				undefined,
				() => now,
			);
			await process();
			await process();
			expect(fetchImpl).toHaveBeenCalledTimes(mode === "partial" ? 1 : 0);
			const row = await tenant.liveStopNotification.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(row).toMatchObject({
				nextAttemptAt: null,
				skipped: mode === "none",
				failures: mode === "none" ? 0 : 1,
				failureReason:
					mode === "none"
						? null
						: "A notification destination refused delivery",
			});
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				stopNotificationState: mode === "none" ? "NO_DESTINATION" : "FAILED",
			});
		});
		it("records a terminal failed delivery after five known failures", async () => {
			const f = await stopFixture();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { lastHeartbeatAt: lease },
			});
			await tenant.liveEffectClaim.update({
				where: { id: f.claim.id },
				data: { stopProtocolVersion: 1 },
			});
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			let clock = now;
			let attempts = 0;
			const sweep = createStopNotificationSweep(
				tenant,
				async ({ data, beforeSend }) => {
					if (
						(data as { liveChannelId: string }).liveChannelId !== f.channel.id
					)
						return [];
					await beforeSend?.();
					attempts++;
					throw new Error("simulated destination outage");
				},
				undefined,
				() => clock,
			);
			for (let attempt = 0; attempt < 6; attempt++) {
				await sweep();
				clock = new Date(clock.getTime() + 60_000);
			}
			expect(attempts).toBe(5);
			expect(
				await tenant.liveStopNotification.findUnique({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				failures: 5,
				nextAttemptAt: null,
				failureReason: "Notification processing failed",
			});
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				stopNotificationState: "FAILED",
				lastHeartbeatAt: lease,
			});
		});

		it("returns the durable winner when the late owner tries to report failure, even after re-air", async () => {
			const f = await stopFixture();
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "RESOLVED" });
			const successor = "successor-" + randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "RUNNING", bitmovinEncodingId: successor },
			});
			await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: successor,
					outputPrefix: "",
				},
			});
			expect(
				await recordLiveStopFailure(
					tenant,
					{ ...f.claim, action: "STOP" },
					{
						state: "AMBIGUOUS",
						status: "ERROR",
						error: "late",
						failure: "late",
						at: now,
					},
				),
			).toBe("ALREADY_ACKED");
			expect(
				await resolveLiveEffectsAfterConfirmedStop(tenant, f.proof),
			).toMatchObject({ kind: "ALREADY_ACKED" });
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "RUNNING",
				bitmovinEncodingId: successor,
				error: null,
			});
		});

		it("two periodic observers acknowledge the exact uncertain STOP once after both read its terminal encoder", async () => {
			const f = await fixture("ERROR", null);
			const error = "provider response lost";
			const account = await tenant.bitmovinAccount.create({
				data: { label: "Synthetic STOP readback", encryptedApiKey: "unused" },
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan: { bitmovin: { accountId: account.id } }, error },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { error },
			});
			const scheduled = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					fireAt: lease,
					status: "FIRED",
					outcome: "UNKNOWN",
					outcomeNote: "original lost response",
					outcomeAt: lease,
					outcomeEvidenceAt: lease,
					outcomeEvidenceVersion: 1,
					outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				},
			});
			const claim = await tenant.liveEffectClaim.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					generation: f.channel.liveEffectFenceVersion,
					action: "STOP",
					stopProtocolVersion: 1,
					state: "DISPATCHING",
					stopSendEncodingIds: [f.encodingId],
					scheduleId: scheduled.id,
					idempotencyKey: `schedule:${scheduled.id}:stop`,
					token: randomUUID(),
					ownerId: "synthetic",
					dispatchedAt: lease,
					expiresAt: now,
				},
			});
			expect(
				await recordLiveStopFailure(
					tenant,
					{ ...claim, action: "STOP" },
					{
						status: "ERROR",
						state: "AMBIGUOUS",
						error,
						failure: liveEffectSendUncertainty(error),
						accountId: account.id,
						requiredEncodingIds: [f.encodingId],
						at: now,
					},
				),
			).toBe("RECORDED");
			const bothRead = barrier();
			const getEncodingStatus = vi.fn(async () => {
				if (getEncodingStatus.mock.calls.length === 2) bothRead.release();
				await bothRead.ready;
				return { status: "FINISHED" };
			});
			const sdk = fakeSdk({ getEncodingStatus });

			const deps = {
				prisma: tenant,
				now: () => now.toISOString(),
				revealBitmovinAccount: async (id: string) => {
					expect(id).toBe(account.id);
					return { apiKey: "mock", tenantOrgId: null };
				},
				makeSdk: () => sdk,
			};
			const results = await Promise.all([
				createUncertainStopReconciler(deps)(),
				createUncertainStopReconciler(deps)(),
			]);
			expect(results.sort()).toEqual([0, 1]);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: scheduled.id },
				}),
			).toEqual(scheduled);
			const runAfterAck = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(runAfterAck).toMatchObject({
				stopNotificationAt: now,
				stopNotificationKind: "CHANNEL_STOPPED",
				stopNotificationState: "PENDING",
			});
			const events: unknown[] = [];
			const deliver = async (job: {
				data: unknown;
				beforeSend?: () => Promise<void>;
			}) => {
				await job.beforeSend?.();
				events.push(job.data);
				return [{ outcome: "DELIVERED" as const }];
			};
			await createStopNotificationSweep(otherTenant, deliver)();
			expect(events).toEqual([]);
			await Promise.all([
				createStopNotificationSweep(tenant, deliver)(),
				createStopNotificationSweep(tenant, deliver)(),
			]);
			await createStopNotificationSweep(tenant, deliver)();
			expect(
				events.filter(
					(e) =>
						(e as { liveChannelId: string }).liveChannelId === f.channel.id,
				),
			).toEqual([
				expect.objectContaining({
					kind: "CHANNEL_STOPPED",
					liveChannelId: f.channel.id,
					name: f.channel.name,
					occurredAt: now.toISOString(),
				}),
			]);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ stopNotificationState: "PROCESSED" });
			expect(getEncodingStatus.mock.calls).toEqual([
				[f.encodingId],
				[f.encodingId],
			]);
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "STOPPED",
				error: null,
				liveEffectFenceVersion: f.channel.liveEffectFenceVersion + 1,
			});
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				status: "STOPPED",
				error: null,
				providerStatus: "FINISHED",
				providerTerminalAt: now,
				providerStatusObservedAt: now,
			});
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { id: claim.id },
				}),
			).toMatchObject({
				state: "ACKED",
				acknowledgedAt: now,
				failure: liveEffectSendUncertainty(error),
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "RUNNING", bitmovinEncodingId: "new-encoding" },
			});
			await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: "new-encoding",
					outputPrefix: "",
				},
			});
			const process = createLiveChannelProcessor({
				...deps,
				sleep: async () => {},
				pollIntervalMs: 10,
				pollTimeoutMs: 250,
				enqueueFeederJob: async () => {},
				resolveCredential: async () => {
					throw new Error("no credential required");
				},
			});
			const replay = await process({
				liveChannelId: f.channel.id,
				action: "stop",
				plannedLiveChannelRunId: f.run.id,
				effect: {
					scheduleId: scheduled.id,
					idempotencyKey: claim.idempotencyKey,
					action: "STOP",
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					admissionFenceVersion: claim.generation,
				},
			});
			expect(replay.status).toBe("EFFECT_ALREADY_ACKNOWLEDGED");
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: scheduled.id },
				}),
			).toEqual(scheduled);
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
		}, 15_000);

		it("finishes only the interrupted STOP's pending schedule and preserves its receipts on redelivery after re-air", async () => {
			const f = await fixture("STOPPED", null);
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					providerStatus: "FINISHED",
					providerStatusObservedAt: lease,
					providerTerminalAt: lease,
				},
			});
			const scheduleData = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP" as const,
				status: "FIRED" as const,
				fireAt: lease,
				dispatchedAt: lease,
			};
			const own = await tenant.liveSchedule.create({ data: scheduleData });
			const unrelated = await tenant.liveSchedule.create({
				data: scheduleData,
			});
			const effect = {
				idempotencyKey: `schedule:${own.id}:stop`,
				scheduleId: own.id,
				action: "STOP" as const,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				admissionFenceVersion: f.channel.liveEffectFenceVersion,
			};
			await tenant.liveEffectClaim.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					action: "STOP",
					scheduleId: own.id,
					idempotencyKey: effect.idempotencyKey,
					token: randomUUID(),
					generation: f.channel.liveEffectFenceVersion,
					state: "DISPATCHING",
					ownerId: "interrupted-owner",
					dispatchedAt: lease,
					expiresAt: lease,
				},
			});
			const sdk = fakeSdk();
			const deps: LiveChannelDeps = {
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => sdk,
				sleep: async () => {},
				pollIntervalMs: 10,
				pollTimeoutMs: 250,
				enqueueFeederJob: async () => {},
				resolveCredential: async () => {
					throw new Error("no credential required");
				},
				revealBitmovinAccount: async () => {
					throw new Error("no account required");
				},
			};
			expect(await createUncertainStopReconciler(deps)()).toBe(1);
			const receipt = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: own.id },
			});
			expect(receipt).toMatchObject({
				status: "FIRED",
				outcome: "DELIVERED",
				outcomeEvidenceKind: "PROVIDER_TERMINAL",
				outcomeEvidenceAt: now,
			});
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: unrelated.id },
				}),
			).toEqual(unrelated);
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({
				endedAt: now,
				stopNotificationKind: "CHANNEL_STOPPED",
				stopNotificationState: "LEGACY_UNKNOWN",
			});
			expect(
				await tenant.liveStopNotification.findUnique({
					where: { id: f.run.id },
				}),
			).toBeNull();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "RUNNING", bitmovinEncodingId: "new-broadcast" },
			});
			await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: "new-broadcast",
					outputPrefix: "",
				},
			});
			const process = createLiveChannelProcessor(deps);
			expect(
				await process({
					liveChannelId: f.channel.id,
					action: "stop",
					plannedLiveChannelRunId: f.run.id,
					effect,
				}),
			).toMatchObject({ status: "EFFECT_ALREADY_ACKNOWLEDGED" });
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: own.id } }),
			).toEqual(receipt);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: unrelated.id },
				}),
			).toEqual(unrelated);
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});

		it.each([
			false,
			true,
		])("records exact scheduled STOP delivery after credential lookup recovers (legacy=%s)", async (legacy) => {
			const f = await fixture("STOPPING", null);
			const accountId = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { plan: { bitmovin: { accountId } } },
			});
			const data = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP" as const,
				status: "FIRED" as const,
				fireAt: lease,
			};
			const own = await tenant.liveSchedule.create({ data });
			const unrelated = await tenant.liveSchedule.create({
				data: {
					...data,
					outcome: "FAILED",
					outcomeEvidenceKind: "EFFECT_FAILED",
					outcomeAt: lease,
				},
			});
			const sdk = fakeSdk({
				getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" as const })),
			});
			const process = createLiveChannelProcessor({
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => sdk,
				sleep: async () => {},
				pollIntervalMs: 1,
				pollTimeoutMs: 100,
				enqueueFeederJob: async () => {},
				resolveCredential: async () => {
					throw new Error("no credential expected");
				},
				revealBitmovinAccount: vi
					.fn(async () => ({ apiKey: "mock", tenantOrgId: null }))
					.mockRejectedValueOnce(new Error("temporary account lookup failure")),
			});
			const job = {
				liveChannelId: f.channel.id,
				action: "stop",
				plannedLiveChannelRunId: f.run.id,
				effect: {
					idempotencyKey: `schedule:${own.id}:stop`,
					action: "STOP",
					scheduleId: own.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					admissionFenceVersion: f.channel.liveEffectFenceVersion,
				},
			};
			const dataForQueue = legacy
				? {
						liveChannelId: f.channel.id,
						action: "stop",
						plannedLiveChannelRunId: f.run.id,
					}
				: job;
			const queueId = `sched-${own.id}`;
			await expect(process(dataForQueue, queueId, true)).rejects.toThrow(
				"temporary account lookup failure",
			);
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: own.id } }),
			).toMatchObject({
				outcome: "FAILED",
				outcomeEvidenceKind: "EFFECT_FAILED",
			});
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(await process(dataForQueue, queueId, false)).toMatchObject({
				status: "STOPPED",
			});
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: own.id } }),
			).toMatchObject({
				outcome: "DELIVERED",
				outcomeEvidenceKind: "PROVIDER_TERMINAL",
			});
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: unrelated.id } }),
			).toEqual(unrelated);
			expect(sdk.stopLiveEncoding).toHaveBeenCalledTimes(1);
		});

		it("retires the bound run on final failure and preserves it when legacy STOP jobs arrive after re-air", async () => {
			const f = await fixture("STOPPING", null);
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { lastHeartbeatAt: lease },
			});
			const plan = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				fireAt: lease,
				action: "STOP" as const,
				status: "FIRED" as const,
				dispatchedAt: lease,
			};
			const scheduled = await tenant.liveSchedule.create({ data: plan });
			const legacy = await tenant.liveSchedule.create({ data: plan });
			const job = {
				id: `sched-${scheduled.id}`,
				attemptsMade: 5,
				opts: { attempts: 5 },
				data: {
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
					action: "stop",
					effect: {
						action: "STOP",
						scheduleId: scheduled.id,
						idempotencyKey: `schedule:${scheduled.id}:stop`,
						liveChannelRunId: f.run.id,
						providerEncodingId: f.encodingId,
						admissionFenceVersion: f.channel.liveEffectFenceVersion,
					},
				},
			};
			expect(await recordFinalStopFailure(tenant, job, "exhausted")).toBe(true);
			await recordDeadJobScheduleOutcomes(tenant, job, "exhausted", now);
			const failed = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(failed).toMatchObject({
				status: "ERROR",
				endedAt: expect.any(Date),
				error: expect.stringContaining("exhausted"),
				lastHeartbeatAt: lease,
			});
			const originalReceipt = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: scheduled.id },
			});
			expect(originalReceipt).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			const successor = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: f.channel.id,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: randomUUID(),
					outputPrefix: "",
				},
			});
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "RUNNING",
					error: null,
					bitmovinEncodingId: successor.bitmovinEncodingId,
					liveEffectFenceVersion: { increment: 1 },
				},
			});
			expect(await recordFinalStopFailure(tenant, job, "late callback")).toBe(
				false,
			);
			const sdk = fakeSdk();
			const process = createLiveChannelProcessor({
				prisma: tenant,
				now: () => now.toISOString(),
				makeSdk: () => sdk,
				sleep: async () => {},
				pollIntervalMs: 1,
				pollTimeoutMs: 100,
				enqueueFeederJob: async () => {},
				resolveCredential: async () => {
					throw new Error("no credential expected");
				},
				revealBitmovinAccount: async () => {
					throw new Error("no account expected");
				},
			});
			const old = {
				liveChannelId: f.channel.id,
				plannedLiveChannelRunId: f.run.id,
				action: "stop",
			};
			expect(await process(old, `sched-${legacy.id}`)).toMatchObject({
				status: "SKIPPED_STALE_GENERATION",
			});
			expect(await process(old, `sched-${scheduled.id}`)).toMatchObject({
				status: "SKIPPED_STALE_GENERATION",
			});
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: legacy.id } }),
			).toMatchObject({
				outcome: "FAILED",
				outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
			});
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: scheduled.id } }),
			).toEqual(originalReceipt);
			expect(
				await tenant.liveChannelRun.findUnique({ where: { id: successor.id } }),
			).toEqual(successor);
			expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});

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

		it("retains an accepted run-only stop revision through ERROR revival and rolls back a lost finalization lease", async () => {
			const f = await fixture("RUNNING", null);
			const claim = {
				id: randomUUID(),
				idempotencyKey: `synthetic:${randomUUID()}`,
				token: randomUUID(),
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				providerEncodingId: f.encodingId,
				action: "AUTO_SHUTDOWN_UPDATE" as const,
				generation: f.channel.liveEffectFenceVersion,
				expiresAt: new Date(now.getTime() - 60_000),
			};
			await tenant.liveEffectClaim.create({
				data: { ...claim, state: "AMBIGUOUS", ownerId: "synthetic-owner" },
			});
			const receipt: StepLogEntry = {
				step: claim.idempotencyKey,
				kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
				status: "DONE",
				refs: {},
				payload: liveAutoShutdownUpdateReceiptSchema.parse({
					requestId: claim.idempotencyKey,
					configuration: { streamTimeoutMinutes: 5 },
					appliedAt: now.toISOString(),
					scheduledShutdownAt: new Date(
						now.getTime() + 5 * 60_000,
					).toISOString(),
				}),
			};
			expect(
				await appendLiveEffectStepLogEntry(tenant, claim, receipt),
			).toEqual({
				runUpdated: 1,
				channelUpdated: 0,
			});
			await tenant.liveEffectClaim.update({
				where: { id: claim.id },
				data: { state: "ACKED" },
			});
			const heartbeatAt = new Date(now.getTime() - 120_000);
			await tenant.$transaction(async (tx) => {
				await tx.liveChannel.update({
					where: { id: f.channel.id },
					data: { status: "ERROR", error: "synthetic local failure" },
				});
				await tx.liveChannelRun.update({
					where: { id: f.run.id },
					data: {
						status: "ERROR",
						error: "synthetic local failure",
						providerStatus: "RUNNING",
						providerStatusObservedAt: now,
						endedAt: now,
						lastHeartbeatAt: heartbeatAt,
					},
				});
			});
			// Match Start's same-run revival: channel history has no receipt,
			// and the historical run keeps the existing encoder and evidence.
			await tenant.$transaction(async (tx) => {
				await tx.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						status: "PROVISIONING",
						error: null,
						provisionClaimedAt: lease,
						liveEffectFenceVersion: { increment: 1 },
					},
				});
				await tx.liveChannelRun.update({
					where: { id: f.run.id },
					data: { status: "PROVISIONING", error: null, endedAt: null },
				});
			});
			const currentRun = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			const snapshot = [
				{
					step: "await:running",
					kind: "AWAIT_LIVE_RUNNING",
					status: "DONE",
					payload: {},
					refs: {},
				},
			] satisfies StepLogEntry[];
			const finalize = (heldAt: Date) =>
				reconciler().door.commitRunning({
					channel: f.channel,
					run: currentRun,
					encodingId: f.encodingId,
					observation: {
						ok: true,
						status: "RUNNING",
						observedAt: now.toISOString(),
					},
					coordinates: {},
					provisionClaimedAt: heldAt,
					stepLog: snapshot,
				});
			expect(await finalize(new Date(lease.getTime() + 1_000))).toBe(false);
			const refused = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(refused.status).toBe("PROVISIONING");
			expect(refused.stepLog).toEqual([receipt]);
			expect(await finalize(lease)).toBe(true);
			const committed = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(committed.status).toBe("RUNNING");
			expect(committed.stepLog).toEqual([...snapshot, receipt]);
			expect(committed.lastHeartbeatAt).toEqual(heartbeatAt);
			expect(committed.endedAt).toBeNull();
			expect(readLiveAutoShutdownUpdate(committed.stepLog)?.requestId).toBe(
				claim.idempotencyKey,
			);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).stepLog,
			).toEqual(snapshot);
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
