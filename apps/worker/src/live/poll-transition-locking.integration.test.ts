import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeSdk } from "../orchestrator/fake-sdk";
import { createHeartbeatDoor } from "../orchestrator/run-mirror";
import {
	createProviderLifecycleReconciler,
	type RunLifecycleRow,
} from "./provider-lifecycle";

const runtimeUrl = process.env.BITOVP_MONITORING_TEST_DATABASE_URL;
const adminUrl = process.env.BITOVP_MONITORING_TEST_ADMIN_URL;
const kinds = ["heartbeat", "provider terminal"] as const;
type Kind = (typeof kinds)[number];

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}

async function backendPid(tx: AppTransactionClient) {
	const [row] = await tx.$queryRaw<{ pid: number }[]>`
		SELECT pg_backend_pid() AS pid`;
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
	throw new Error("Cancellation did not wait for the poll's run lock");
}

/** Decorate a real transaction without replacing its queries or row locks. */
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

describe.runIf(Boolean(runtimeUrl && adminUrl))(
	"real PostgreSQL poll and channel transition lock ordering",
	() => {
		const organizationIds: [string, string] = [randomUUID(), randomUUID()];
		const now = new Date("2026-10-19T00:00:00Z");
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let tenant: AppPrismaClient;
		let otherTenant: AppPrismaClient;

		beforeAll(async () => {
			for (const value of [runtimeUrl, adminUrl]) {
				if (
					!value ||
					!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
				) {
					throw new Error(
						"Poll lock tests require dedicated loopback PostgreSQL URLs",
					);
				}
			}
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			tenant = createTenantPrismaClient(runtime, organizationIds[0]);
			otherTenant = createTenantPrismaClient(runtime, organizationIds[1]);
			for (const id of organizationIds) {
				await admin.organization.create({
					data: { id, name: "Poll lock test", slug: `test-${id}` },
				});
			}
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

		async function fixture(client = tenant) {
			const encodingId = `test-${randomUUID()}`;
			const channel = await client.liveChannel.create({
				data: {
					name: "Poll transition lock test",
					status: "RUNNING",
					plan: {},
					bitmovinEncodingId: encodingId,
				},
			});
			const run = await client.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status: "RUNNING",
					bitmovinEncodingId: encodingId,
					outputPrefix: "",
					heartbeatPollEpoch: 7,
				},
			});
			return { channel, run, encodingId };
		}

		function poll(
			kind: Kind,
			client: AppPrismaClient,
			channelId: string,
			run: RunLifecycleRow,
			encodingId: string,
			epoch = 7,
		) {
			const emitChannel = vi.fn(async () => {});
			const enqueueFeederJob = vi.fn(async () => {});
			const result =
				kind === "heartbeat"
					? createHeartbeatDoor(client).recordHeartbeat(
							channelId,
							encodingId,
							now,
							{ at: now.toISOString(), raw: {} },
							{ runId: run.id, encodingId, epoch },
							{ raw: {}, deltas: {} },
						)
					: createProviderLifecycleReconciler({
							prisma: client,
							now: () => now.toISOString(),
							emitChannel,
							enqueueFeederJob,
						}).reconcile({
							channel: { id: channelId },
							run,
							encodingId,
							sdk: fakeSdk({
								getEncodingStatus: async () => ({ status: "FINISHED" }),
							}),
							fence: { epoch },
						});
			return { result, emitChannel, enqueueFeederJob };
		}

		function expectDiscarded(kind: Kind, result: unknown) {
			if (kind === "heartbeat") expect(result).toBe(false);
			else
				expect(result).toMatchObject({
					landed: false,
					terminalised: false,
					channelLanded: false,
				});
		}

		it.each(
			kinds,
		)("discards %s instead of deadlocking with cancel-start", async (kind) => {
			const { channel, run, encodingId } = await fixture();
			const cancelAtChannel = barrier();
			const releaseCancelRun = barrier();
			const pollAtRun = barrier();
			const releasePollChannel = barrier();
			let cancelPid = 0;
			let pollPid = 0;
			// Match Web cancel-start's channel CAS followed by its latest-run update.
			const cancelResult = Promise.allSettled([
				tenant.$transaction(
					async (tx) => {
						cancelPid = await backendPid(tx);
						const current = await tx.liveChannel.findUniqueOrThrow({
							where: { id: channel.id },
						});
						const latest = await tx.liveChannelRun.findFirst({
							where: { liveChannelId: channel.id },
							orderBy: { seq: "desc" },
						});
						if (latest?.id !== run.id)
							throw new Error("Test latest run changed");
						const claimed = await tx.liveChannel.updateMany({
							where: {
								id: channel.id,
								status: "RUNNING",
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
						return run.id;
					},
					{ maxWait: 5_000, timeout: 10_000 },
				),
			]);
			let pollResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await Promise.race([
					cancelAtChannel.ready,
					cancelResult.then((result) => {
						throw new Error("Cancellation settled before its channel barrier", {
							cause: result,
						});
					}),
				]);
				const client = instrumentTransactions(tenant, async (tx) => {
					pollPid = await backendPid(tx);
					return new Proxy(tx, {
						get(target, key) {
							if (key === "liveChannelRun")
								return new Proxy(target.liveChannelRun, {
									get(delegate, method) {
										if (method === "updateMany")
											return async (
												...args: Parameters<typeof delegate.updateMany>
											) => {
												const result = await delegate.updateMany(...args);
												pollAtRun.release();
												await releasePollChannel.ready;
												return result;
											};
										return Reflect.get(delegate, method);
									},
								});
							return Reflect.get(target, key);
						},
					});
				});
				const attempt = poll(kind, client, channel.id, run, encodingId);
				pollResult = Promise.allSettled([attempt.result]);
				await Promise.race([
					pollAtRun.ready,
					pollResult.then((result) => {
						throw new Error("Poll settled before its run barrier", {
							cause: result,
						});
					}),
				]);
				releaseCancelRun.release();
				await waitForBlockedBy(admin, cancelPid, pollPid);
				releasePollChannel.release();
				const [observed] = await pollResult;
				expect(observed?.status).toBe("fulfilled");
				if (observed?.status === "fulfilled")
					expectDiscarded(kind, observed.value);
				expect(await cancelResult).toEqual([
					{ status: "fulfilled", value: run.id },
				]);
				expect(
					await tenant.liveChannel.findUnique({
						where: { id: channel.id },
						select: { status: true, lastHeartbeat: true },
					}),
				).toEqual({ status: "STOPPING", lastHeartbeat: null });
				expect(
					await tenant.liveChannelRun.findUnique({
						where: { id: run.id },
						select: {
							status: true,
							cancelRequested: true,
							lastHeartbeatAt: true,
							providerTerminalAt: true,
							providerFeederStopsEnqueuedAt: true,
						},
					}),
				).toEqual({
					status: "STOPPING",
					cancelRequested: true,
					lastHeartbeatAt: null,
					providerTerminalAt: null,
					providerFeederStopsEnqueuedAt: null,
				});
				expect(
					await tenant.liveHeartbeat.count({
						where: { liveChannelId: channel.id },
					}),
				).toBe(0);
				expect(attempt.emitChannel).not.toHaveBeenCalled();
				expect(attempt.enqueueFeederJob).not.toHaveBeenCalled();
			} finally {
				releaseCancelRun.release();
				releasePollChannel.release();
				await pollResult;
				await cancelResult;
			}
		}, 15_000);

		it.each(
			kinds,
		)("keeps %s fenced to the current run, encoding and tenant while permitting a valid poll", async (kind) => {
			for (const stale of [
				"epoch",
				"channel",
				"encoding",
				"latest run",
				"tenant",
				"foreign channel",
			] as const) {
				const { channel, run, encodingId } = await fixture();
				let channelId = channel.id;
				if (stale === "channel") channelId = (await fixture()).channel.id;
				if (stale === "encoding") {
					await tenant.liveChannel.update({
						where: { id: channel.id },
						data: { bitmovinEncodingId: `new-${encodingId}` },
					});
				}
				if (stale === "latest run") {
					await tenant.liveChannelRun.update({
						where: { id: run.id },
						data: { status: "ERROR", error: "Previous airing failed" },
					});
					await tenant.liveChannelRun.create({
						data: {
							liveChannelId: channel.id,
							seq: 2,
							status: "RUNNING",
							bitmovinEncodingId: `new-${encodingId}`,
							outputPrefix: "",
						},
					});
				}
				if (stale === "foreign channel") {
					const foreign = await fixture(otherTenant);
					await tenant.liveChannel.update({
						where: { id: channel.id },
						data: { bitmovinEncodingId: `new-${encodingId}` },
					});
					await otherTenant.liveChannel.update({
						where: { id: foreign.channel.id },
						data: { bitmovinEncodingId: encodingId },
					});
					channelId = foreign.channel.id;
				}
				const before = await tenant.liveChannelRun.findUniqueOrThrow({
					where: { id: run.id },
				});
				const beforeChannel = await tenant.liveChannel.findUniqueOrThrow({
					where: { id: channel.id },
				});
				const attempt = poll(
					kind,
					stale === "tenant" ? otherTenant : tenant,
					channelId,
					before,
					encodingId,
					stale === "epoch" ? 6 : 7,
				);
				expectDiscarded(kind, await attempt.result);
				expect(
					await tenant.liveChannelRun.findUniqueOrThrow({
						where: { id: run.id },
					}),
				).toEqual(before);
				expect(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: channel.id },
					}),
				).toEqual(beforeChannel);
				expect(
					await tenant.liveHeartbeat.count({
						where: { liveChannelId: channel.id },
					}),
				).toBe(0);
				expect(attempt.emitChannel).not.toHaveBeenCalled();
				expect(attempt.enqueueFeederJob).not.toHaveBeenCalled();
			}
			const { channel, run, encodingId } = await fixture();
			const attempt = poll(kind, tenant, channel.id, run, encodingId);
			if (kind === "heartbeat") {
				expect(await attempt.result).toBe(true);
				expect(
					(
						await tenant.liveChannelRun.findUniqueOrThrow({
							where: { id: run.id },
						})
					).lastHeartbeatAt,
				).toEqual(now);
				expect(
					await tenant.liveHeartbeat.count({
						where: { liveChannelId: channel.id },
					}),
				).toBe(1);
			} else {
				expect(await attempt.result).toMatchObject({
					landed: true,
					terminalised: true,
					channelLanded: true,
				});
				expect(
					(
						await tenant.liveChannel.findUniqueOrThrow({
							where: { id: channel.id },
						})
					).status,
				).toBe("STOPPED");
				expect(attempt.emitChannel).toHaveBeenCalledOnce();
			}
		});
	},
);
