import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	compileAisaManagedLiveChannel,
	compileLiveChannel,
	initStepLog,
	type LiveToVodRecord,
	liveAutoShutdownUpdateReceiptSchema,
	liveChannelPlanSchema,
	productEventSchema,
	readLiveAutoShutdownUpdate,
	type StepLogEntry,
	scheduledStopJobId,
} from "@bitovp/core";
import { AisaLiveError } from "@bitovp/core/aisa-live-client";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	appendLiveEffectStepLogEntry,
	archivedStopRevision,
	assertLiveEffectCurrent,
	beginLiveEffect,
	bindArchivedStopTarget,
	claimLiveStopSend,
	createPrismaClient,
	createTenantPrismaClient,
	type LiveChannelStatus,
	liveEffectSendUncertainty,
	markLiveEffectAmbiguous,
	markLiveEffectFailed,
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
import { adoptOrCreateStamped } from "../orchestrator/ops/shared";
import { createBitmovinSdkOps } from "../orchestrator/sdk-ops";
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
import { createExhaustedProvisionRecovery } from "./exhausted-provisions";
import { createExhaustedScheduledStopRecovery } from "./exhausted-scheduled-stops";
import { readLegacyScheduledStop } from "./legacy-scheduled-stop";
import { requestProbeStop } from "./probe-runner";
import {
	createProviderLifecycleReconciler,
	type RunLifecycleRow,
} from "./provider-lifecycle";
import { resolveProvisionAdmission } from "./provision-admission";
import { commitProvisionEnd } from "./provision-outcome";
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
					await admin.startupSample.deleteMany({
						where: { organizationId: { in: organizationIds } },
					});
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
			scope = tenant,
		) {
			const channel = await scope.liveChannel.create({
				data: {
					name: "Owned transition lock test",
					status,
					plan: {},
					bitmovinEncodingId: encodingId,
					provisionClaimedAt: heldAt,
				},
			});
			const run = await scope.liveChannelRun.create({
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

		it("a manual RESTART cannot publish a stopped airing while its run-only encoder is still running", async () => {
			const f = await dispatchFixture();
			const second = randomUUID();
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			plan.bitmovin.accountId = f.accountId;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "PROVISIONING", plan },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					stepLog: [
						{
							step: "prior",
							kind: "CREATE_ENCODING",
							status: "DONE",
							resourceId: second,
							refs: {},
							payload: {},
						},
					],
				},
			});
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === second ? "RUNNING" : "FINISHED",
			}));
			const process = createLiveChannelProcessor(f.deps);
			const effect = {
				...f.identity,
				action: "RESTART" as const,
				idempotencyKey: "manual:restart:" + randomUUID(),
				admissionFenceVersion: 0,
			};
			await expect(
				process({ liveChannelId: f.channel.id, action: "restart", effect }),
			).rejects.toThrow(/unconfirmed|cannot be confirmed|retirement/i);
			expect(f.sdk.getEncodingStatus).toHaveBeenCalledWith(second);
			expect(f.sdk.restartLiveEncoding).not.toHaveBeenCalled();
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ providerTerminalAt: null });
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(false);
		});
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
			"non-poll",
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
			if (source === "run-log" || source === "non-poll")
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
					...(source === "non-poll" ? {} : { fence: { epoch: 7 } }),
				});
			expect((await tick()).channelLanded).toBe(false);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			finished = true;
			expect((await tick()).channelLanded).toBe(true);
			expect(sdk.getEncodingStatus).toHaveBeenCalledWith(secondary);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(1);
		});
		it.each([
			"own",
			"wrong-account",
			"restart",
		] as const)("uses the archived never-started proof only for an unchanged rental: %s", async (receipt) => {
			const f = await dispatchFixture();
			const archived = randomUUID();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					previousProviderEncodingIds: [archived],
					archivedRtmpAttempt: 1,
					rtmpRetirementEvidence: [
						{
							accountId:
								receipt === "wrong-account" ? randomUUID() : f.accountId,
							encodingId: archived,
							observedAt: lease.toISOString(),
							disposition: "NEVER_STARTED",
							providerStatus: "CREATED",
						},
					],
				},
			});
			await tenant.liveEffectClaim.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					idempotencyKey: randomUUID(),
					action: receipt === "restart" ? "RESTART" : "STOP",
					providerEncodingId: archived,
					generation: 0,
					token: randomUUID(),
					expiresAt: lease,
					state: "FAILED",
					ownerId: "prior",
				},
			});
			const h = reconciler();
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === archived ? "CREATED" : "FINISHED",
			}));
			const result = await h.door.reconcile({
				channel: await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
				run: await h.door.loadCurrentRun(f.channel.id),
				encodingId: f.encodingId,
				sdk: f.sdk,
				fence: { epoch: 7 },
			});
			expect(result.channelLanded).toBe(receipt === "own");
			expect(
				vi.mocked(f.sdk.getEncodingStatus).mock.calls.map(([id]) => id),
			).toEqual(receipt === "own" ? [f.encodingId] : [f.encodingId, archived]);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(receipt === "own" ? 1 : 0);
		});
		it.each([
			[true, "FINISHED"],
			[false, "FINISHED"],
			[false, "ERROR"],
		] as const)("keeps the airing open until the publishing feeder exits (run bound=%s, status=%s)", async (bound, status) => {
			const f = await dispatchFixture();
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status }));
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
			).toBe(status === "FINISHED" ? 1 : 0);
		});
		it.each([
			false,
			true,
			"word-only",
			"channel-only",
			"run-only-open",
			"run-only-sealed",
		] as const)("recovers an unbound legacy publisher on the current terminal ERROR before permitting another airing (sealed=%s)", async (sealed) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "ERROR",
					...(sealed === "run-only-open" || sealed === "run-only-sealed"
						? { bitmovinEncodingId: null }
						: {}),
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "ERROR",
					providerTerminalAt: sealed === "word-only" ? null : lease,
					...(sealed === "channel-only" ? { bitmovinEncodingId: null } : {}),
					providerFeederStopsEnqueuedAt:
						sealed && sealed !== "run-only-open" ? lease : null,
					providerStatus: "ERROR",
					providerStatusObservedAt: lease,
				},
			});
			const feeder = await tenant.feederSession.create({
				data: {
					liveChannelId: f.channel.id,
					status: "PUSHING",
					protocol: "RTMP",
					sourceBucket: "fixture",
					sourceKey: "fixture.mp4",
					sourceCredentialId: randomUUID(),
					target: {},
				},
			});
			const canStart = async () =>
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired;
			expect(await canStart()).toBe(false);
			const h = reconciler();
			await h.door.retryPendingTerminalFeederStops();
			expect(h.enqueueFeederJob).toHaveBeenCalledWith({
				feederSessionId: feeder.id,
				action: "stop",
			});
			await tenant.feederSession.update({
				where: { id: feeder.id },
				data: { status: "STOPPED", stoppedAt: now },
			});
			expect(await canStart()).toBe(true);
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

		async function snapshotLegacyAdmissions() {
			const migration = readFileSync(
				new URL(
					"../../../../packages/db/prisma/migrations/20261125133000_live_start_admission/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			const bootstrap = migration.slice(migration.indexOf("DO $$"));
			await admin.$executeRawUnsafe(bootstrap);
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
			await snapshotLegacyAdmissions();
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

		it("does not let an ordinary armed schedule replace a run with an AISA Analysis", async () => {
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
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { aisaAnalysisId: randomUUID() },
			});
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "START",
					fireAt: now,
				},
			});
			const enqueue = vi.fn(async () => {});
			await createScheduleSweep({ prisma: tenant, now: () => now, enqueue })();
			expect(enqueue).not.toHaveBeenCalledWith(
				expect.objectContaining({ liveChannelId: f.channel.id }),
				expect.anything(),
			);
			expect(
				await tenant.liveChannelRun.count({
					where: { liveChannelId: f.channel.id },
				}),
			).toBe(1);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).not.toMatchObject({ status: "FIRED" });
			// A pre-upgrade handoff can already be FIRED. A delayed queue
			// delivery and the database recovery pass must both refuse its target.
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "PROVISIONING",
					liveEffectFenceVersion: 4,
					legacyAdmissionFenceVersion: 4,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "PROVISIONING", legacyProvisionAdmissionAt: now },
			});
			await tenant.liveSchedule.update({
				where: { id: schedule.id },
				data: {
					status: "FIRED",
					firedAt: now,
					dispatchedAt: now,
					dispatchJobId: `sched-${schedule.id}`,
					startAdmissionFenceVersion: 4,
				},
			});
			const payload = {
				plannedLiveChannelRunId: f.run.id,
				provisionFenceVersion: 4,
			};
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					payload,
					`sched-${schedule.id}`,
				),
			).toBeNull();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					payload,
					`resume-provision-${f.channel.id}-${f.run.id}-4`,
				),
			).toBeNull();
			const recover = createExhaustedProvisionRecovery(
				tenant,
				async () => undefined,
				enqueue,
			);
			for (let i = 0; i < 10; i++) await recover(now);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).toMatchObject({ outcome: "UNKNOWN" });
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "ERROR" });
			expect(enqueue).not.toHaveBeenCalledWith(
				expect.objectContaining({ liveChannelId: f.channel.id }),
				expect.anything(),
			);
			await tenant.liveSchedule.delete({ where: { id: schedule.id } });
		});
		it.each([
			"retained",
			"evicted",
			"unknown evicted",
			"unknown completed",
		])("retires a scheduled START with durable failure before its first lease (%s)", async (retention) => {
			const f = await fixture("PROVISIONING", null);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { liveEffectFenceVersion: 4 },
			});
			const schedule = await tenant.liveSchedule.create({
				data: {
					action: "START",
					status: "FIRED",
					outcome: "PENDING",
					firedAt: now,
					fireAt: now,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					startAdmissionFenceVersion: 4,
				},
			});
			// An exception before the first lease leaves this airing retryable.
			expect(
				await recordScheduleOutcome(
					tenant,
					{
						requireFailedAiring: true,
						scheduledStart: {
							id: schedule.id,
							liveChannelId: f.channel.id,
							liveChannelRunId: f.run.id,
							startAdmissionFenceVersion: 4,
						},
					},
					"FAILED",
					"temporary lookup error",
					now,
					"EFFECT_FAILED",
				),
			).toBe(0);
			await tenant.liveSchedule.update({
				where: { id: schedule.id },
				data: {
					outcome: retention.startsWith("unknown") ? "UNKNOWN" : "FAILED",
				},
			});
			const id = `sched-${schedule.id}`;
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{ plannedLiveChannelRunId: f.run.id, provisionFenceVersion: 4 },
					id,
					undefined,
					"dispatch",
				),
			).toBeNull();
			const enqueue = vi.fn(async () => {});
			const recover = createExhaustedProvisionRecovery(
				tenant,
				async (key) =>
					key === id && ["retained", "unknown completed"].includes(retention)
						? {
								data: {
									action: "provision",
									liveChannelId: f.channel.id,
									plannedLiveChannelRunId: f.run.id,
									provisionFenceVersion: 4,
								},
								getState: async () =>
									retention === "unknown completed" ? "completed" : "failed",
							}
						: undefined,
				enqueue,
			);
			for (let i = 0; i < 10; i++) await recover(now);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).status,
			).toBe("ERROR");
			await createScheduleSweep({
				prisma: tenant,
				now: () => new Date(now.getTime() + 600000),
				enqueue,
			}).dispatchPending();
			expect(enqueue).not.toHaveBeenCalledWith(expect.anything(), id);
			await tenant.liveSchedule.delete({ where: { id: schedule.id } });
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
			// Crash after queue.add and before markDispatched leaves the last
			// SQL write to the run and schedule in the base scheduler's single transaction.
			const row = await tenant.$transaction(async (tx) => {
				if (kind === "scheduled")
					await tx.liveChannelRun.update({
						where: { id: f.run.id },
						data: { updatedAt: new Date(at.getTime() - 100) },
					});
				return tx.liveSchedule.create({
					data: {
						liveChannelId: f.channel.id,
						action: "START",
						liveChannelRunId: kind === "scheduled" ? f.run.id : null,
						status: "FIRED",
						fireAt: now,
						firedAt: now,
					},
				});
			});
			await snapshotLegacyAdmissions();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { maxRunMinutes: 73, updatedAt: new Date(at.getTime() + 10000) },
			});
			const rawManualId = `${f.channel.id}-provision-${at.getTime()}`;
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					rawManualId,
					at.getTime(),
				),
			).toBeNull();
			const id =
				kind === "manual"
					? `resume-provision-${f.channel.id}-${f.run.id}-5`
					: `sched-${row.id}`;
			const data = {
				liveChannelId: f.channel.id,
				action: "provision",
				...(kind === "manual" ? { plannedLiveChannelRunId: f.run.id } : {}),
			};
			const admission = await resolveProvisionAdmission(
				tenant,
				f.channel.id,
				data,
				id,
				at.getTime(),
			);
			expect(admission).toEqual({ runId: f.run.id, generation: 5 });
			if (!admission) throw new Error("missing retained job");
			let requeued = false;
			const readJob = vi.fn(async (key: string) =>
				key === id && (kind === "scheduled" || requeued)
					? {
							id,
							data,
							timestamp: at.getTime(),
							getState: async () => "failed",
						}
					: undefined,
			);
			const recover = createExhaustedProvisionRecovery(
				tenant,
				readJob,
				async (payload, key) => {
					if (key === id) {
						expect(payload).toEqual(data);
						requeued = true;
					}
				},
			);
			for (let i = 0; i < 10; i++) await recover(at);
			const outcome = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(outcome.outcome).toBe(
				kind === "scheduled" ? "UNKNOWN" : "PENDING",
			);

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
			if (kind === "manual") {
				expect(retained).toBeNull();
				expect(
					await recordExpiredProvisionFailure(
						tenant,
						f.channel.id,
						"superseded",
						at,
						at,
						admission,
					),
				).toBe(false);
			} else {
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

		it("preserves an unstamped scheduler handoff committed with its run and refuses earlier deliveries", async () => {
			const f = await fixture("PROVISIONING", null);
			const other = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "START",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
				},
			});
			const heldAt = new Date(Date.now() - 1_000);
			const admitted = await tenant.$transaction(async (tx) => {
				await tx.liveChannelRun.update({
					where: { id: f.run.id },
					data: { updatedAt: heldAt },
				});
				return tx.liveSchedule.create({
					data: {
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						action: "START",
						status: "FIRED",
						fireAt: now,
						firedAt: now,
					},
				});
			});
			await snapshotLegacyAdmissions();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { lastHeartbeatAt: new Date() },
			});
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`sched-${admitted.id}`,
					heldAt.getTime() + 50,
				),
			).toEqual({ runId: f.run.id, generation: 0 });
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`sched-${admitted.id}`,
					heldAt.getTime() - 50,
				),
			).toBeNull();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`sched-${other.id}`,
					Date.now(),
				),
			).toBeNull();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`${f.channel.id}-provision-${heldAt.getTime() - 50}`,
					Date.now(),
				),
			).toBeNull();
		});
		it("leaves conflicting retained START receipts unassigned for both manual and scheduled jobs", async () => {
			const f = await fixture("PROVISIONING", null);
			const at = new Date(Date.now() + 1000);
			const ids = [randomUUID(), randomUUID()];
			await tenant.liveSchedule.createMany({
				data: ids.map((id) => ({
					id,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "START",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
					dispatchedAt: at,
					dispatchJobId: `sched-${id}`,
				})),
			});
			await snapshotLegacyAdmissions();
			for (const id of [
				...ids.map((id) => `sched-${id}`),
				`${f.channel.id}-provision-${at.getTime()}`,
			])
				expect(
					await resolveProvisionAdmission(
						tenant,
						f.channel.id,
						{},
						id,
						at.getTime(),
					),
				).toBeNull();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "PROVISIONING", provisionClaimedAt: null });
			const resumedId = `resume-provision-${f.channel.id}-${f.run.id}-0`;
			const recoveries = vi.fn(
				async (
					_payload: import("@bitovp/core").LiveChannelJob,
					_id: string,
				) => {},
			);
			const recover = createExhaustedProvisionRecovery(
				tenant,
				async () => undefined,
				recoveries,
			);
			for (
				let i = 0;
				i < 10 && !recoveries.mock.calls.some(([, id]) => id === resumedId);
				i++
			)
				await recover(at);
			const resumed = recoveries.mock.calls.find(
				([, id]) => id === resumedId,
			)?.[0];
			expect(resumed).toBeDefined();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					resumed ?? {},
					resumedId,
				),
			).toEqual({ runId: f.run.id, generation: 0 });
			expect(
				await tenant.liveSchedule.count({
					where: { id: { in: ids }, outcome: "UNKNOWN" },
				}),
			).toBe(2);
		});
		it.each([
			"PENDING",
			"UNKNOWN",
		] as const)("a late legacy schedule ACK cannot claim a manually revived broadcast (%s)", async (outcome) => {
			const f = await fixture("ERROR", null);
			const id = randomUUID();
			await tenant.liveSchedule.create({
				data: {
					id,
					action: "START",
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					status: "FIRED",
					outcome,
					fireAt: now,
					firedAt: now,
				},
			});
			const revive = new Date();
			await tenant.$transaction(async (tx) => {
				await tx.liveChannel.update({
					where: { id: f.channel.id },
					data: { status: "PROVISIONING", liveEffectFenceVersion: 7 },
				});
				await tx.liveChannelRun.update({
					where: { id: f.run.id },
					data: { status: "PROVISIONING", updatedAt: revive },
				});
			});
			const delayed = new Date(revive.getTime() + 1000);
			await tenant.liveSchedule.update({
				where: { id },
				data: { dispatchJobId: `sched-${id}`, dispatchedAt: delayed },
			});
			await snapshotLegacyAdmissions();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`sched-${id}`,
					delayed.getTime(),
				),
			).toBeNull();
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					{},
					`${f.channel.id}-provision-${delayed.getTime()}`,
					delayed.getTime(),
				),
			).toBeNull();
			const add = vi.fn(
				async (
					_payload: import("@bitovp/core").LiveChannelJob,
					_id: string,
				) => {},
			);
			const recover = createExhaustedProvisionRecovery(
				tenant,
				async () => undefined,
				add,
			);
			const resumeId = `resume-provision-${f.channel.id}-${f.run.id}-7`;
			for (
				let i = 0;
				i < 10 && !add.mock.calls.some(([, key]) => key === resumeId);
				i++
			)
				await recover(delayed);
			const resumed = add.mock.calls.find(([, key]) => key === resumeId)?.[0];
			expect(resumed).toMatchObject({
				action: "provision",
				plannedLiveChannelRunId: f.run.id,
			});
			expect(
				await resolveProvisionAdmission(
					tenant,
					f.channel.id,
					resumed ?? {},
					resumeId,
				),
			).toEqual({ runId: f.run.id, generation: 7 });
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
			).toMatchObject({ startAdmissionFenceVersion: null, outcome: "UNKNOWN" });
			await tenant.liveSchedule.delete({ where: { id } });
		});

		it.each([
			"initial",
			"scheduled",
			"manual",
		] as const)("recovers a missing or failed %s START from its SQL admission without any failed-queue index", async (kind) => {
			const f = await fixture(
				kind === "initial" ? "CREATED" : "PROVISIONING",
				null,
			);
			const generation = kind === "initial" ? 0 : 5;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					liveEffectFenceVersion: generation,
					manualProvisionAdmissionFenceVersion:
						kind === "manual" ? generation : null,
				},
			});
			if (kind === "initial")
				await tenant.liveChannelRun.delete({ where: { id: f.run.id } });
			const schedule =
				kind === "scheduled"
					? await tenant.liveSchedule.create({
							data: {
								liveChannelId: f.channel.id,
								liveChannelRunId: f.run.id,
								action: "START",
								status: "FIRED",
								fireAt: now,
								firedAt: now,
								dispatchedAt: now,
								startAdmissionFenceVersion: generation,
							},
						})
					: null;
			const id = schedule
				? `sched-${schedule.id}`
				: kind === "initial"
					? f.channel.id
					: `manual-provision-${f.channel.id}-${f.run.id}-${generation}`;
			let data: import("@bitovp/core").LiveChannelJob | undefined;
			let state = "waiting";
			const add = vi.fn(
				async (value: import("@bitovp/core").LiveChannelJob, key: string) => {
					if (key === id) data = value;
				},
			);
			const recover = createExhaustedProvisionRecovery(
				tenant,
				async (key) =>
					key === id && data
						? { data, getState: async () => state }
						: undefined,
				add,
			);
			for (let i = 0; i < 10 && !data; i++) await recover(new Date());
			expect(data).toMatchObject({
				liveChannelId: f.channel.id,
				action: "provision",
				...(kind === "initial" ? {} : { plannedLiveChannelRunId: f.run.id }),
			});
			state = "failed";
			for (let i = 0; i < 10; i++) await recover(new Date());
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "ERROR" });
			if (schedule)
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: schedule.id },
					}),
				).toMatchObject({ outcome: "UNKNOWN" });
		});
		it("never credits an unbound pre-upgrade START to a later manual job on redispatch", async () => {
			const f = await fixture("PROVISIONING", null);
			const old = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					action: "START",
					status: "FIRED",
					fireAt: lease,
					firedAt: lease,
				},
			});
			await snapshotLegacyAdmissions();
			const at = Date.now() + 10_000;
			const admission = await resolveProvisionAdmission(
				tenant,
				f.channel.id,
				{},
				`sched-${old.id}`,
				at,
			);
			expect(admission).toBeNull();
			expect(
				(await tenant.liveSchedule.findUniqueOrThrow({ where: { id: old.id } }))
					.liveChannelRunId,
			).toBeNull();
		});

		it.each([
			"failed",
			"waiting",
			"failed claim",
			"purged failed claim",
			"bare failed claim",
			"migrated failed claim with terminal encoder",
			"migrated failed claim with terminal encoder and older uncertain Stop",
			"migrated failed claim with active feeder",
			"purged",
			"wrong target",
			"new generation",
		] as const)("recovers only the admitted current STOP after a lost terminal callback (%s)", async (scenario) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			const schedule = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					fireAt: now,
				},
			});
			const jobs = new Map<string, import("@bitovp/core").LiveChannelJob>();
			const enqueue = vi.fn(
				async (job: import("@bitovp/core").LiveChannelJob, id: string) => {
					jobs.set(id, job);
				},
			);
			const sweep = createScheduleSweep({
				prisma: tenant,
				now: () => now,
				enqueue,
			});
			await sweep();
			const [jobId, queued] =
				[...jobs].find(([, job]) => job.effect?.scheduleId === schedule.id) ??
				[];
			if (!jobId || !queued?.effect) throw new Error("missing original STOP");
			let id = jobId;
			const original = { ...queued, effect: queued.effect };
			const migratedFailure = scenario.startsWith("migrated failed claim");
			const terminalMigration = scenario.includes("with terminal encoder");
			const failedClaim =
				["failed claim", "purged failed claim", "bare failed claim"].includes(
					scenario,
				) || migratedFailure;
			if (failedClaim) {
				if (
					scenario === "purged failed claim" ||
					scenario === "bare failed claim" ||
					migratedFailure
				) {
					id = scheduledStopJobId(schedule.id);
					delete original.effect.stopDeliveryToken;
					await tenant.liveChannel.update({
						where: { id: f.channel.id },
						data: {
							legacyAdmissionFenceVersion:
								original.effect.admissionFenceVersion,
						},
					});
					await tenant.liveSchedule.update({
						where: { id: schedule.id },
						data: {
							stopAdmissionFenceVersion: null,
							stopProviderEncodingId: null,
							stopDeliveryToken: null,
							dispatchJobId: id,
						},
					});
				}
				const receipt = await beginLiveEffect(tenant, {
					liveChannelId: f.channel.id,
					...original.effect,
					expectedFenceVersion: original.effect.admissionFenceVersion,
					allowedChannelStatuses: ["STOPPING"],
					now,
					expiresAt: new Date(now.getTime() + 30_000),
					ownerId: "original-worker",
				});
				if (receipt.kind !== "EXECUTE") throw new Error("STOP claim missing");
				await markLiveEffectFailed(tenant, receipt.claim, "pre-send failure");
				if (migratedFailure) {
					await tenant.liveEffectClaim.update({
						where: { id: receipt.claim.id },
						data: { stopProtocolVersion: null },
					});
					await tenant.liveChannel.update({
						where: { id: f.channel.id },
						data: { legacyAdmissionFenceVersion: receipt.claim.generation },
					});
					if (scenario.includes("older uncertain Stop"))
						await tenant.liveEffectClaim.create({
							data: {
								...f.identity,
								idempotencyKey: `manual:stop:${randomUUID()}`,
								token: randomUUID(),
								liveChannelId: f.channel.id,
								generation: receipt.claim.generation - 1,
								state: "AMBIGUOUS",
								ownerId: "interrupted-manual-stop",
								expiresAt: lease,
								stopProtocolVersion: 1,
								stopSendEncodingIds: [f.encodingId],
							},
						});
					if (!terminalMigration)
						await tenant.feederSession.create({
							data: {
								liveChannelId: f.channel.id,
								liveChannelRunId: f.run.id,
								sourceCredentialId: randomUUID(),
								sourceBucket: "fixture",
								sourceKey: "clip.mp4",
								protocol: "RTMP",
								target: {},
								status: "PUSHING",
							},
						});
				}
			}
			const data =
				scenario === "wrong target"
					? {
							...original,
							effect: { ...original.effect, providerEncodingId: randomUUID() },
						}
					: scenario === "bare failed claim"
						? {
								action: "stop",
								liveChannelId: f.channel.id,
								plannedLiveChannelRunId: f.run.id,
							}
						: original;
			if (scenario === "new generation")
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { liveEffectFenceVersion: { increment: 1 } },
				});
			const read = vi.fn(async (key: string) =>
				key !== id ||
				scenario === "purged" ||
				migratedFailure ||
				scenario === "purged failed claim"
					? undefined
					: {
							id,
							data,
							finishedOn: now.getTime(),
							getState: async () =>
								scenario === "waiting" ? "waiting" : "failed",
						},
			);
			const resume = vi.fn(async () => {});
			const emitEvent = vi.fn();
			const recovery = createExhaustedScheduledStopRecovery(
				{ ...f.deps, emitEvent },
				read,
				resume,
			);
			await recovery();
			const status = terminalMigration
				? "STOPPED"
				: scenario === "failed" || failedClaim
					? "ERROR"
					: "STOPPING";
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).status,
			).toBe(status);
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).status,
			).toBe(status);
			expect(
				(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: schedule.id },
					})
				).outcome,
			).toBe(scenario === "failed" || failedClaim ? "UNKNOWN" : "PENDING");
			if (scenario === "purged")
				expect(resume).toHaveBeenCalledWith(
					{
						...original,
						effect: {
							...original.effect,
							stopDeliveryToken: expect.any(String),
						},
					},
					expect.stringMatching(new RegExp(`^sched-${schedule.id}-stop-`)),
				);
			else expect(resume).not.toHaveBeenCalled();
			expect(
				await tenant.liveEffectClaim.count({
					where: { liveChannelId: f.channel.id },
				}),
			).toBe(
				scenario.includes("older uncertain Stop") ? 2 : failedClaim ? 1 : 0,
			);
			if (scenario.includes("older uncertain Stop"))
				expect(
					await tenant.liveEffectClaim.findFirstOrThrow({
						where: {
							liveChannelId: f.channel.id,
							ownerId: "interrupted-manual-stop",
						},
					}),
				).toMatchObject({ state: "ACKED" });
			if (migratedFailure) {
				expect(f.sdk.getEncodingStatus).toHaveBeenCalledExactlyOnceWith(
					f.encodingId,
				);
				expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
				expect(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { idempotencyKey: original.effect.idempotencyKey },
					}),
				).toMatchObject({ state: "FAILED", failure: "pre-send failure" });
				if (terminalMigration) expect(emitEvent).not.toHaveBeenCalled();
			} else expect(f.sdk.getEncodingStatus).not.toHaveBeenCalled();
			await tenant.liveSchedule.delete({ where: { id: schedule.id } });
		});
		it.each([
			"unknown",
			"failed",
			"base effect",
			"redispatched effect",
			"still running effect",
			"purged still running",
			"split queued effect",
			"split error effect",
			"unavailable effect",
			"secondary active effect",
			"unknown secondary active effect",
			"purged unknown active",
			"evicted base",
			"evicted after pre-send failure",
			"evicted terminal unknown",
			"purged nonlegacy unknown",
			"split terminal",
			"wrong effect",
			"purged",
			"waiting",
			"successor",
		] as const)("reconciles only an exhausted legacy STOP by observation (%s)", async (scenario) => {
			const f = await dispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					legacyAdmissionFenceVersion:
						scenario === "purged nonlegacy unknown" ? null : 2,
					liveEffectFenceVersion: 2,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status:
						scenario === "split error effect"
							? "ERROR"
							: scenario.startsWith("split")
								? "RUNNING"
								: "STOPPING",
				},
			});
			const row = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
					outcome: [
						"unknown",
						"successor",
						"unknown secondary active effect",
						"purged unknown active",
						"evicted terminal unknown",
						"purged nonlegacy unknown",
					].includes(scenario)
						? "UNKNOWN"
						: "PENDING",
					...(scenario.startsWith("purged") ||
					scenario === "redispatched effect"
						? {
								stopProviderEncodingId: f.encodingId,
								stopAdmissionFenceVersion: 2,
							}
						: {}),
					dispatchedAt: scenario === "evicted terminal unknown" ? null : now,
				},
			});
			await tenant.liveSchedule.update({
				where: { id: row.id },
				data: {
					dispatchJobId: [
						"unknown secondary active effect",
						"evicted terminal unknown",
					].includes(scenario)
						? null
						: `sched-${row.id}`,
				},
			});
			if (scenario === "successor")
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: { liveEffectFenceVersion: 3 },
				});
			const queue = vi.fn(async () =>
				scenario.startsWith("purged") || scenario.startsWith("evicted")
					? undefined
					: {
							data: {
								liveChannelId: f.channel.id,
								action: "stop",
								plannedLiveChannelRunId: f.run.id,
								...(scenario.endsWith("effect")
									? {
											effect: {
												action: "STOP",
												scheduleId: row.id,
												idempotencyKey: `schedule:${row.id}:stop`,
												liveChannelRunId: f.run.id,
												providerEncodingId:
													scenario === "wrong effect"
														? randomUUID()
														: f.encodingId,
												admissionFenceVersion: 2,
											},
										}
									: {}),
							},
							getState: async () =>
								scenario === "waiting" ? "waiting" : "failed",
						},
			);
			if (
				scenario === "still running effect" ||
				scenario === "purged still running"
			)
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			if (
				scenario.includes("secondary active effect") ||
				scenario === "purged unknown active"
			) {
				const secondary = randomUUID();
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: { previousProviderEncodingIds: [secondary] },
				});
				f.sdk.getEncodingStatus = vi.fn(async (id) => ({
					status: id === secondary ? "RUNNING" : "FINISHED",
				}));
			}
			if (scenario === "unavailable effect")
				f.sdk.getEncodingStatus = vi.fn(async () => {
					throw new Error("status unavailable");
				});
			if (
				["split queued effect", "split error effect", "evicted base"].includes(
					scenario,
				)
			)
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "QUEUED" }));
			if (
				scenario === "evicted base" ||
				scenario === "evicted after pre-send failure"
			) {
				const earlierStop = scenario === "evicted after pre-send failure";
				await tenant.liveEffectClaim.create({
					data: {
						idempotencyKey: "cue:" + randomUUID(),
						token: randomUUID(),
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						providerEncodingId: f.encodingId,
						action: earlierStop ? "STOP" : "SCTE35",
						state: earlierStop ? "FAILED" : "ACKED",
						generation: earlierStop ? 1 : 2,
						ownerId: "cue-worker",
						expiresAt: now,
					},
				});
			}
			if (scenario === "evicted after pre-send failure")
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			const reenqueue = vi.fn();
			const probe = createExhaustedScheduledStopRecovery(
				f.deps,
				queue,
				reenqueue,
			);
			await probe();
			const key = { idempotencyKey: `schedule:${row.id}:stop` };
			const claim = await tenant.liveEffectClaim.findFirst({ where: key });
			if (scenario === "purged still running") {
				expect(claim).toBeNull();
				expect(reenqueue).toHaveBeenCalledWith(
					expect.objectContaining({
						effect: expect.objectContaining({
							providerEncodingId: f.encodingId,
							admissionFenceVersion: 2,
							liveChannelRunId: f.run.id,
						}),
					}),
					expect.stringMatching(new RegExp(`^sched-${row.id}-stop-`)),
				);
				expect(
					(
						await tenant.liveSchedule.findUniqueOrThrow({
							where: { id: row.id },
						})
					).outcome,
				).toBe("PENDING");
				return;
			}
			if (
				scenario === "still running effect" ||
				[
					"split queued effect",
					"split error effect",
					"unavailable effect",
					"secondary active effect",
					"unknown secondary active effect",
					"purged unknown active",
					"evicted base",
					"evicted after pre-send failure",
					"purged nonlegacy unknown",
				].includes(scenario)
			) {
				expect(claim).toBeNull();
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "ERROR" });
				return;
			}
			if (
				scenario === "waiting" ||
				scenario === "successor" ||
				scenario === "wrong effect"
			) {
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
			).toBe("UNKNOWN");
		});

		it.each([
			["RUNNING", "pending"],
			["FINISHED", "pending"],
			["RUNNING", "clock rollback"],
			["FINISHED", "queue outcome overwritten"],
			["RUNNING", "both deliveries evicted"],
			["FINISHED", "both deliveries evicted"],
		] as const)("keeps a newer queued stop eligible after the older delivery was evicted (%s, %s)", async (providerStatus, scenario) => {
			const bothEvicted = scenario === "both deliveries evicted";
			const waiting = scenario === "queue outcome overwritten";
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: 2,
					legacyAdmissionFenceVersion: 2,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const common = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP",
				status: "FIRED",
				fireAt: now,
			} as const;
			const old = await tenant.liveSchedule.create({
				data: {
					...common,
					outcome: bothEvicted ? "PENDING" : "UNKNOWN",
					firedAt: bothEvicted ? now : new Date(now.getTime() - 1000),
					dispatchedAt: bothEvicted ? now : null,
				},
			});
			const next = await tenant.liveSchedule.create({
				data: {
					...common,
					outcome: waiting ? "UNKNOWN" : "PENDING",
					firedAt:
						scenario === "clock rollback"
							? new Date(now.getTime() - 2000)
							: now,
					dispatchedAt: bothEvicted || waiting ? now : null,
				},
			});
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: providerStatus }));
			const queuedStop = {
				liveChannelId: f.channel.id,
				plannedLiveChannelRunId: f.run.id,
				action: "stop" as const,
				effect: {
					...f.identity,
					idempotencyKey: `schedule:${next.id}:stop`,
					scheduleId: next.id,
					admissionFenceVersion: 2,
				},
			};
			if (waiting || (bothEvicted && providerStatus === "FINISHED"))
				await tenant.feederSession.create({
					data: {
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						sourceCredentialId: randomUUID(),
						sourceBucket: "fixture",
						sourceKey: "clip.mp4",
						protocol: "RTMP",
						target: {},
						status: "PUSHING",
					},
				});
			const recover = createExhaustedScheduledStopRecovery(
				f.deps,
				async (id) =>
					waiting && id === `sched-${next.id}`
						? { data: queuedStop, getState: async () => "waiting" }
						: undefined,
				vi.fn(),
			);
			for (let i = 0; i < 3; i++) await recover();
			if (bothEvicted) {
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "ERROR", liveEffectFenceVersion: 2 });
				expect(
					await tenant.liveEffectClaim.count({
						where: { liveChannelId: f.channel.id },
					}),
				).toBe(0);
				expect(
					await tenant.liveSchedule.findMany({
						where: { id: { in: [old.id, next.id] } },
						select: { outcome: true, outcomeEvidenceKind: true },
					}),
				).toEqual([
					{ outcome: "UNKNOWN", outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN" },
					{ outcome: "UNKNOWN", outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN" },
				]);
				return;
			}
			expect(
				await tenant.liveEffectClaim.findFirst({
					where: { scheduleId: old.id },
				}),
			).toBeNull();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "STOPPING", liveEffectFenceVersion: 2 });
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: next.id } }),
			).toMatchObject({
				status: "FIRED",
				outcome: waiting ? "UNKNOWN" : "PENDING",
			});
			if (waiting) {
				const claim = await beginLiveEffect(tenant, {
					...queuedStop.effect,
					liveChannelId: f.channel.id,
					expectedFenceVersion: 2,
					allowedChannelStatuses: ["STOPPING"],
					ownerId: "queued-worker",
					now,
					expiresAt: new Date(now.getTime() + 30000),
				});
				expect(claim.kind).toBe("EXECUTE");
			}
			if (scenario === "clock rollback") {
				const enqueue = vi.fn(async () => {});
				await createScheduleSweep({
					prisma: tenant,
					now: () => new Date(now.getTime() + 600000),
					enqueue,
				}).dispatchPending();
				expect(enqueue).toHaveBeenCalledWith(
					expect.objectContaining({
						effect: expect.objectContaining(queuedStop.effect),
					}),
					expect.stringMatching(new RegExp(`^sched-${next.id}-stop-`)),
				);
			}
		});
		it.each([
			["confirmed", false],
			["exhausted", false],
			["confirmed", true],
			["exhausted", true],
			["manual retry confirmed", true],
			["scheduled exhaustion already projected", true],
		] as const)("settles an evicted sibling after the owning scheduled STOP retries (%s, migrated FAILED claim: %s)", async (result, failedSibling) => {
			const { scope, ...f } = await isolatedDispatchFixture();
			const fence = 2;
			await scope.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: fence,
					legacyAdmissionFenceVersion: fence,
				},
			});
			await scope.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const stop = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP",
				status: "FIRED",
				fireAt: now,
				firedAt: now,
				dispatchedAt: now,
			} as const;
			const evicted = await scope.liveSchedule.create({ data: stop });
			const queued = await scope.liveSchedule.create({ data: stop });
			if (failedSibling)
				await scope.liveEffectClaim.create({
					data: {
						...f.identity,
						liveChannelId: f.channel.id,
						scheduleId: evicted.id,
						idempotencyKey: `schedule:${evicted.id}:stop`,
						token: randomUUID(),
						state: "FAILED",
						generation: fence,
						failure: "first feeder lookup failed",
						ownerId: "pre-upgrade-worker",
						expiresAt: lease,
					},
				});
			const jobId = `sched-${queued.id}`;
			const job = {
				liveChannelId: f.channel.id,
				plannedLiveChannelRunId: f.run.id,
				action: "stop" as const,
				effect: {
					...f.identity,
					scheduleId: queued.id,
					idempotencyKey: `schedule:${queued.id}:stop`,
					admissionFenceVersion: fence,
				},
			};
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			await createExhaustedScheduledStopRecovery(
				f.deps,
				async (id) =>
					id === jobId
						? { data: job, getState: async () => "waiting" }
						: undefined,
				vi.fn(),
			)();
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: evicted.id },
				}),
			).toMatchObject({ outcome: "PENDING", legacyStopExhaustedFence: fence });

			const closingJob =
				result === "manual retry confirmed"
					? {
							...f.job,
							effect: { ...f.job.effect, admissionFenceVersion: fence },
						}
					: job;
			const begin = () =>
				beginLiveEffect(scope, {
					...closingJob.effect,
					liveChannelId: f.channel.id,
					expectedFenceVersion: fence,
					allowedChannelStatuses: ["STOPPING"],
					ownerId: "queued-worker",
					now,
					expiresAt: new Date(now.getTime() + 30000),
				});
			const first = await begin();
			if (first.kind !== "EXECUTE")
				throw new Error("first STOP claim was refused");
			expect(
				await markLiveEffectFailed(
					scope,
					first.claim,
					"first feeder lookup failed",
				),
			).toBe(true);

			const otherFence = await scope.liveSchedule.create({
				data: {
					...stop,
					legacyStopExhaustedFence: fence + 1,
					stopAdmissionFenceVersion: fence + 1,
					stopProviderEncodingId: f.encodingId,
				},
			});
			if (result === "confirmed" || result === "manual retry confirmed") {
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
				const completed = await createLiveChannelProcessor(f.deps)(
					closingJob,
					jobId,
				);
				expect(completed.status).toBe("STOPPED");
			} else {
				const retry = await begin();
				if (retry.kind !== "EXECUTE")
					throw new Error("second STOP claim was refused");
				const projected = result === "scheduled exhaustion already projected";
				const failure = "final feeder lookup failed";
				if (projected)
					expect(
						await recordLiveStopFailure(scope, retry.claim, {
							state: "FAILED",
							status: "ERROR",
							error: failure,
							failure,
							at: now,
						}),
					).toBe("RECORDED");
				else
					expect(await markLiveEffectFailed(scope, retry.claim, failure)).toBe(
						true,
					);
				expect(
					await recordFinalStopFailure(
						scope,
						{ id: jobId, data: job, attemptsMade: 2, opts: { attempts: 2 } },
						"exhausted",
					),
				).toBe(!projected);
			}
			expect(
				await scope.liveEffectClaim.findUniqueOrThrow({
					where: { id: first.claim.id },
				}),
			).toMatchObject({ attempt: 2, generation: fence + 2 });
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: evicted.id },
				}),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: queued.id },
				}),
			).toMatchObject({
				outcome:
					result === "confirmed"
						? "DELIVERED"
						: result === "manual retry confirmed"
							? "PENDING"
							: result === "scheduled exhaustion already projected"
								? "FAILED"
								: "UNKNOWN",
			});
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: otherFence.id },
				}),
			).toMatchObject({
				outcome: "PENDING",
				legacyStopExhaustedFence: fence + 1,
			});
		});

		it.each([
			"evicted",
			"failed",
			"replaced encoder",
			"rebuilt outbox",
			"old failed claim first",
			"old failed claim last",
		] as const)("keeps the current exhausted STOP recoverable alongside an older fenced queue receipt (%s)", async (currentDelivery) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			const oldFailed = currentDelivery.startsWith("old failed claim");
			const sortedIds = [randomUUID(), randomUUID()].sort();
			if (currentDelivery === "old failed claim last") sortedIds.reverse();
			const rebuilt = currentDelivery === "rebuilt outbox";
			const replaced = rebuilt || currentDelivery === "replaced encoder";
			const earlierEncoder = replaced ? randomUUID() : f.encodingId;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: 2,
					legacyAdmissionFenceVersion: 2,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPING",
					previousProviderEncodingIds: replaced ? [earlierEncoder] : [],
				},
			});
			const common = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP",
				status: "FIRED",
				fireAt: now,
				firedAt: now,
				dispatchedAt: now,
			} as const;
			const earlier = await tenant.liveSchedule.create({
				data: {
					...common,
					id: sortedIds[0],
					outcome: rebuilt ? "PENDING" : "UNKNOWN",
					dispatchedAt: rebuilt ? null : now,
				},
			});
			const current = await tenant.liveSchedule.create({
				data: {
					...common,
					id: sortedIds[1],
					outcome: currentDelivery === "evicted" ? "UNKNOWN" : "PENDING",
					dispatchedAt: replaced ? null : now,
				},
			});
			const jobs = new Map<
				string,
				{ data: unknown; getState(): Promise<string> }
			>();
			if (replaced) {
				await createScheduleSweep({
					prisma: tenant,
					now: () => new Date(now.getTime() + 600000),
					enqueue: async (data, id) => {
						jobs.set(id, { data, getState: async () => "failed" });
					},
				}).dispatchPending();
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: current.id },
					}),
				).toMatchObject({
					stopProviderEncodingId: f.encodingId,
					stopAdmissionFenceVersion: 2,
					dispatchedAt: expect.any(Date),
				});
			}
			const queueReceipt = (id: string, fence: number, state: string) => ({
				data: {
					action: "stop",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
					effect: {
						...f.identity,
						providerEncodingId: fence === 1 ? earlierEncoder : f.encodingId,
						idempotencyKey: `schedule:${id}:stop`,
						scheduleId: id,
						admissionFenceVersion: fence,
					},
				},
				getState: async () => state,
			});
			jobs.set(
				scheduledStopJobId(earlier.id),
				queueReceipt(
					earlier.id,
					1,
					currentDelivery === "evicted" ? "completed" : "failed",
				),
			);
			if (oldFailed) {
				jobs.delete(`sched-${earlier.id}`);
				await tenant.liveEffectClaim.create({
					data: {
						idempotencyKey: `schedule:${earlier.id}:stop`,
						scheduleId: earlier.id,
						token: randomUUID(),
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						providerEncodingId: f.encodingId,
						action: "STOP",
						state: "FAILED",
						generation: 1,
						ownerId: "pre-upgrade-worker",
						expiresAt: now,
					},
				});
			}
			if (!replaced && currentDelivery !== "evicted") {
				jobs.set(
					scheduledStopJobId(current.id),
					queueReceipt(current.id, 2, "failed"),
				);
			}
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			const recover = createExhaustedScheduledStopRecovery(
				f.deps,
				async (id) => jobs.get(id),
				vi.fn(),
			);
			for (let i = 0; i < 4; i++) await recover();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "ERROR", liveEffectFenceVersion: 2 });
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: earlier.id },
				}),
			).toMatchObject({
				stopAdmissionFenceVersion: rebuilt ? 2 : null,
				stopProviderEncodingId: rebuilt ? f.encodingId : null,
				legacyStopExhaustedFence: 2,
			});
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: current.id },
				}),
			).toMatchObject({ outcome: "UNKNOWN", legacyStopExhaustedFence: 2 });
			expect(
				await tenant.liveEffectClaim.count({
					where: { liveChannelId: f.channel.id },
				}),
			).toBe(oldFailed ? 1 : 0);
		});
		it.each([
			"old queue only",
			"terminal without current delivery",
			"old queue and failed claim",
		] as const)("recovers the latest admission of one refired legacy Stop after Redis deduplicated its older payload (%s)", async (scenario) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: 2,
					legacyAdmissionFenceVersion: 2,
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
					outcome: "PENDING",
					fireAt: now,
					firedAt: now,
					dispatchedAt: now,
				},
			});
			const retained = {
				data: {
					action: "stop",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
					effect: {
						...f.identity,
						idempotencyKey: `schedule:${row.id}:stop`,
						scheduleId: row.id,
						admissionFenceVersion: 1,
					},
				},
				getState: async () => "waiting",
			};
			if (scenario === "old queue and failed claim") {
				await tenant.liveEffectClaim.create({
					data: {
						...f.identity,
						scheduleId: row.id,
						idempotencyKey: `schedule:${row.id}:stop`,
						liveChannelId: f.channel.id,
						generation: 1,
						state: "FAILED",
						token: randomUUID(),
						ownerId: "earlier-attempt",
						expiresAt: now,
					},
				});
			}
			let present = true;
			const enqueue = vi.fn();
			const terminal = scenario === "terminal without current delivery";
			f.sdk.getEncodingStatus = vi.fn(async () => ({
				status: terminal ? "FINISHED" : "RUNNING",
			}));
			const recover = createExhaustedScheduledStopRecovery(
				f.deps,
				async () => (present ? retained : undefined),
				enqueue,
			);
			await recover();
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: row.id } }),
			).toMatchObject({
				stopAdmissionFenceVersion: null,
				stopProviderEncodingId: null,
			});
			present = false;
			const reconcile = createUncertainStopReconciler(f.deps, enqueue);
			for (let i = 0; i < 3; i++) {
				await recover();
				if (terminal) await reconcile();
			}
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject(
				terminal
					? { status: "STOPPED" }
					: { status: "ERROR", liveEffectFenceVersion: 2 },
			);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: row.id } }),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			expect(enqueue).not.toHaveBeenCalled();
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});
		it.each([
			"failed",
			"waiting",
			"failed after retry",
		] as const)("recognizes the current migrated FAILED claim behind its older %s queue envelope", async (state) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPING", liveEffectFenceVersion: 1 },
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
					dispatchedAt: now,
				},
			});
			const job = {
				action: "stop" as const,
				liveChannelId: f.channel.id,
				plannedLiveChannelRunId: f.run.id,
				effect: {
					...f.identity,
					scheduleId: row.id,
					idempotencyKey: `schedule:${row.id}:stop`,
					admissionFenceVersion: 1,
				},
			};
			const claimed = await beginLiveEffect(tenant, {
				...job.effect,
				liveChannelId: f.channel.id,
				expectedFenceVersion: 1,
				ownerId: "pre-upgrade-worker",
				now,
				expiresAt: now,
			});
			if (claimed.kind !== "EXECUTE")
				throw new Error("missing original STOP claim");
			await markLiveEffectFailed(
				tenant,
				claimed.claim,
				"pre-send feeder lookup failed",
			);
			const twice = state === "failed after retry";
			if (twice) {
				const again = await beginLiveEffect(tenant, {
					...job.effect,
					liveChannelId: f.channel.id,
					expectedFenceVersion: 1,
					ownerId: "pre-upgrade-retry",
					now,
					expiresAt: now,
				});
				if (again.kind !== "EXECUTE") throw new Error("missing retry claim");
				await markLiveEffectFailed(
					tenant,
					again.claim,
					"pre-send retry failure",
				);
			}
			const generation = twice ? 3 : 2;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { legacyAdmissionFenceVersion: generation },
			});
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			const recover = createExhaustedScheduledStopRecovery(
				f.deps,
				async () => ({
					data: job,
					getState: async () => (state === "waiting" ? "waiting" : "failed"),
				}),
			);
			for (let i = 0; i < 3; i++) await recover();
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: state === "waiting" ? "STOPPING" : "ERROR",
				liveEffectFenceVersion: generation,
			});
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: row.id } }),
			).toMatchObject({
				status: "FIRED",
				outcome: state === "waiting" ? "PENDING" : "UNKNOWN",
			});
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});
		it.each([
			"legacy admission",
			"saved admission",
			"outbox still open",
		] as const)("keeps a refired Stop intact while the older queued worker rejects its generation (%s)", async (mode) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: 2,
					legacyAdmissionFenceVersion: 2,
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
					dispatchedAt: mode === "outbox still open" ? null : now,
					...(mode === "saved admission" && {
						stopProviderEncodingId: f.encodingId,
						stopAdmissionFenceVersion: 2,
					}),
				},
			});
			const key = `sched-${row.id}`,
				job = {
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
					action: "stop" as const,
					effect: {
						...f.identity,
						scheduleId: row.id,
						idempotencyKey: `schedule:${row.id}:stop`,
						admissionFenceVersion: 1,
					},
				};
			const read = barrier(),
				resume = barrier();
			let present = true;
			const recover = createExhaustedScheduledStopRecovery(f.deps, async () =>
				present
					? {
							data: job,
							getState: async () => {
								read.release();
								await resume.ready;
								return "waiting";
							},
						}
					: undefined,
			);
			const before = recover();
			try {
				if (mode !== "outbox still open") await reach(read.ready, before);
				const process = createLiveChannelProcessor(f.deps);
				expect(await process(job, key, true)).toMatchObject({
					status: "SKIPPED_STALE_GENERATION",
				});
				await recordDeadJobScheduleOutcomes(
					tenant,
					{ id: key, data: job, attemptsMade: 3, opts: { attempts: 3 } },
					"late failed callback",
					now,
				);
				if (mode !== "legacy admission") {
					const { effect: _oldEffect, ...bareJob } = job;
					if (mode === "saved admission")
						expect(await process(bareJob, key)).toMatchObject({
							status: "EFFECT_REFUSED",
						});
					await recordDeadJobScheduleOutcomes(
						tenant,
						{ id: key, data: bareJob, attemptsMade: 3, opts: { attempts: 3 } },
						"late bare failed callback",
						now,
					);
				}
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: row.id },
					}),
				).toMatchObject({
					status: "FIRED",
					outcome: "PENDING",
					dispatchedAt: row.dispatchedAt,
				});
			} finally {
				present = false;
				resume.release();
				await before;
			}
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			if (mode === "outbox still open") {
				const enqueue = vi.fn(async () => {});
				await createScheduleSweep({
					prisma: tenant,
					now: () => new Date(now.getTime() + 600000),
					enqueue,
				}).dispatchPending();
				expect(enqueue).toHaveBeenCalledWith(
					expect.objectContaining({
						effect: expect.objectContaining({ admissionFenceVersion: 2 }),
					}),
					expect.stringMatching(new RegExp(`^sched-${row.id}-stop-`)),
				);
			} else {
				for (let i = 0; i < 3; i++) await recover();
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "ERROR", liveEffectFenceVersion: 2 });
			}
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});
		it("settles the airing after both reconstructed Stop outboxes lose their queued jobs", async () => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
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
			const rows = [];
			for (const delta of [1000, 2000]) {
				const firedAt = new Date(now.getTime() - delta);
				rows.push(
					await tenant.liveSchedule.create({
						data: {
							liveChannelId: f.channel.id,
							liveChannelRunId: f.run.id,
							action: "STOP",
							status: "FIRED",
							fireAt: firedAt,
							firedAt,
						},
					}),
				);
			}
			const enqueue = vi.fn(async () => {});
			await createScheduleSweep({
				prisma: tenant,
				now: () => new Date(now.getTime() + 600000),
				enqueue,
			}).dispatchPending();
			for (const row of rows) {
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: row.id },
					}),
				).toMatchObject({
					stopProviderEncodingId: f.encodingId,
					stopAdmissionFenceVersion: 2,
					dispatchedAt: expect.any(Date),
				});
				expect(enqueue).toHaveBeenCalledWith(
					expect.anything(),
					expect.stringMatching(new RegExp(`^sched-${row.id}-stop-`)),
				);
			}
			const resend = vi.fn(),
				recover = createExhaustedScheduledStopRecovery(
					f.deps,
					async () => undefined,
					resend,
				);
			const reconcile = createUncertainStopReconciler(f.deps, resend);
			const exhaustedHandoff = {
				liveChannelId: f.channel.id,
				liveChannelRunId: f.run.id,
				action: "STOP",
				status: "FIRED",
				fireAt: now,
				firedAt: now,
				dispatchedAt: now,
				stopProviderEncodingId: f.encodingId,
				stopAdmissionFenceVersion: 2,
				legacyStopExhaustedFence: 2,
			} as const;
			const otherSchedules = await tenant.liveSchedule.createManyAndReturn({
				data: [
					{ ...exhaustedHandoff, dispatchedAt: null },
					{ ...exhaustedHandoff, liveChannelRunId: randomUUID() },
					{
						...exhaustedHandoff,
						stopAdmissionFenceVersion: 1,
						legacyStopExhaustedFence: 1,
					},
					{ ...exhaustedHandoff, stopProviderEncodingId: randomUUID() },
				],
				select: { id: true },
			});
			for (let i = 0; i < 4; i++) {
				await recover();
				await reconcile();
			}
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "STOPPED" });
			expect(
				await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				}),
			).toMatchObject({ status: "STOPPED" });
			const claim = await tenant.liveEffectClaim.findFirstOrThrow({
				where: { liveChannelId: f.channel.id, action: "STOP", state: "ACKED" },
			});
			expect(rows.map((row) => row.id)).toContain(claim.scheduleId);
			for (const row of rows) {
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: row.id },
					}),
				).toMatchObject({
					outcome: "UNKNOWN",
					outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
					outcomeAt: expect.any(Date),
				});
			}
			expect(
				await tenant.liveSchedule.count({
					where: {
						id: { in: otherSchedules.map((row) => row.id) },
						outcome: "PENDING",
						outcomeAt: null,
					},
				}),
			).toBe(otherSchedules.length);
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(resend).not.toHaveBeenCalled();
		});
		it("recovers an already-retired legacy Stop for observation without changing a successor or an open handoff", async () => {
			const migration = readFileSync(
				new URL(
					"../../../../packages/db/prisma/migrations/20261126010500_recover_retired_scheduled_stop/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			const rows = [];
			for (const mode of [
				"only",
				"same airing replacement",
				"newer airing",
				"runnable sibling",
				"open claim",
				"separate generation",
			] as const) {
				const { scope, ...f } = await isolatedDispatchFixture();
				await scope.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						status: "STOPPING",
						liveEffectFenceVersion: mode === "separate generation" ? 3 : 2,
						legacyAdmissionFenceVersion: 2,
					},
				});
				await scope.liveChannelRun.update({
					where: { id: f.run.id },
					data: { status: "STOPPING" },
				});
				const reason =
					mode === "same airing replacement"
						? "the planned live run or provider encoding is no longer current"
						: "the live effect generation changed after admission";
				if (mode === "same airing replacement")
					await scope.liveChannelRun.update({
						where: { id: f.run.id },
						data: { previousProviderEncodingIds: [randomUUID()] },
					});
				const row = await scope.liveSchedule.create({
					data: {
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						action: "STOP",
						status: "SKIPPED_STALE_GENERATION",
						fireAt: now,
						firedAt: now,
						dispatchedAt: now,
						outcome: "FAILED",
						note: reason,
						outcomeNote: reason,
						outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
						outcomeEvidenceVersion: 1,
						outcomeEvidenceAt: now,
					},
				});
				if (mode === "newer airing")
					await scope.liveChannelRun.update({
						where: { id: f.run.id },
						data: { status: "STOPPED", endedAt: now },
					});
				if (mode === "newer airing")
					await scope.liveChannelRun.create({
						data: {
							liveChannelId: f.channel.id,
							seq: 2,
							status: "STOPPING",
							bitmovinEncodingId: randomUUID(),
							outputPrefix: "",
						},
					});
				if (mode === "runnable sibling")
					await scope.liveSchedule.create({
						data: {
							liveChannelId: f.channel.id,
							liveChannelRunId: f.run.id,
							action: "STOP",
							status: "FIRED",
							fireAt: now,
							firedAt: now,
						},
					});
				if (mode === "open claim")
					await scope.liveEffectClaim.create({
						data: {
							...f.identity,
							idempotencyKey: `manual:stop:${randomUUID()}`,
							token: randomUUID(),
							liveChannelId: f.channel.id,
							generation: 2,
							state: "DISPATCHING",
							ownerId: "pending-stop",
							expiresAt: now,
						},
					});
				rows.push({ f, scope, row, mode });
			}
			await admin.$executeRawUnsafe(migration);
			await admin.$executeRawUnsafe(migration);
			for (const { f, scope, row, mode } of rows) {
				const saved = await scope.liveSchedule.findUniqueOrThrow({
					where: { id: row.id },
				});
				if (mode !== "only" && mode !== "same airing replacement") {
					expect(saved).toEqual(row);
					continue;
				}
				expect(saved).toMatchObject({
					status: "FIRED",
					outcome: "UNKNOWN",
					outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
					note: row.note,
					stopAdmissionFenceVersion: null,
				});
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
				const send = vi.fn();
				await createExhaustedScheduledStopRecovery(
					f.deps,
					async () => undefined,
					send,
				)();
				expect(
					await scope.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "ERROR", liveEffectFenceVersion: 2 });
				expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
				expect(send).not.toHaveBeenCalled();
			}
		});
		it.each([
			"owner",
			"observer only",
			"observer before owner",
			"expired unsent owner",
			"older failed callback",
			"older failed callback for same admission",
			"managed AISA owner",
			"managed AISA completes after encoder Stop",
			"managed AISA completes after encoder Stop with an unread encoder",
			"managed AISA completes after encoder Stop with an active encoder",
			"managed AISA terminal before request",
		] as const)("records only proved delivery when the rebuilt Stop is requeued after a stale sample (%s)", async (winner) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture(
				randomUUID(),
			);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					liveEffectFenceVersion: 2,
					legacyAdmissionFenceVersion: 2,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const id = randomUUID();
			const jobId = `sched-${id}`;
			await tenant.liveSchedule.create({
				data: {
					id,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					fireAt: now,
					firedAt: now,
					dispatchedAt: now,
					dispatchJobId: jobId,
					action: "STOP",
					status: "FIRED",
					stopProviderEncodingId: f.encodingId,
					stopAdmissionFenceVersion: 2,
				},
			});
			const job = {
				...f.job,
				plannedLiveChannelRunId: f.run.id,
				effect: {
					...f.identity,
					scheduleId: id,
					idempotencyKey: `schedule:${id}:stop`,
					admissionFenceVersion: 2,
				},
			};
			const older = {
				...job,
				effect: { ...job.effect, admissionFenceVersion: 1 },
			};
			let stopped = false;
			f.sdk.getEncodingStatus = vi.fn(async () => ({
				status: stopped ? "FINISHED" : "RUNNING",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				stopped = true;
			});
			let sampled!: () => void, resume!: () => void;
			const read = new Promise<void>((resolve) => {
				sampled = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const a = createExhaustedScheduledStopRecovery(f.deps, async () => ({
				data: older,
				getState: async () => {
					sampled();
					await gate;
					return "failed";
				},
			}));
			const requeue = vi.fn(
				async (_job: import("@bitovp/core").LiveChannelJob, _id: string) => {},
			);
			const b = createExhaustedScheduledStopRecovery(
				f.deps,
				async () => undefined,
				requeue,
			);
			let currentJob: typeof job & { effect: { stopDeliveryToken?: string } } =
				job;
			let currentJobId = jobId;
			const captureReplacement = () => {
				const [delivery, key] = requeue.mock.calls[0] ?? [];
				expect(delivery).toMatchObject({
					...job,
					effect: { ...job.effect, stopDeliveryToken: expect.any(String) },
				});
				const stopDeliveryToken = delivery?.effect?.stopDeliveryToken;
				if (!stopDeliveryToken || !key)
					throw new Error("expected a distinct queue delivery token");
				currentJob = { ...job, effect: { ...job.effect, stopDeliveryToken } };
				currentJobId = key;
				expect(currentJobId).toBe(scheduledStopJobId(id, stopDeliveryToken));
			};
			const interruptOwner = async () => {
				const result = await beginLiveEffect(tenant, {
					...currentJob.effect,
					liveChannelId: f.channel.id,
					expectedFenceVersion: job.effect.admissionFenceVersion,
					ownerId: "interrupted-worker",
					now: lease,
					expiresAt: now,
				});
				if (result.kind !== "EXECUTE")
					throw new Error("expected an owned STOP");
				return result.claim;
			};
			if (
				winner === "older failed callback" ||
				winner === "older failed callback for same admission"
			) {
				await b();
				captureReplacement();
				const process = createLiveChannelProcessor(f.deps);
				const { effect: _effect, ...bare } = job;
				expect(await process(bare, jobId)).toMatchObject({
					status: "EFFECT_REFUSED",
				});
				expect(await process(job, jobId)).toMatchObject({
					status: "SKIPPED_STALE_GENERATION",
				});
				const claim = await interruptOwner();
				expect(
					await markLiveEffectFailed(tenant, claim, "feeder lookup failed"),
				).toBe(true);
				const failedDelivery = {
					id: jobId,
					attemptsMade: 3,
					opts: { attempts: 3 },
				};
				const emitEvent = vi.fn();
				const stale = {
					...failedDelivery,
					data: winner === "older failed callback" ? older : job,
				};
				expect(
					await recordFinalStopFailure(
						tenant,
						stale,
						"earlier job exhausted",
						emitEvent,
					),
				).toBe(false);
				await recordDeadJobScheduleOutcomes(
					tenant,
					stale,
					"earlier job exhausted",
					now,
				);
				expect(emitEvent).not.toHaveBeenCalled();
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({
					status: "STOPPING",
					liveEffectFenceVersion: claim.generation,
				});
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					}),
				).toMatchObject({ status: "STOPPING" });
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
				).toMatchObject({ outcome: "PENDING" });
				expect(
					await recordFinalStopFailure(
						tenant,
						{ ...failedDelivery, id: currentJobId, data: currentJob },
						"current job exhausted",
						emitEvent,
					),
				).toBe(true);
				expect(emitEvent).toHaveBeenCalledOnce();
				return;
			}
			const first = a();
			try {
				await read;
				await b();
				captureReplacement();
			} finally {
				resume();
				await first;
			}
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
			).toMatchObject({
				outcome: "PENDING",
				stopDeliveryToken: currentJob.effect.stopDeliveryToken,
			});
			// An independent terminal callback for the current delivery can still
			// classify provider outcome as unknown before owner confirmation arrives.
			await recordDeadJobScheduleOutcomes(
				tenant,
				{
					id: currentJobId,
					data: currentJob,
					finishedOn: now.getTime(),
				},
				"current delivery outcome was not observed",
				now,
			);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			const observerDeps = {
				...f.deps,
				now: () => new Date(now.getTime() + 86400000).toISOString(),
				makeSdk: () =>
					fakeSdk({
						getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
					}),
			};
			const observe = createUncertainStopReconciler(observerDeps, vi.fn());
			const deferredAisa = winner.startsWith(
				"managed AISA completes after encoder Stop",
			);
			let resumeAisaResults: (() => void) | undefined;
			if (
				winner === "managed AISA owner" ||
				deferredAisa ||
				winner === "managed AISA terminal before request"
			) {
				const analysisId = randomUUID();
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
					data: { aisaAnalysisId: analysisId, aisaStatus: "RUNNING" },
				});
				let analysisStopped = false;
				let resultReady = !deferredAisa;
				f.sdk.getEncodingStatus = vi.fn(async () => {
					if (!stopped) return { status: "RUNNING" };
					if (!resultReady && winner.endsWith("an unread encoder"))
						throw new Error("temporary encoding status read failure");
					if (!resultReady && winner.endsWith("an active encoder"))
						return { status: "RUNNING" };
					return { status: "FINISHED" };
				});
				resumeAisaResults = () => {
					resultReady = true;
				};
				const client = {
					get: vi.fn(async () => ({
						analysisId,
						encodingId: f.encodingId,
						status: analysisStopped ? "FINISHED" : "RUNNING",
					})),
					stop: vi.fn(async () => {
						analysisStopped = true;
					}),
					latest: vi.fn(async () => {
						if (!resultReady) throw new AisaLiveError(502);
						return snapshot;
					}),
				};
				provider.aisa.mockReturnValue(client);
				f.deps.makeSdk = (options) => ({
					...f.sdk,
					...createAisaLiveOps(
						{ options, audited: (_method, _path, _body, fn) => fn() },
						f.sdk,
						f.sdk,
					),
				});
				stopped = winner === "managed AISA terminal before request";
			}
			if (winner === "observer only") {
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
				await b();
				await observe();
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "STOPPED" });
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
				).toMatchObject({
					outcome: "UNKNOWN",
					outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
				});
				expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
				return;
			}
			if (winner === "observer before owner") {
				let readAfterSend!: () => void, returnRead!: () => void;
				const started = new Promise<void>((resolve) => {
					readAfterSend = resolve;
				});
				const reader = new Promise<void>((resolve) => {
					returnRead = resolve;
				});
				f.sdk.getEncodingStatus = vi.fn(async () => {
					if (!stopped) return { status: "RUNNING" };
					readAfterSend();
					await reader;
					return { status: "FINISHED" };
				});
				const drive = createLiveChannelProcessor(f.deps)(
					currentJob,
					currentJobId,
				);
				try {
					await started;
					await observe();
					expect(
						await tenant.liveEffectClaim.findUniqueOrThrow({
							where: { idempotencyKey: job.effect.idempotencyKey },
						}),
					).toMatchObject({ state: "ACKED" });
					expect(
						await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
					).toMatchObject({ outcome: "UNKNOWN" });
				} finally {
					returnRead();
					await drive;
				}
			} else if (winner === "expired unsent owner") {
				const old = await interruptOwner();
				const processor = createLiveChannelProcessor(f.deps);
				const resumeUnsent = vi.fn((resumed, active) =>
					processor(resumed, undefined, false, active),
				);
				await createUncertainStopReconciler(f.deps, resumeUnsent)();
				expect(resumeUnsent).toHaveBeenCalledOnce();
				expect(await resumeUnsent.mock.results[0]?.value).toMatchObject({
					status: "STOPPED",
				});
				expect(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { id: old.id },
					}),
				).toMatchObject({ attempt: 2 });
			} else {
				const process = createLiveChannelProcessor(f.deps);
				if (deferredAisa) {
					await expect(process(currentJob, currentJobId)).rejects.toThrow();
					expect(
						await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
					).toMatchObject({ outcome: "UNKNOWN" });
					resumeAisaResults?.();
				}
				expect(await process(currentJob, currentJobId)).toMatchObject({
					status: "STOPPED",
				});
			}
			const accepted = winner !== "managed AISA terminal before request";
			if (accepted)
				expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
					f.encodingId,
				);
			else expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { idempotencyKey: job.effect.idempotencyKey },
				}),
			).toMatchObject({
				scheduleId: id,
				state: "ACKED",
				generation: winner === "expired unsent owner" || deferredAisa ? 4 : 3,
			});
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id } }),
			).toMatchObject({
				outcome: accepted ? "DELIVERED" : "UNKNOWN",
				outcomeEvidenceKind: accepted
					? "PROVIDER_TERMINAL"
					: "JOB_TERMINAL_UNKNOWN",
			});
		});
		it.each([
			false,
			true,
		])("does not attribute a manual Stop's terminal proof to a superseded schedule (previous send reservation: %s)", async (reserved) => {
			const { scope, ...f } = await isolatedDispatchFixture();
			const schedule = await scope.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					fireAt: now,
					firedAt: now,
					dispatchedAt: now,
					action: "STOP",
					status: "FIRED",
					stopProviderEncodingId: f.encodingId,
					stopAdmissionFenceVersion: 0,
				},
			});
			const prior = await beginLiveEffect(scope, {
				...f.identity,
				liveChannelId: f.channel.id,
				idempotencyKey: `schedule:${schedule.id}:stop`,
				scheduleId: schedule.id,
				expectedFenceVersion: 0,
				ownerId: "displaced-worker",
				now,
				expiresAt: new Date(now.getTime() + 30_000),
			});
			if (prior.kind !== "EXECUTE") throw new Error("missing scheduled STOP");
			if (reserved)
				expect(
					await claimLiveStopSend(scope, prior.claim, f.encodingId, now),
				).toBe(true);
			expect(await createLiveChannelProcessor(f.deps)(f.job)).toMatchObject({
				status: "STOPPED",
			});
			expect(
				await scope.liveEffectClaim.findUniqueOrThrow({
					where: { id: prior.claim.id },
				}),
			).toMatchObject({ state: "ACKED" });
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: schedule.id },
				}),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
		});

		it("keeps the newest STOP delivery ready when two sweeps replace a missing Redis job", async () => {
			const { scope, ...f } = await isolatedDispatchFixture();
			await scope.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPING", legacyAdmissionFenceVersion: 0 },
			});
			await scope.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const scheduleId = randomUUID();
			const key = `schedule:${scheduleId}:stop`;
			await scope.liveSchedule.create({
				data: {
					id: scheduleId,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: now,
					firedAt: now,
					dispatchedAt: now,
					dispatchJobId: `sched-${scheduleId}`,
					stopAdmissionFenceVersion: 0,
					stopProviderEncodingId: f.encodingId,
				},
			});
			let stopped = false;
			f.sdk.getEncodingStatus = vi.fn(async () => ({
				status: stopped ? "FINISHED" : "RUNNING",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				stopped = true;
			});
			type Delivery = import("@bitovp/core").LiveChannelJob;
			const redis = new Map<string, Delivery>();
			const read = async (id: string) => {
				const data = redis.get(id);
				return data ? { data, getState: async () => "waiting" } : undefined;
			};
			const heldSweep = () => {
				const held = barrier();
				const release = barrier();
				const enqueue = vi.fn(async (delivery: Delivery, id: string) => {
					held.release();
					await release.ready;
					if (!redis.has(id)) redis.set(id, delivery);
				});
				const run = createExhaustedScheduledStopRecovery(
					f.deps,
					read,
					enqueue,
				)();
				return { held, release, enqueue, run };
			};
			const first = heldSweep();
			let second: ReturnType<typeof heldSweep> | undefined;
			try {
				await reach(first.held.ready, first.run);
				second = heldSweep();
				await reach(second.held.ready, second.run);
				first.release.release();
				await first.run;
			} finally {
				first.release.release();
				second?.release.release();
				await Promise.allSettled([first.run, second?.run]);
			}
			const [oldJob, oldId] = first.enqueue.mock.calls[0] ?? [];
			const [current, currentId] = second?.enqueue.mock.calls[0] ?? [];
			expect(redis.size).toBe(2);
			if (!currentId || !oldId || !current?.effect || !oldJob?.effect)
				throw new Error(
					"both outbox replacements must publish exact envelopes",
				);
			expect(current.effect.idempotencyKey).toBe(key);
			expect(oldJob.effect.idempotencyKey).toBe(key);
			expect(current.effect.stopDeliveryToken).not.toBe(
				oldJob.effect.stopDeliveryToken,
			);
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: scheduleId },
				}),
			).toMatchObject({
				dispatchJobId: currentId,
				stopDeliveryToken: current.effect.stopDeliveryToken,
			});
			const process = createLiveChannelProcessor(f.deps);
			expect(await process(redis.get(oldId), oldId)).toMatchObject({
				status: "SKIPPED_STALE_GENERATION",
			});
			await recordDeadJobScheduleOutcomes(
				scope,
				{ id: oldId, data: oldJob, finishedOn: now.getTime() },
				"superseded delivery",
				now,
			);
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: scheduleId },
				}),
			).toMatchObject({ outcome: "PENDING" });
			expect(await process(redis.get(currentId), currentId)).toMatchObject({
				status: "STOPPED",
			});
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
				f.encodingId,
			);
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: scheduleId },
				}),
			).toMatchObject({ outcome: "DELIVERED" });
		});

		it("closes an independently ended encoder without attributing a reserved STOP to its schedule", async () => {
			const { scope, ...f } = await isolatedDispatchFixture();
			await scope.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPING" },
			});
			await scope.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPING" },
			});
			const scheduleId = randomUUID();
			await scope.liveSchedule.create({
				data: {
					id: scheduleId,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					fireAt: now,
					firedAt: now,
					dispatchedAt: now,
					dispatchJobId: scheduledStopJobId(scheduleId),
					action: "STOP",
					status: "FIRED",
					stopProviderEncodingId: f.encodingId,
					stopAdmissionFenceVersion: 0,
				},
			});
			const expiresAt = new Date(now.getTime() + 1_000);
			const admitted = await beginLiveEffect(scope, {
				...f.identity,
				liveChannelId: f.channel.id,
				scheduleId,
				idempotencyKey: `schedule:${scheduleId}:stop`,
				expectedFenceVersion: 0,
				ownerId: "worker-crashed-before-POST",
				now,
				expiresAt,
			});
			if (admitted.kind !== "EXECUTE")
				throw new Error("Expected initial STOP lease");
			expect(
				await claimLiveStopSend(scope, admitted.claim, f.encodingId, now),
			).toBe(true);
			const tick = createUncertainStopReconciler({
				...f.deps,
				now: () => expiresAt.toISOString(),
			});
			expect(await tick()).toBe(1);
			expect(
				await scope.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({ status: "STOPPED" });
			expect(
				await scope.liveEffectClaim.findUniqueOrThrow({
					where: { id: admitted.claim.id },
				}),
			).toMatchObject({ state: "ACKED" });
			expect(
				await scope.liveSchedule.findUniqueOrThrow({
					where: { id: scheduleId },
				}),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
			});
			expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		});

		it("finishes a pre-upgrade STOP admission interrupted after FIRED only for unchanged airing owners", async () => {
			const migration = readFileSync(
				new URL(
					"../../../../packages/db/prisma/migrations/20261126003500_recover_undispatched_live_stop/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			const deliveryMigration = readFileSync(
				new URL(
					"../../../../packages/db/prisma/migrations/20261126012500_fence_migrated_stop_queue_delivery/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			const armed = [];
			const firedAt = new Date(Date.now() + 60_000);
			for (const status of ["RUNNING", "ERROR", "RUNNING"] as const) {
				const f = await fixture(status, null);
				const row = await tenant.liveSchedule.create({
					data: {
						action: "STOP",
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						status: "FIRED",
						fireAt: firedAt,
						firedAt,
					},
				});
				armed.push({ f, row });
			}
			const changed = armed[2];
			if (!changed) throw new Error("Missing later ownership fixture");
			await tenant.liveChannel.update({
				where: { id: changed.f.channel.id },
				data: {
					liveEffectFenceVersion: { increment: 1 },
					updatedAt: new Date(firedAt.getTime() - 1),
				},
			});
			// The base scheduler commits FIRED after a concurrent Start already revived this same run.
			await tenant.liveSchedule.update({
				where: { id: changed.row.id },
				data: { firedAt },
			});
			for (const { f } of armed.slice(0, 2)) {
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: {
						heartbeatPollEpoch: { increment: 1 },
						updatedAt: new Date(firedAt.getTime() + 1),
					},
				});
			}
			await admin.$executeRawUnsafe(migration);
			await admin.$executeRawUnsafe(migration);
			await admin.$executeRawUnsafe(deliveryMigration);
			const assigned = new Map(
				(
					await tenant.liveSchedule.findMany({
						where: { id: { in: armed.map(({ row }) => row.id) } },
					})
				).map((row) => [row.id, row.stopDeliveryToken]),
			);
			await admin.$executeRawUnsafe(deliveryMigration);
			type Delivery = import("@bitovp/core").LiveChannelJob;
			const retained = new Map<string, Delivery>();
			for (const { f, row } of armed.slice(0, 2)) {
				retained.set(scheduledStopJobId(row.id), {
					liveChannelId: f.channel.id,
					action: "stop",
					plannedLiveChannelRunId: f.run.id,
					effect: {
						action: "STOP",
						scheduleId: row.id,
						idempotencyKey: `schedule:${row.id}:stop`,
						liveChannelRunId: f.run.id,
						providerEncodingId: f.encodingId,
						admissionFenceVersion: 0,
					},
				});
			}
			const enqueue = vi.fn(async (job: Delivery, id: string) => {
				// BullMQ retains the first payload added under a custom ID.
				if (!retained.has(id)) retained.set(id, job);
			});
			const emitEvent = vi.fn(async () => {});
			await createScheduleSweep({
				prisma: tenant,
				now: () => new Date(firedAt.getTime() + 600_000),
				enqueue,
				emitEvent,
			}).dispatchPending();
			for (const { f, row } of armed.slice(0, 2)) {
				const saved = await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: row.id },
				});
				if (!saved.stopDeliveryToken)
					throw new Error("Migrated STOP reused the occupied legacy job ID");
				expect(saved.stopDeliveryToken).toBe(assigned.get(row.id));
				const currentId = scheduledStopJobId(row.id, saved.stopDeliveryToken);
				const oldId = scheduledStopJobId(row.id);
				expect(currentId).not.toBe(oldId);
				expect(saved.dispatchJobId).toBe(currentId);
				expect(retained.get(oldId)?.effect?.admissionFenceVersion).toBe(0);
				expect(retained.get(currentId)?.effect?.admissionFenceVersion).toBe(1);
				expect(enqueue).toHaveBeenCalledWith(
					expect.objectContaining({
						effect: expect.objectContaining({
							liveChannelRunId: f.run.id,
							providerEncodingId: f.encodingId,
							admissionFenceVersion: 1,
							stopDeliveryToken: saved.stopDeliveryToken,
						}),
					}),
					currentId,
				);
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					}),
				).toMatchObject({ status: "STOPPING", liveEffectFenceVersion: 1 });
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					}),
				).toMatchObject({ status: "STOPPING" });
				const dispatchAt = new Date(firedAt.getTime() + 600_000);
				const admission = {
					idempotencyKey: `schedule:${row.id}:stop`,
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					providerEncodingId: f.encodingId,
					scheduleId: row.id,
					action: "STOP" as const,
					ownerId: "migration-fixture",
					now: dispatchAt,
					expiresAt: new Date(dispatchAt.getTime() + 30_000),
				};
				expect(
					await beginLiveEffect(tenant, {
						...admission,
						expectedFenceVersion: 0,
					}),
				).toMatchObject({ kind: "STALE" });
				expect(
					await beginLiveEffect(tenant, {
						...admission,
						expectedFenceVersion: 1,
						stopDeliveryToken: randomUUID(),
					}),
				).toMatchObject({ kind: "STALE" });
				expect(
					await beginLiveEffect(tenant, {
						...admission,
						expectedFenceVersion: 1,
						stopDeliveryToken: saved.stopDeliveryToken,
					}),
				).toMatchObject({ kind: "EXECUTE" });
			}
			expect(enqueue).not.toHaveBeenCalledWith(
				expect.anything(),
				`sched-${changed.row.id}`,
			);
			expect(
				await tenant.liveStopNotification.findUnique({
					where: { scheduleId: changed.row.id },
				}),
			).toMatchObject({
				kind: "SCHEDULE_MISSED",
				channelId: changed.f.channel.id,
				finishedAt: null,
			});
			expect(emitEvent).not.toHaveBeenCalledWith(
				expect.objectContaining({ scheduleId: changed.row.id }),
			);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: changed.row.id },
				}),
			).toMatchObject({
				outcome: "UNKNOWN",
				outcomeNote: expect.stringContaining("confirm"),
				stopDeliveryToken: null,
			});
		});
		it("refuses an old unfenced STOP outbox and a retained bare job after same-airing revival", async () => {
			const f = await dispatchFixture(),
				generation = 3;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					legacyAdmissionFenceVersion: 2,
					liveEffectFenceVersion: generation,
				},
			});
			const old = await tenant.liveSchedule.create({
				data: {
					action: "STOP",
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					status: "FIRED",
					fireAt: lease,
					firedAt: lease,
				},
			});
			expect(
				(await readLegacyScheduledStop(tenant, old.id, f.channel.id, f.run.id))
					?.effect,
			).toBeUndefined();
			const enqueue = vi.fn(async () => {});
			await createScheduleSweep({
				prisma: tenant,
				now: () => new Date(now.getTime() + 600000),
				enqueue,
			}).dispatchPending();
			expect(enqueue).not.toHaveBeenCalledWith(
				expect.anything(),
				`sched-${old.id}`,
			);
			expect(
				await tenant.liveSchedule.findUniqueOrThrow({ where: { id: old.id } }),
			).toMatchObject({
				stopProviderEncodingId: null,
				stopAdmissionFenceVersion: null,
			});
			await tenant.liveSchedule.delete({ where: { id: old.id } });
		});

		it("delivers a missed legacy STOP after the scheduler exits with Redis unavailable", async () => {
			const f = await dispatchFixture();
			const at = new Date(now.getTime() + 600000);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					legacyAdmissionFenceVersion: 2,
					liveEffectFenceVersion: 3,
				},
			});
			const row = await tenant.liveSchedule.create({
				data: {
					liveChannelId: f.channel.id,
					liveChannelRunId: f.run.id,
					action: "STOP",
					status: "FIRED",
					fireAt: lease,
					firedAt: lease,
				},
			});
			const enqueue = vi.fn(async () => {
				throw new Error("Redis unavailable");
			});
			const emitEvent = vi.fn(async () => {
				throw new Error("Redis unavailable");
			});
			const restart = () =>
				createScheduleSweep({
					prisma: tenant,
					now: () => at,
					enqueue,
					emitEvent,
				});
			await restart().dispatchPending();
			const receipt = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: row.id },
			});
			expect(receipt).toMatchObject({
				status: "ERROR",
				outcome: "UNKNOWN",
				dispatchedAt: null,
			});
			expect(
				await tenant.liveStopNotification.findUnique({
					where: { scheduleId: row.id },
				}),
			).toMatchObject({
				kind: "SCHEDULE_MISSED",
				channelId: f.channel.id,
				finishedAt: null,
			});
			await restart().dispatchPending();
			expect(emitEvent).not.toHaveBeenCalledWith(
				expect.objectContaining({ scheduleId: row.id }),
			);
			expect(enqueue).not.toHaveBeenCalledWith(
				expect.anything(),
				`sched-${row.id}`,
			);
			const delivered: unknown[] = [];
			let clock = at;
			let attempts = 0;
			const delivery = () =>
				createStopNotificationSweep(
					tenant,
					async ({ data, beforeSend }) => {
						const event = productEventSchema.parse(data);
						if (
							event.kind === "SCHEDULE_MISSED" &&
							event.scheduleId === row.id
						) {
							await beforeSend?.();
							if (++attempts === 1)
								throw new Error("temporary destination failure");
							delivered.push(event);
						}
						return [{ outcome: "DELIVERED" as const }];
					},
					"https://operator.example",
					() => clock,
				);
			for (let i = 0; i < 20 && !attempts; i++) await delivery()();
			expect(attempts).toBe(1);
			clock = new Date(at.getTime() + 65000);
			for (let i = 0; i < 20 && !delivered.length; i++) await delivery()();
			await delivery()();
			expect(delivered).toEqual([
				{
					eventVersion: 1,
					kind: "SCHEDULE_MISSED",
					liveChannelId: f.channel.id,
					scheduleId: row.id,
					reason: receipt.outcomeNote,
					occurredAt: at.toISOString(),
					link: `https://operator.example/live/${f.channel.id}`,
				},
			]);
			expect(attempts).toBe(2);
			expect(
				await tenant.liveStopNotification.findUnique({
					where: { scheduleId: row.id },
				}),
			).toMatchObject({ failures: 1, finishedAt: clock });
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
			const dispatched = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: original.id },
			});
			const job = dispatched.dispatchJobId
				? retained.get(dispatched.dispatchJobId)
				: undefined;
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
			if (status === "FIRED") await snapshotLegacyAdmissions();
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
				([data]) => data.effect?.scheduleId === active.id,
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
		] as const)("preserves one exact schedule handoff notification for a %s STOP failure", async (format) => {
			const { scope: tenant, ...f } = await isolatedDispatchFixture();
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
					firedAt: lease,
				},
			});
			if (format === "legacy") await snapshotLegacyAdmissions();
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
			const handoffAt =
				format === "legacy" ? new Date(now.getTime() + 600_000) : now;
			let handoffJobId = job.id;
			if (format === "legacy") {
				expect(
					await tenant.liveSchedule.findUniqueOrThrow({
						where: { id: row.id },
					}),
				).toMatchObject({ outcome: "PENDING", dispatchedAt: null });
				const retained = new Map<string, unknown>([[job.id, job.data]]);
				const enqueue = async (
					data: import("@bitovp/core").LiveChannelJob,
					id: string,
				) => {
					if (!retained.has(id)) retained.set(id, data);
				};
				await createScheduleSweep({
					prisma: tenant,
					now: () => handoffAt,
					enqueue,
				}).dispatchPending();
				const receipt = await tenant.liveSchedule.findUniqueOrThrow({
					where: { id: row.id },
				});
				handoffJobId = receipt.dispatchJobId ?? job.id;
				const delivery = retained.get(handoffJobId) as
					| import("@bitovp/core").LiveChannelJob
					| undefined;
				expect(delivery?.effect?.scheduleId).toBe(row.id);
				expect(handoffJobId).not.toBe(job.id);
				expect(
					await createLiveChannelProcessor(f.deps)(job.data, job.id),
				).toMatchObject({ status: "EFFECT_REFUSED" });
				await recordDeadJobScheduleOutcomes(
					tenant,
					{
						...job,
						id: handoffJobId,
						data: delivery,
					},
					"identified scheduled stop exhausted",
					handoffAt,
				);
			}
			const durableClaim = await tenant.liveEffectClaim.findUnique({
				where: { idempotencyKey: `schedule:${row.id}:stop` },
			});
			expect(durableClaim).toBeNull();
			expect(
				await tenant.liveSchedule.findUnique({ where: { id: row.id } }),
			).toMatchObject({
				outcome: "UNKNOWN",
				dispatchJobId: handoffJobId,
				dispatchedAt: handoffAt,
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
				() => handoffAt,
			);
			for (let pass = 0; pass < 20 && !delivered.length; pass++) await notify();
			await notify();
			expect(delivered).toEqual([
				{
					eventVersion: 1,
					kind: "SCHEDULE_FIRED",
					scheduleId: row.id,
					liveChannelId: f.channel.id,
					occurredAt: handoffAt.toISOString(),
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
			const currentJobId = scheduledStopJobId(row.id, row.stopDeliveryToken);
			expect(row).toMatchObject({
				status: "FIRED",
				liveChannelRunId: successorId,
				dispatchJobId: currentJobId,
			});
			expect(enqueue).toHaveBeenCalledWith(
				expect.objectContaining({
					effect: expect.objectContaining({
						liveChannelRunId: successorId,
						providerEncodingId: "next-cap-encoder",
						scheduleId: row.id,
					}),
				}),
				currentJobId,
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

		async function dispatchFixture(encodingId?: string, scope = tenant) {
			const f = await fixture("RUNNING", null, encodingId, scope);
			const accountId = randomUUID();
			await scope.liveChannel.update({
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
				prisma: scope,
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

		async function isolatedDispatchFixture(encodingId?: string) {
			const id = randomUUID();
			organizationIds.push(id);
			await admin.organization.create({
				data: { id, name: "Scheduled STOP recovery test", slug: `test-${id}` },
			});
			const scope = createTenantPrismaClient(runtime, id);
			return { scope, ...(await dispatchFixture(encodingId, scope)) };
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
			const proc = createLiveChannelProcessor(f.deps);
			const pending = proc(f.job);
			if (providerState === "unreadable") {
				await expect(pending).rejects.toThrow();
				await expect(proc(f.job)).rejects.toThrow();
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
				await expect(proc(f.job)).resolves.toMatchObject({ status: "STOPPED" });
			} else
				await expect(pending).resolves.toMatchObject({ status: "STOPPED" });
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledTimes(
				providerState === "active" ? 1 : 0,
			);
		});

		it.each([
			"index",
			"run-log",
			"scheduled",
			"scte",
			"preflight-failure",
		] as const)("recovers the first STOP for a displaced encoder recorded in %s after a pre-journal clean ACK", async (source) => {
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
					...(source !== "run-log"
						? {
								previousProviderEncodingIds:
									source === "scte" ? [] : [secondary],
							}
						: {
								stepLog: [
									{
										step: "other",
										kind: "CREATE_ENCODING",
										status: "DONE",
										resourceId: secondary,
										payload: {},
										refs: {},
									},
								],
							}),
				},
			});
			if (source === "scte")
				await tenant.liveEffectClaim.create({
					data: {
						...f.identity,
						liveChannelId: f.channel.id,
						providerEncodingId: secondary,
						action: "SCTE35",
						state: "ACKED",
						generation: 0,
						token: randomUUID(),
						idempotencyKey: randomUUID(),
						ownerId: "fixture",
						expiresAt: lease,
					},
				});
			const oldKey =
				source === "scheduled" || source === "preflight-failure"
					? "scheduled-stop-" + randomUUID()
					: f.job.effect.idempotencyKey;
			await tenant.liveEffectClaim.create({
				data: {
					...f.identity,
					liveChannelId: f.channel.id,
					generation: 1,
					ownerId: "legacy",
					expiresAt: lease,
					token: randomUUID(),
					idempotencyKey: oldKey,
					state: "ACKED",
					acknowledgedAt: lease,
				},
			});
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(false);
			let posted = false;
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === secondary && !posted ? "RUNNING" : "FINISHED",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				posted = true;
			});
			if (source === "preflight-failure") {
				const broken = createLiveChannelProcessor({
					...f.deps,
					makeSdk: () => {
						throw new Error("temporarily unavailable");
					},
				});
				await expect(broken(f.job)).rejects.toThrow();
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
			}
			const proc = createLiveChannelProcessor(f.deps);
			expect(await proc(f.job)).toMatchObject({ status: "STOPPED" });
			await proc(f.job);
			if (source === "preflight-failure")
				expect(f.sdk.stopLiveEncoding).not.toHaveBeenCalled();
			else
				expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(
					secondary,
				);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(true);
			expect(
				await tenant.liveEffectClaim.findUniqueOrThrow({
					where: { idempotencyKey: oldKey },
				}),
			).toMatchObject({
				state: "ACKED",
				stopProtocolVersion: null,
				legacyUnsentStopIds: [secondary],
			});
		});

		it.each([
			null,
			1,
		])("sends only the first STOP for a promoted secondary after an older manual ACK on another target (protocol %s)", async (version) => {
			const f = await dispatchFixture(),
				secondary = "zz-secondary-" + randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPED",
					error: null,
					bitmovinEncodingId: null,
					encoderStoppedConfirmedFor: version === null ? f.encodingId : null,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPED",
					error: null,
					bitmovinEncodingId: null,
					previousProviderEncodingIds: [secondary],
					...(version === null
						? {
								encoderStoppedConfirmedFor: f.encodingId,
								providerTerminalAt: lease,
								providerStatus: "FINISHED",
								providerStatusObservedAt: lease,
							}
						: {}),
					rtmpRetirementEvidence:
						version === null
							? []
							: [
									{
										encodingId: f.encodingId,
										accountId: f.accountId,
										observedAt: lease.toISOString(),
										providerStatus: "FINISHED",
										disposition: "TERMINAL",
									},
								],
				},
			});
			await tenant.liveEffectClaim.create({
				data: {
					...f.identity,
					liveChannelId: f.channel.id,
					idempotencyKey: f.job.effect.idempotencyKey,
					state: "ACKED",
					generation: 0,
					ownerId: "old",
					token: randomUUID(),
					expiresAt: lease,
					acknowledgedAt: lease,
					stopProtocolVersion: version,
					stopSendEncodingIds: version === 1 ? [f.encodingId] : [],
				},
			});
			expect(await bindArchivedStopTarget(tenant, f.channel.id, f.run.id)).toBe(
				secondary,
			);
			const job = {
				...f.job,
				effect: {
					...f.job.effect,
					idempotencyKey: `manual:stop:${f.channel.id}:${f.run.id}:archive:${secondary}`,
					providerEncodingId: secondary,
				},
			};
			let stopped = false;
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === secondary && !stopped ? "RUNNING" : "FINISHED",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async (id) => {
				expect(id).toBe(secondary);
				stopped = true;
			});
			const proc = createLiveChannelProcessor(f.deps);
			expect(await proc(job)).toMatchObject({ status: "STOPPED" });
			await proc(job);
			expect(f.sdk.stopLiveEncoding).toHaveBeenCalledExactlyOnceWith(secondary);
			expect(
				(
					await tenant.liveEffectClaim.findUniqueOrThrow({
						where: { idempotencyKey: f.job.effect.idempotencyKey },
					})
				).providerEncodingId,
			).toBe(f.encodingId);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(true);
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

		it.each([
			"run-log",
			"closed-journal",
		] as const)("retains %s encoder during startup cancellation, then rechecks under the channel lock", async (source) => {
			const f = await dispatchFixture(randomUUID()),
				secondary = randomUUID();
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			plan.bitmovin.accountId = f.accountId;
			await tenant.bitmovinAccount.create({
				data: {
					id: f.accountId,
					label: "test",
					encryptedApiKey: "fixture-only",
				},
			});
			const entries = initStepLog(compileLiveChannel(plan)).map((e) => ({
				...e,
				status: "DONE",
				resourceId: e.kind === "CREATE_ENCODING" ? f.encodingId : randomUUID(),
			}));
			const old = {
				step: "old",
				kind: "CREATE_ENCODING",
				status: "DONE",
				resourceId: secondary,
				refs: {},
				payload: {},
			};
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "STOPPING",
					plan,
					stepLog: JSON.parse(JSON.stringify(entries)),
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPING",
					cancelRequested: true,
					stepLog: JSON.parse(
						JSON.stringify(source === "run-log" ? [...entries, old] : entries),
					),
				},
			});
			if (source === "closed-journal")
				await tenant.liveEffectClaim.create({
					data: {
						...f.identity,
						liveChannelId: f.channel.id,
						idempotencyKey: randomUUID(),
						providerEncodingId: f.encodingId,
						stopProtocolVersion: 1,
						stopSendEncodingIds: [secondary],
						state: "RESOLVED",
						ownerId: "prior",
						generation: 0,
						token: randomUUID(),
						expiresAt: lease,
					},
				});
			let secondActive = true;
			f.sdk.getEncodingStatus = vi.fn(async (id) => ({
				status: id === secondary && secondActive ? "RUNNING" : "FINISHED",
			}));
			const proc = createLiveChannelProcessor(f.deps);
			const job = {
				liveChannelId: f.channel.id,
				action: "provision",
				params: { cancelRunId: f.run.id },
			};
			expect(await proc(job)).toMatchObject({ status: "STOPPING" });
			expect(f.sdk.getEncodingStatus).toHaveBeenCalledWith(secondary);
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(0);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(false);
			if (source === "closed-journal") {
				// Both mirrored IDs must settle before cancelling this airing.
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: {
						bitmovinEncodingId: secondary,
						providerStatus: "RUNNING",
						stepLog: JSON.parse(
							JSON.stringify(
								entries.map((entry) =>
									entry.kind === "CREATE_ENCODING"
										? { ...entry, status: "RUNNING", resourceId: secondary }
										: entry,
								),
							),
						),
					},
				});
				expect(await proc(job)).toMatchObject({ status: "STOPPING" });
			}
			secondActive = false;
			expect(await proc(job)).toMatchObject({ status: "STOPPED" });
			if (source === "closed-journal") {
				const closed = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				expect(closed.providerStatus).toBe("FINISHED");
				expect(closed.stepLog).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "CREATE_ENCODING",
							resourceId: secondary,
						}),
					]),
				);
			}
			expect(
				await tenant.liveStopNotification.count({ where: { id: f.run.id } }),
			).toBe(1);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(true);
		});
		it("revalidates run-only AISA ownership at the last automatic shutdown send fence", async () => {
			const f = await dispatchFixture(randomUUID());
			const held = await beginLiveEffect(tenant, {
				...f.identity,
				action: "AUTO_SHUTDOWN_UPDATE",
				liveChannelId: f.channel.id,
				idempotencyKey: "timer:" + randomUUID(),
				expectedFenceVersion: 0,
				ownerId: "local-worker",
				now,
				expiresAt: new Date(now.getTime() + 60_000),
			});
			if (held.kind !== "EXECUTE")
				throw new Error("Missing timer claim: " + held.kind);
			expect(await assertLiveEffectCurrent(tenant, held.claim, now)).toBe(true);
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { aisaAnalysisId: randomUUID() },
			});
			expect(await assertLiveEffectCurrent(tenant, held.claim, now)).toBe(
				false,
			);
		});

		it.each([
			"initialization",
			"progress",
			"SDK renewal",
			"SDK renewal in same generation",
		] as const)("keeps a successor run intact when a displaced provision resumes during %s", async (phase) => {
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
			plan.bitmovin.accountId = f.accountId;
			await tenant.bitmovinAccount.create({
				data: {
					id: f.accountId,
					label: "offline fixture",
					encryptedApiKey: "fixture-only",
				},
			});
			const stepLog = JSON.parse(
				JSON.stringify(
					initStepLog(compileLiveChannel(plan)).map((entry) =>
						["CREATE_INPUT_RTMP", "CREATE_OUTPUT_S3"].includes(entry.kind)
							? { ...entry, status: "DONE", resourceId: randomUUID() }
							: entry,
					),
				),
			);
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "PROVISIONING",
					bitmovinEncodingId: null,
					plan,
					stepLog,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "PROVISIONING", bitmovinEncodingId: null, stepLog },
			});
			const entered = barrier(),
				reply = barrier();
			const renewal = phase.startsWith("SDK renewal");
			const secondTick = barrier();
			let ticks = 0;
			let displaced = false;
			if (renewal) {
				f.deps.leaseRenewalIntervalMs = 5;
				f.deps.now = () => {
					if (displaced && ++ticks === 2) secondTick.release();
					return new Date(now.getTime() + (displaced ? 2000 : 0)).toISOString();
				};
			}
			const pause = async () => {
				entered.release();
				await reply.ready;
			};
			f.deps.resolveCredential = async () => ({
				provider: "AWS_S3",
				config: {},
				secret: {
					accessKeyId: "fixture-id",
					secretAccessKey: "fixture-secret",
				},
			});
			const reveal = f.deps.revealBitmovinAccount;
			f.deps.revealBitmovinAccount = async (id) => {
				if (phase === "initialization") await pause();
				return reveal(id);
			};
			f.sdk.createEncoding = vi.fn(async () => {
				if (phase === "progress" || renewal) await pause();
				return f.encodingId;
			});
			const work = Promise.allSettled([
				createLiveChannelProcessor(f.deps)({
					action: "provision",
					liveChannelId: f.channel.id,
					plannedLiveChannelRunId: f.run.id,
				}),
			]);
			const winner = randomUUID();
			try {
				await Promise.race([
					entered.ready,
					work.then(([r]) => {
						throw new Error(
							"Provision ended before " +
								phase +
								": " +
								(r?.status === "rejected"
									? String(r.reason)
									: JSON.stringify(r)),
						);
					}),
				]);
				await tenant.$transaction(async (tx) => {
					// Different admission in the same clock tick. The run/generation still identify the successor.
					await tx.liveChannel.update({
						where: { id: f.channel.id },
						data: {
							status: "RUNNING",
							liveEffectFenceVersion: {
								increment: phase === "SDK renewal in same generation" ? 0 : 1,
							},
							bitmovinEncodingId: winner,
							stepLog: [],
						},
					});
					await tx.liveChannelRun.update({
						where: { id: f.run.id },
						data: { status: "ERROR" },
					});
					await tx.liveChannelRun.create({
						data: {
							liveChannelId: f.channel.id,
							seq: 2,
							status: "RUNNING",
							outputPrefix: "successor",
							bitmovinEncodingId: winner,
							encoderStoppedConfirmedFor: winner,
							stepLog: [],
						},
					});
				});
				if (renewal) {
					displaced = true;
					await secondTick.ready;
					const successor = await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					});
					expect(successor.provisionClaimedAt).toEqual(now);
				}
			} finally {
				reply.release();
			}
			const [finished] = await work;
			expect(finished?.status).toBe("fulfilled");
			expect(
				await tenant.liveChannelRun.findFirstOrThrow({
					where: { liveChannelId: f.channel.id },
					orderBy: { seq: "desc" },
				}),
			).toMatchObject({
				status: "RUNNING",
				bitmovinEncodingId: winner,
				encoderStoppedConfirmedFor: winner,
				stepLog: [],
			});
			expect(
				await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				}),
			).toMatchObject({
				status: "RUNNING",
				bitmovinEncodingId: winner,
				stepLog: [],
			});
			expect(f.sdk.startLiveEncoding).not.toHaveBeenCalled();
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
			const error = `stop did not confirm — ${secondary}: response unavailable; reason: timeout`;
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
			const status = vi.fn(async (id: string) => {
				if (id === "reason") throw new Error("not an encoder");
				return { status: "FINISHED" as const };
			});
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

		it("does not replace durable dispatch evidence with an earlier provision failure snapshot", async () => {
			const f = await fixture();
			const entry = {
				kind: "CREATE_AISA_LIVE_ANALYSIS",
				step: "create",
				status: "RUNNING",
				refs: {},
				payload: {},
			};
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { stepLog: [entry] },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					stepLog: [{ ...entry, response: { aisaCreateDispatched: true } }],
				},
			});
			expect(
				await commitProvisionEnd(
					tenant,
					{
						liveChannelId: f.channel.id,
						runId: f.run.id,
						generation: 0,
						lease,
					},
					{
						status: "STOPPING",
						error: "Awaiting provider identity",
						stepLog: [entry],
					},
				),
			).toBe(true);
			const saved = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(saved.stepLog).toMatchObject([
				{ response: { aisaCreateDispatched: true } },
			]);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					})
				).stepLog,
			).toEqual(saved.stepLog);
		});
		it.each([
			true,
			false,
			"normal",
		] as const)("runs managed Analysis provisioning against both durable mirrors (%s)", async (mode) => {
			const cancelRequested = mode === true;
			vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
			try {
				const f = await dispatchFixture();
				await tenant.bitmovinAccount.create({
					data: {
						id: f.accountId,
						label: "fixture",
						encryptedApiKey: "local-only",
					},
				});
				const plan = liveChannelPlanSchema.parse({
					planVersion: 1,
					name: "Managed dispatch",
					bitmovin: {
						accountId: f.accountId,
						cloudRegion: "GOOGLE_EUROPE_WEST_1",
					},
					liveInput: { key: "main", kind: "RTMP" },
					outputs: [],
					ingest: [],
					renditions: [],
					muxings: [],
					liveManifests: [],
					start: {
						streamKey: "fixture",
						aiSceneAnalysisLive: {
							preset: "AISA_PREVIEW_MANAGED",
							outputId: f.accountId,
							recordingPath: "recording",
							analysisPath: "analysis",
						},
					},
				});
				const clean = initStepLog(compileAisaManagedLiveChannel(plan)),
					journal = structuredClone(clean);
				if (!journal[0]) throw new Error("missing managed create");
				if (mode !== "normal") {
					journal[0].response = { aisaCreateDispatched: true };
					journal[0].status = "RUNNING";
				}
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						status: "PROVISIONING",
						bitmovinEncodingId: null,
						plan: JSON.parse(JSON.stringify(plan)),
						stepLog: JSON.parse(JSON.stringify(clean)),
					},
				});
				await tenant.liveChannelRun.update({
					where: { id: f.run.id },
					data: {
						status: "PROVISIONING",
						bitmovinEncodingId: null,
						cancelRequested,
						stepLog: JSON.parse(JSON.stringify(journal)),
					},
				});
				const analysis = {
					analysisId: randomUUID(),
					encodingId: randomUUID(),
					status: "CREATED",
				};
				const client = {
					list: vi.fn(async () => ({ items: [], totalCount: 0 })),
					create: vi.fn(async () => {
						if (mode !== "normal")
							throw new Error("unexpected duplicate create");
						return analysis;
					}),
					get: vi.fn(async () => ({ ...analysis })),
					start: vi.fn(async () => {
						analysis.status = "RUNNING";
					}),
				};
				f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
				provider.aisa.mockReturnValue(client);
				f.deps.makeSdk = (options) => ({
					...f.sdk,
					...createAisaLiveOps(
						{ options, audited: (_method, _path, _body, fn) => fn() },
						f.sdk,
						f.sdk,
					),
				});
				const outcome = createLiveChannelProcessor(f.deps)({
					liveChannelId: f.channel.id,
					action: "provision",
					params: cancelRequested ? { cancelRunId: f.run.id } : {},
				});
				if (mode === "normal") {
					expect(await outcome).toMatchObject({ status: "RUNNING" });
					expect(client.create).toHaveBeenCalledTimes(1);
					expect(client.start).toHaveBeenCalledTimes(1);
					const run = await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					});
					expect(run).toMatchObject({
						status: "RUNNING",
						aisaAnalysisId: analysis.analysisId,
						bitmovinEncodingId: analysis.encodingId,
					});
					expect(run.stepLog).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								kind: "START_AISA_LIVE_ANALYSIS",
								status: "DONE",
								response: expect.objectContaining({ started: true }),
							}),
						]),
					);
					return;
				}
				if (cancelRequested)
					expect(await outcome).toMatchObject({ status: "STOPPING" });
				else await expect(outcome).rejects.toThrow();
				expect(client.create).not.toHaveBeenCalled();
				expect(client.list).toHaveBeenCalled();
				const saved = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				expect(JSON.stringify(saved.stepLog)).toContain("aisaCreateDispatched");
				expect(saved.aisaFinalization).toBeNull();
				expect(saved.stopNotificationAt).toBeNull();
			} finally {
				vi.unstubAllEnvs();
			}
		});
		it.each([
			"accepted-start",
			"uncertain-start",
			"lost-create",
			"unlocated-create",
			"late-create",
			"late-start",
			"analysis-only",
		] as const)("requires affirmative provider facts for a cancellation with run-only %s evidence", async (mode) => {
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
			plan.bitmovin.accountId = f.accountId;
			await tenant.bitmovinAccount.create({
				data: {
					id: f.accountId,
					label: "fixture",
					encryptedApiKey: "local-only",
				},
			});
			const clean = initStepLog(compileLiveChannel(plan)),
				saved = structuredClone(clean);
			const create = saved.find((e) => e.kind === "CREATE_ENCODING"),
				start = saved.find((e) => e.kind === "START_LIVE_ENCODING");
			if (!create || !start) throw new Error("missing native steps");
			const wasStarted =
				mode === "accepted-start" ||
				mode === "uncertain-start" ||
				mode === "late-start";
			const late = mode === "late-start" || mode === "late-create";
			if (wasStarted) {
				const publicCreate = clean.find((e) => e.kind === "CREATE_ENCODING");
				if (!publicCreate) throw new Error("missing channel CREATE");
				for (const entry of [create, publicCreate]) {
					entry.status = "DONE";
					entry.resourceId = f.encodingId;
				}
				start.status = mode === "accepted-start" ? "DONE" : "RUNNING";
				start.startedAt = lease.toISOString();
				if (mode === "accepted-start") start.response = { started: true };
			} else if (mode !== "analysis-only") {
				create.status = "RUNNING";
				create.startedAt = lease.toISOString();
			}
			const primary = wasStarted ? f.encodingId : null;
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					plan,
					stepLog: JSON.parse(JSON.stringify(clean)),
					status: "STOPPING",
					bitmovinEncodingId: primary,
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					stepLog: JSON.parse(JSON.stringify(late ? clean : saved)),
					status: "STOPPING",
					cancelRequested: true,
					bitmovinEncodingId: primary,
					...(mode === "analysis-only" ? { aisaAnalysisId: randomUUID() } : {}),
				},
			});
			let stopped = false;
			f.sdk.getEncodingStatus = vi.fn(async () => ({
				status: stopped ? "CANCELED" : wasStarted ? "CREATED" : "RUNNING",
			}));
			f.sdk.stopLiveEncoding = vi.fn(async () => {
				stopped = true;
			});
			const recover = vi.fn((options: Parameters<typeof f.deps.makeSdk>[0]) => {
				expect(options.stamp?.adoptWindow?.()).toBe(true);
				expect(options.stamp?.allowCreate?.()).toBe(false);
				expect(options.stamp?.currentStep()).toBe(create.step);
				if (mode === "unlocated-create")
					throw new Error("Provider stamp not found");
				return Promise.resolve(f.encodingId);
			});
			f.deps.makeSdk = (options) => ({
				...f.sdk,
				createEncoding: () => recover(options),
			});
			if (late) {
				const publish = () =>
					tenant.liveChannelRun.update({
						where: { id: f.run.id },
						data: { stepLog: JSON.parse(JSON.stringify(saved)) },
					});
				// The journal arrives after first admission but before the final locked projection.
				if (mode === "late-start")
					f.sdk.getEncodingStatus = vi.fn(async () => {
						await publish();
						return { status: "CREATED" };
					});
				else
					f.deps.prisma = new Proxy(tenant, {
						get(client, key) {
							if (key !== "feederSession") return Reflect.get(client, key);
							return new Proxy(client.feederSession, {
								get(delegate, k) {
									if (k === "findMany")
										return async (
											...args: Parameters<typeof delegate.findMany>
										) => {
											await publish();
											return delegate.findMany(...args);
										};
									return Reflect.get(delegate, k);
								},
							});
						},
					});
			}
			const held =
				late || mode === "analysis-only" || mode === "unlocated-create";
			expect(
				await createLiveChannelProcessor(f.deps)({
					liveChannelId: f.channel.id,
					action: "provision",
					params: { cancelRunId: f.run.id },
				}),
			).toMatchObject({ status: held ? "STOPPING" : "STOPPED" });
			expect(recover).toHaveBeenCalledTimes(
				mode === "lost-create" || mode === "unlocated-create" ? 1 : 0,
			);
			expect(f.sdk.startLiveEncoding).not.toHaveBeenCalled();
			expect(vi.mocked(f.sdk.stopLiveEncoding).mock.calls).toEqual(
				held ? [] : [[f.encodingId]],
			);
			const run = await tenant.liveChannelRun.findUniqueOrThrow({
				where: { id: f.run.id },
			});
			expect(run.status).toBe(held ? "STOPPING" : "STOPPED");
			expect(run.stopNotificationAt === null).toBe(held);
			if (late) {
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: f.channel.id },
						})
					).provisionClaimedAt,
				).toBeNull();
				expect(run.stepLog).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: wasStarted ? "START_LIVE_ENCODING" : "CREATE_ENCODING",
							startedAt: lease.toISOString(),
						}),
					]),
				);
			}
			if (mode === "analysis-only") expect(run.aisaAnalysisId).not.toBeNull();
			if (mode === "unlocated-create")
				expect(run.stepLog).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "CREATE_ENCODING",
							startedAt: lease.toISOString(),
						}),
					]),
				);
		});
		it.each([
			"prepared",
			"post-denied",
			"post-throttled",
			"lookup-throttled",
			"post-uncertain",
			"wire-lost",
			"dns-before-send",
			"lookup-dns",
			"401-broken-body",
			"429-broken-body",
			"202-broken-body",
			"redirect-dns",
		] as const)("recovers the exact Live child send boundary (%s)", async (mode) => {
			const f = await dispatchFixture();
			await tenant.bitmovinAccount.create({
				data: { id: f.accountId, label: "Fixture", encryptedApiKey: "unused" },
			});
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			plan.bitmovin.accountId = f.accountId;
			const steps = initStepLog(compileLiveChannel(plan));
			const child = steps.find((step) => step.kind === "CREATE_STREAM");
			if (!child) throw new Error("missing stream");
			for (const step of steps) {
				if (step === child) continue;
				step.status = "DONE";
				if (step.kind.startsWith("CREATE_"))
					step.resourceId =
						step.kind === "CREATE_ENCODING" ? f.encodingId : randomUUID();
				if (step.kind === "START_LIVE_ENCODING")
					step.response = { started: true };
			}
			const verify = mode === "prepared";
			const refused = [
				"post-denied",
				"post-throttled",
				"dns-before-send",
				"401-broken-body",
				"429-broken-body",
			].includes(mode);
			if (verify) {
				child.status = "RUNNING";
				child.startedAt = lease.toISOString();
				child.childCreateDispatch = "PREPARING";
			}
			const stepLog = JSON.parse(JSON.stringify(steps));
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					status: "PROVISIONING",
					plan,
					stepLog,
					...(verify
						? {
								verificationKey: randomUUID(),
								verificationRequestSha256: "e".repeat(64),
								provisionClaimedAt: new Date(now.getTime() - 25 * 60_000),
							}
						: {}),
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "PROVISIONING", stepLog },
			});
			const observed: string[] = [];
			let recovering = false;
			const resultId = randomUUID();
			const stored = async () => {
				const row = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				return (row.stepLog as unknown as StepLogEntry[]).find(
					(step) => step.step === child.step,
				);
			};
			const transport = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async (input, init) => {
					const path = new URL(String(input)).pathname;
					if (!path.endsWith(`/encodings/${f.encodingId}/streams`))
						throw new Error("unexpected endpoint: " + path);
					const method = init?.method?.toUpperCase() ?? "GET";
					observed.push(method);
					const error = (status: number) =>
						Response.json(
							{ status: "ERROR", data: { message: "fixture refusal" } },
							{ status },
						);
					const dnsFailure = (hostname: string) =>
						new TypeError("fetch failed", {
							cause: Object.assign(new Error("temporary lookup failure"), {
								code: "EAI_AGAIN",
								syscall: "getaddrinfo",
								hostname,
							}),
						});
					if (method === "GET") {
						if (mode === "lookup-dns" && !recovering)
							throw dnsFailure(new URL(String(input)).hostname);
						if (mode === "post-uncertain" && !recovering) return error(401);
						if (mode === "lookup-throttled" && !recovering) return error(429);
						return Response.json({
							status: "SUCCESS",
							data: { result: { items: [], totalCount: 0 } },
						});
					}
					expect((await stored())?.childCreateDispatch).toBe("DISPATCHING");
					if (!recovering) {
						if (mode === "dns-before-send")
							throw dnsFailure(new URL(String(input)).hostname);
						if (mode === "lookup-dns")
							throw new TypeError("lost response after send");
						if (mode === "redirect-dns") {
							if (init?.redirect === "manual" || init?.redirect === "error")
								return new Response(null, {
									status: 307,
									headers: { location: "https://redirect.invalid/stream" },
								});
							throw dnsFailure("redirect.invalid");
						}
						if (mode.endsWith("-broken-body"))
							return new Response(
								new ReadableStream({
									start(controller) {
										controller.error(
											new Error("response body was interrupted"),
										);
									},
								}),
								{ status: Number.parseInt(mode, 10) },
							);
					}
					if (!recovering && mode === "post-denied") return error(401);
					if (!recovering && mode === "post-throttled") return error(429);
					if (!recovering && mode === "lookup-throttled")
						throw new TypeError("lost provider reply");
					if (!recovering && mode === "post-uncertain") return error(503);
					if (!recovering && mode === "wire-lost") {
						if (observed.filter((v) => v === "POST").length > 1)
							return error(401);
						throw new TypeError("lost provider reply");
					}
					return Response.json({
						status: "SUCCESS",
						data: { result: { id: resultId } },
					});
				});
			f.sdk.getEncodingStatus = vi.fn(async () => ({ status: "RUNNING" }));
			f.deps.makeSdk = (options) => ({
				...f.sdk,
				createStream: createBitmovinSdkOps(options, async () => {})
					.createStream,
			});
			const run = createLiveChannelProcessor(f.deps);
			const job = {
				action: "provision" as const,
				liveChannelId: f.channel.id,
				plannedLiveChannelRunId: f.run.id,
			};
			try {
				if (verify) await run(job);
				else {
					await expect(run(job)).rejects.toThrow();
					expect(observed.filter((v) => v === "POST")).toHaveLength(1);
					expect((await stored())?.childCreateDispatch).toBe(
						refused ? "PREPARING" : "DISPATCHING",
					);
					const enqueue = vi.fn(
						async (
							_job: import("@bitovp/core").LiveChannelJob,
							_id: string,
						) => {},
					);
					await tenant.liveSchedule.create({
						data: {
							action: "START",
							liveChannelId: f.channel.id,
							liveChannelRunId: f.run.id,
							fireAt: now,
						},
					});
					await createScheduleSweep({
						prisma: tenant,
						now: () => now,
						enqueue,
					})();
					const resumed = enqueue.mock.calls.find(
						([j]) => j.liveChannelId === f.channel.id,
					)?.[0];
					if (!resumed) throw new Error("expected bound START recovery");
					recovering = true;
					if (refused) await run(resumed);
					else
						await expect(run(resumed)).rejects.toThrow(
							/unresolved|ADOPTION_MISS/,
						);
				}
				expect(observed.filter((v) => v === "POST")).toHaveLength(
					refused ? 2 : 1,
				);
				if (verify || refused)
					expect((await stored())?.resourceId).toBe(resultId);
				else expect((await stored())?.resourceId).toBeUndefined();
			} finally {
				transport.mockRestore();
			}
		});
		it.each([
			false,
			true,
			"scheduled",
			"scheduled-rebuild",
			"scheduled-runtime",
			"scheduled-prefix",
			"scheduled-adopt",
			"scheduled-preparing",
			"scheduled-child-id",
			"scheduled-miss",
		] as const)("reads a run-only native CREATE before replay and preserves the existing primary (nullable run=%s)", async (nullable) => {
			const scheduled = typeof nullable === "string";
			const f = await dispatchFixture();
			await tenant.bitmovinAccount.create({
				data: {
					id: f.accountId,
					label: "fixture",
					encryptedApiKey: "local-only",
				},
			});
			const plan = JSON.parse(
				readFileSync(
					new URL(
						"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
						import.meta.url,
					),
					"utf8",
				),
			);
			plan.bitmovin.accountId = f.accountId;
			const entries = initStepLog(compileLiveChannel(plan));
			const creation = entries.find((e) => e.kind === "CREATE_ENCODING");
			if (!creation) throw new Error("missing compiled create");
			creation.status = "DONE";
			creation.resourceId = f.encodingId;
			const graph = entries.filter(
				(e) => e.kind === "CREATE_STREAM" || e.kind === "CREATE_MUXING_FMP4",
			);
			if (scheduled) {
				expect(graph.length).toBeGreaterThan(1);
				for (const step of entries) {
					if (step === creation || step.kind === "AWAIT_LIVE_RUNNING") continue;
					step.status = "DONE";
					if (step.kind.startsWith("CREATE_")) step.resourceId = randomUUID();
					if (step.kind === "START_LIVE_ENCODING")
						step.response = { started: true };
				}
			}
			const previousId = randomUUID();
			if (nullable === "scheduled-rebuild") {
				const from = entries.findIndex(
					(step) => step.kind === "CREATE_INPUT_RTMP",
				);
				expect(from).toBeGreaterThanOrEqual(0);
				for (const step of entries.slice(from)) step.attempt = 1;
			}
			const runtime: StepLogEntry = {
				step: "esam-media-point-1795564800000",
				kind: "ESAM_MEDIA_POINT",
				status: "DONE",
				refs: {},
				payload: {
					requestId: "existing-operation",
					configuration: { streamTimeoutMinutes: 5 },
				},
				finishedAt: now.toISOString(),
			};
			const secondRuntime = {
				...runtime,
				payload: {
					requestId: "concurrent-operation",
					configuration: { streamTimeoutMinutes: 15 },
				},
			};
			if (nullable === "scheduled-runtime")
				entries.push(runtime, secondRuntime);
			const childRecovery = [
				"scheduled-adopt",
				"scheduled-miss",
				"scheduled-child-id",
				"scheduled-preparing",
			].includes(String(nullable));
			const child = graph.find((entry) => entry.kind === "CREATE_STREAM");
			if (!child) throw new Error("missing compiled stream");
			const providerStreamId = child.resourceId;
			if (childRecovery) {
				child.status = "RUNNING";
				child.startedAt = lease.toISOString();
				if (nullable === "scheduled-child-id") {
					child.status = "FAILED";
					child.finishedAt = now.toISOString();
				} else {
					delete child.resourceId;
					if (nullable === "scheduled-preparing")
						child.childCreateDispatch = "PREPARING";
				}
			}
			const omitted =
				nullable === "scheduled-prefix"
					? graph.find((step) => step.kind === "CREATE_MUXING_FMP4")
					: undefined;
			if (omitted) entries.splice(entries.indexOf(omitted), 1);

			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					plan,
					stepLog:
						nullable === true
							? JSON.parse(
									JSON.stringify(initStepLog(compileLiveChannel(plan))),
								)
							: [],
					status: scheduled ? "ERROR" : "PROVISIONING",
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					...(nullable ? { bitmovinEncodingId: null } : {}),
					...(nullable === "scheduled-prefix" ? { seq: 2 } : {}),
					...(nullable === "scheduled-rebuild"
						? {
								archivedRtmpAttempt: 1,
								previousProviderEncodingIds: [previousId],
								rtmpRetirementEvidence: [
									{
										accountId: f.accountId,
										encodingId: previousId,
										disposition: "TERMINAL",
										providerStatus: "FINISHED",
										observedAt: now.toISOString(),
									},
								],
							}
						: {}),
					stepLog: JSON.parse(JSON.stringify(entries)),
					status: scheduled ? "ERROR" : "PROVISIONING",
				},
			});
			let job: import("@bitovp/core").LiveChannelJob = {
				liveChannelId: f.channel.id,
				action: "provision",
			};
			if (scheduled) {
				await tenant.liveSchedule.create({
					data: {
						action: "START",
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						fireAt: now,
					},
				});
				const enqueue = vi.fn(
					async (
						_job: import("@bitovp/core").LiveChannelJob,
						_id: string,
					) => {},
				);
				await createScheduleSweep({
					prisma: tenant,
					now: () => now,
					enqueue,
				})();
				const own = enqueue.mock.calls.find(
					([value]) => value.liveChannelId === f.channel.id,
				);
				if (!own)
					throw new Error("Expected the bound scheduled revival to dispatch");
				job = own[0];
				const channel = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				});
				if (nullable === "scheduled-runtime") {
					expect(
						(channel.stepLog as unknown as StepLogEntry[]).filter(
							(e) => e.step === runtime.step,
						),
					).toEqual([runtime, secondRuntime]);
				}
				if (nullable === "scheduled-rebuild") {
					expect(
						(channel.stepLog as unknown as StepLogEntry[]).map(
							(e) => e.attempt ?? 0,
						),
					).toEqual(entries.map((e) => e.attempt ?? 0));
				}

				if (omitted) {
					const run = await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					});
					expect(run.outputPrefix).toBe("");
					expect(
						(channel.stepLog as unknown as StepLogEntry[]).find(
							(step) => step.step === omitted.step,
						)?.payload,
					).toEqual(omitted.payload);
					return;
				}
				for (const entry of graph) {
					if (childRecovery && entry === child) continue;
					expect(channel.stepLog).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								step: entry.step,
								status: "DONE",
								resourceId: entry.resourceId,
							}),
						]),
					);
				}
				expect(channel.stepLog).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "CREATE_ENCODING",
							status: "DONE",
							resourceId: f.encodingId,
						}),
					]),
				);
			}
			f.sdk.getEncodingStatus = vi.fn(async () => ({
				status: scheduled ? "RUNNING" : "CANCELED",
			}));
			const create = vi.fn(async () => {
				if (nullable === "scheduled-preparing") {
					const durable = await tenant.liveChannel.findUniqueOrThrow({
						where: { id: f.channel.id },
					});
					expect(
						(durable.stepLog as unknown as StepLogEntry[]).find(
							(step) => step.step === child.step,
						)?.childCreateDispatch,
					).toBe("DISPATCHING");
				}
				return providerStreamId ?? "created-stream";
			});
			const lookup = vi.fn(async () =>
				nullable === "scheduled-miss" || nullable === "scheduled-preparing"
					? undefined
					: providerStreamId,
			);
			if (childRecovery)
				f.deps.makeSdk = (options) => ({
					...f.sdk,
					createStream: async (encodingId) => {
						expect(encodingId).toBe(f.encodingId);
						return adoptOrCreateStamped({
							label: "stream",
							stamp: options.stamp,
							lookup,
							create,
							auditAdopt: async () => {},
						});
					},
				});
			const result = createLiveChannelProcessor(f.deps)(job);
			if (nullable === "scheduled-miss")
				await expect(result).rejects.toThrow("remains unresolved");
			else await result;
			if (nullable === "scheduled-preparing") {
				expect(create).toHaveBeenCalledOnce();
			} else if (nullable === "scheduled-child-id") {
				expect(create).not.toHaveBeenCalled();
				expect(lookup).not.toHaveBeenCalled();
			} else if (childRecovery) {
				expect(lookup).toHaveBeenCalledWith({
					job: f.channel.id,
					step: child.step,
				});
				expect(create).not.toHaveBeenCalled();
				const ch = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: f.channel.id },
				});
				const step = (ch.stepLog as unknown as StepLogEntry[]).find(
					(item) => item.step === child.step,
				);
				if (nullable === "scheduled-miss") {
					expect(step?.status).toBe("FAILED");
					expect(ch.status).toBe("ERROR");
					return;
				}
				expect(step?.resourceId).toBe(providerStreamId);
			}
			expect(f.sdk.getEncodingStatus).toHaveBeenCalledWith(f.encodingId);
			if (scheduled) {
				expect(f.sdk.createStream).not.toHaveBeenCalled();
				expect(f.sdk.createFmp4Muxing).not.toHaveBeenCalled();
			}
			expect(f.sdk.createEncoding).not.toHaveBeenCalled();
			if (nullable === "scheduled-runtime") {
				const run = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: f.run.id },
				});
				expect(
					(run.stepLog as unknown as StepLogEntry[]).filter(
						(e) => e.step === runtime.step,
					),
				).toEqual([runtime, secondRuntime]);
			}
			expect(
				(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: f.run.id },
					})
				).bitmovinEncodingId,
			).toBe(f.encodingId);
		});
		it.each([
			"run-log",
			"closed-claim",
		])("keeps a rebound %s encoder outstanding between recovery and queue handoff", async (source) => {
			const f = await dispatchFixture();
			const id = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPED", bitmovinEncodingId: null },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status: "STOPPED",
					bitmovinEncodingId: null,
					// A CREATED receipt on an ID never indexed by the rebuild writer was not valid before this recovery.
					rtmpRetirementEvidence: [
						{
							encodingId: id,
							accountId: f.accountId,
							observedAt: lease.toISOString(),
							providerStatus: "CREATED",
							disposition: "NEVER_STARTED",
						},
					],
					stepLog:
						source === "run-log"
							? [
									{
										step: "create",
										kind: "CREATE_ENCODING",
										status: "DONE",
										resourceId: id,
										payload: {},
										refs: {},
									},
								]
							: [],
				},
			});
			if (source === "closed-claim")
				await tenant.liveEffectClaim.create({
					data: {
						...f.identity,
						liveChannelId: f.channel.id,
						action: "SCTE35",
						state: "ACKED",
						providerEncodingId: id,
						generation: 0,
						ownerId: "fixture",
						idempotencyKey: randomUUID(),
						token: randomUUID(),
						expiresAt: lease,
					},
				});
			expect(await bindArchivedStopTarget(tenant, f.channel.id, f.run.id)).toBe(
				id,
			);
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(false);
			const job = {
				...f.job,
				effect: { ...f.job.effect, providerEncodingId: id },
			};
			expect(await createLiveChannelProcessor(f.deps)(job)).toMatchObject({
				status: "STOPPED",
			});
			expect(
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired,
			).toBe(true);
		});
		it("blocks a new airing until the orphaned claim has a terminal receipt on the current account", async () => {
			const f = await dispatchFixture(),
				orphan = randomUUID();
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: { status: "STOPPED" },
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: { status: "STOPPED" },
			});
			await tenant.liveEffectClaim.create({
				data: {
					...f.identity,
					liveChannelId: f.channel.id,
					liveChannelRunId: randomUUID(),
					state: "FAILED",
					providerEncodingId: orphan,
					generation: 0,
					ownerId: "legacy",
					idempotencyKey: randomUUID(),
					token: randomUUID(),
					expiresAt: lease,
				},
			});
			const canStart = async () =>
				(
					await tenant.$transaction((tx) =>
						readLockedLiveStartState(tx, f.channel.id),
					)
				).archivesRetired;
			for (const accountId of [randomUUID(), f.accountId]) {
				await tenant.liveChannel.update({
					where: { id: f.channel.id },
					data: {
						resetOrphanEncoderEvidence: [
							{
								accountId,
								encodingId: orphan,
								providerStatus: "FINISHED",
								disposition: "TERMINAL",
								observedAt: now.toISOString(),
							},
						],
					},
				});
				expect(await canStart()).toBe(accountId === f.accountId);
			}
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
			"scte",
			"restart-after-created",
		] as const)("recovers only the original unreserved STOP targets after process death (primary was reserved: %s)", async (primarySent) => {
			const f = await dispatchFixture(),
				secondary = randomUUID(),
				finished = randomUUID();
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					previousProviderEncodingIds:
						primarySent === "scte"
							? []
							: primarySent === "restart-after-created"
								? [secondary]
								: [secondary, finished],
					...(primarySent === "restart-after-created"
						? {
								rtmpRetirementEvidence: [
									{
										encodingId: secondary,
										accountId: f.accountId,
										disposition: "NEVER_STARTED",
										providerStatus: "CREATED",
										observedAt: lease.toISOString(),
									},
								],
							}
						: {}),
				},
			});
			if (primarySent === "scte" || primarySent === "restart-after-created")
				await tenant.liveEffectClaim.create({
					data: {
						...f.identity,
						liveChannelId: f.channel.id,
						providerEncodingId: secondary,
						action: primarySent === "scte" ? "SCTE35" : "RESTART",
						state: primarySent === "scte" ? "ACKED" : "AMBIGUOUS",
						generation: 0,
						token: randomUUID(),
						idempotencyKey: randomUUID(),
						ownerId: "fixture",
						expiresAt: lease,
					},
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
			"KEYLESS_RUN_LOG",
			"KEYLESS_CLAIM",
		] as const)("delivers a probe's %s teardown through the scheduler to the exact run and provider", async (initial) => {
			const f = await dispatchFixture();
			const missing = initial.startsWith("KEYLESS");
			const status = initial === "RUNNING" ? "RUNNING" : "STOPPING";
			await tenant.liveChannel.update({
				where: { id: f.channel.id },
				data: {
					purpose: "PROBE",
					status,
					...(missing ? { bitmovinEncodingId: null } : {}),
				},
			});
			await tenant.liveChannelRun.update({
				where: { id: f.run.id },
				data: {
					status,
					...(missing ? { bitmovinEncodingId: null } : {}),
					...(initial === "KEYLESS_RUN_LOG"
						? {
								stepLog: [
									{
										kind: "CREATE_ENCODING",
										step: "prior",
										status: "DONE",
										resourceId: f.encodingId,
										refs: {},
										payload: {},
									},
								],
							}
						: {}),
				},
			});
			if (initial === "KEYLESS_CLAIM")
				await tenant.liveEffectClaim.create({
					data: {
						liveChannelId: f.channel.id,
						liveChannelRunId: f.run.id,
						action: "RESTART",
						state: "FAILED",
						idempotencyKey: randomUUID(),
						generation: 0,
						token: randomUUID(),
						ownerId: "prior",
						providerEncodingId: f.encodingId,
						expiresAt: lease,
					},
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
			const handed = await tenant.liveSchedule.findUniqueOrThrow({
				where: { id: schedule.id },
			});
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
				scheduledStopJobId(handed.id, handed.stopDeliveryToken),
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
				data: {
					status: "STOPPING",
					legacyAdmissionFenceVersion: f.channel.liveEffectFenceVersion,
				},
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
				outcome: "UNKNOWN",
				outcomeEvidenceKind: "JOB_TERMINAL_UNKNOWN",
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
			if (legacy) await snapshotLegacyAdmissions();
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
