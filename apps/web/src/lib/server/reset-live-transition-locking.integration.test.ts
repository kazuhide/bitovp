import { randomBytes, randomUUID } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
	readResetCleanupTask,
} from "@bitovp/db";
import { expect, it, vi } from "vitest";
import { requiredResetCategories } from "@/lib/reset-selection";
import { createProviderLifecycleReconciler } from "../../../../worker/src/live/provider-lifecycle";
import { fakeSdk } from "../../../../worker/src/orchestrator/fake-sdk";
import { deleteOperationalData, ResetRaceLost } from "./reset";
import { deleteSelectedData } from "./selected-reset";

vi.mock("server-only", () => ({}));

const runtimeUrl = process.env.BITOVP_MONITORING_TEST_DATABASE_URL;
const adminUrl = process.env.BITOVP_MONITORING_TEST_ADMIN_URL;
function clients() {
	for (const value of [runtimeUrl, adminUrl]) {
		if (
			!value ||
			!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
		)
			throw new Error(
				"Reset lock tests require dedicated loopback PostgreSQL URLs",
			);
	}
	return {
		admin: createPrismaClient(adminUrl),
		runtime: createPrismaClient(runtimeUrl),
	};
}

function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((r) => {
		release = r;
	});
	return { ready, release };
}
function instrument(
	base: AppPrismaClient,
	decorate: (tx: AppTransactionClient) => Promise<AppTransactionClient>,
) {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return (
					fn: (tx: AppTransactionClient) => Promise<unknown>,
					options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
				) =>
					target.$transaction(async (tx) => fn(await decorate(tx)), {
						...options,
						timeout: 15_000,
					});
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

it
	.runIf(Boolean(runtimeUrl && adminUrl))
	.each(["operational", "selected"] as const)(
	"serializes actual %s reset deletion with a late terminal finalizer",
	async (kind) => {
		const { admin, runtime } = clients();
		const org = randomUUID();
		const tenant = createTenantPrismaClient(runtime, org);
		const encoding = `test-${randomUUID()}`;
		const deletedRun = barrier();
		const releaseReset = barrier();
		const started = barrier();
		let resetPid = 0;
		let ownerPid = 0;
		let resetAttempts = 0;
		const cipher = new AesGcmCipher(randomBytes(32));
		let reset: Promise<PromiseSettledResult<unknown>[]> | undefined;
		let owner: Promise<PromiseSettledResult<unknown>[]> | undefined;
		try {
			await admin.organization.create({
				data: { id: org, name: "Owned reset probe", slug: `test-${org}` },
			});
			const channel = await tenant.liveChannel.create({
				data: {
					name: "Owned reset probe",
					status: "ERROR",
					plan: {},
					bitmovinEncodingId: encoding,
					encoderStoppedConfirmedFor: encoding,
				},
			});
			const run = await tenant.liveChannelRun.create({
				data: {
					liveChannelId: channel.id,
					seq: 1,
					status: "ERROR",
					bitmovinEncodingId: encoding,
					encoderStoppedConfirmedFor: encoding,
					outputPrefix: "",
				},
			});
			const resetClient = instrument(tenant, async (tx) => {
				resetAttempts++;
				resetPid =
					(
						await tx.$queryRaw<
							{ pid: number }[]
						>`SELECT pg_backend_pid() AS pid`
					)[0]?.pid ?? 0;
				return new Proxy(tx, {
					get(target, key) {
						if (key === "liveChannelRun")
							return new Proxy(target.liveChannelRun, {
								get(delegate, method) {
									if (method === "deleteMany")
										return async (
											...args: Parameters<typeof delegate.deleteMany>
										) => {
											const result = await delegate.deleteMany(...args);
											deletedRun.release();
											await releaseReset.ready;
											return result;
										};
									return Reflect.get(delegate, method);
								},
							});
						return Reflect.get(target, key);
					},
				});
			});
			reset = Promise.allSettled([
				kind === "operational"
					? deleteOperationalData(resetClient)
					: deleteSelectedData(
							resetClient,
							requiredResetCategories(["liveChannels"]),
							cipher,
						),
			]);
			await Promise.race([
				deletedRun.ready,
				reset.then((result) => {
					throw new Error("Reset did not pass its real idle/proof guards", {
						cause: result,
					});
				}),
			]);
			const ownerClient = instrument(tenant, async (tx) => {
				ownerPid =
					(
						await tx.$queryRaw<
							{ pid: number }[]
						>`SELECT pg_backend_pid() AS pid`
					)[0]?.pid ?? 0;
				started.release();
				return tx;
			});
			owner = Promise.allSettled([
				createProviderLifecycleReconciler({
					prisma: ownerClient,
					now: () => new Date().toISOString(),
					emitChannel: async () => {},
					enqueueFeederJob: async () => {},
				}).reconcile({
					channel,
					run,
					encodingId: encoding,
					sdk: fakeSdk(),
					observation: {
						ok: true,
						status: "ERROR",
						observedAt: new Date().toISOString(),
					},
				}),
			]);
			await started.ready;
			const until = Date.now() + 5_000;
			let blocked = false;
			while (Date.now() < until) {
				blocked =
					(
						await admin.$queryRaw<
							{ blocked: boolean }[]
						>`SELECT ${resetPid}::integer = ANY(pg_blocking_pids(${ownerPid}::integer)) AS blocked`
					)[0]?.blocked ?? false;
				if (blocked) break;
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(blocked).toBe(true);
			releaseReset.release();
			expect((await reset)[0]?.status).toBe("fulfilled");
			expect((await owner)[0]?.status).toBe("fulfilled");
			expect(resetAttempts).toBe(1);
			if (kind === "selected") {
				const receipts = await tenant.resetCleanupTask.findMany();
				expect(receipts).toHaveLength(1);
				const receipt = receipts[0];
				if (!receipt) throw new Error("Missing cleanup receipt");
				const saved = await readResetCleanupTask(tenant, cipher, receipt.id);
				expect(saved?.payload.encodings).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							entityKey: `liveChannel:${channel.id}`,
							encodingId: encoding,
						}),
						expect.objectContaining({
							entityKey: `liveChannelRun:${run.id}`,
							encodingId: encoding,
						}),
					]),
				);
			}
		} finally {
			releaseReset.release();
			await reset;
			await owner;
			await admin.liveChannel.deleteMany({ where: { organizationId: org } });
			await admin.resetCleanupTask.deleteMany({
				where: { organizationId: org },
			});
			await admin.organization.deleteMany({ where: { id: org } });
			await runtime.$disconnect();
			await admin.$disconnect();
		}
	},
	20_000,
);

it.runIf(Boolean(runtimeUrl && adminUrl))(
	"locks tenant-visible channels in ID order and revalidates admission and stop proof after the wait",
	async () => {
		const { admin, runtime } = clients();
		const organizationIds = [randomUUID(), randomUUID()];
		const tenant = createTenantPrismaClient(
			runtime,
			organizationIds[0] as string,
		);
		const foreignTenant = createTenantPrismaClient(
			runtime,
			organizationIds[1] as string,
		);
		const channelIds = [randomUUID(), randomUUID()].sort();
		const admissionAtChannel = barrier();
		const releaseAdmission = barrier();
		const resetStarted = barrier();
		let admissionPid = 0;
		let resetPid = 0;
		const lockedIds: string[] = [];
		let admission: Promise<PromiseSettledResult<unknown>[]> | undefined;
		let reset: Promise<PromiseSettledResult<unknown>[]> | undefined;
		try {
			for (const id of organizationIds)
				await admin.organization.create({
					data: { id, name: "Reset lock scope test", slug: `test-${id}` },
				});
			for (const id of channelIds) {
				const encoding = `test-${randomUUID()}`;
				await tenant.liveChannel.create({
					data: {
						id,
						name: "Reset lock scope test",
						status: "ERROR",
						plan: {},
						bitmovinEncodingId: encoding,
						encoderStoppedConfirmedFor: encoding,
					},
				});
				await tenant.liveChannelRun.create({
					data: {
						liveChannelId: id,
						seq: 1,
						status: "ERROR",
						bitmovinEncodingId: encoding,
						encoderStoppedConfirmedFor: encoding,
						outputPrefix: "",
					},
				});
			}
			const foreign = await foreignTenant.liveChannel.create({
				data: { name: "Foreign reset lock test", status: "ERROR", plan: {} },
			});
			admission = Promise.allSettled([
				tenant.$transaction(
					async (tx) => {
						admissionPid =
							(
								await tx.$queryRaw<
									{ pid: number }[]
								>`SELECT pg_backend_pid() AS pid`
							)[0]?.pid ?? 0;
						await tx.liveChannel.update({
							where: { id: channelIds[0] },
							data: { status: "RUNNING", encoderStoppedConfirmedFor: null },
						});
						admissionAtChannel.release();
						await releaseAdmission.ready;
					},
					{ timeout: 15_000 },
				),
			]);
			await admissionAtChannel.ready;
			const resetClient = instrument(tenant, async (tx) => {
				resetPid =
					(
						await tx.$queryRaw<
							{ pid: number }[]
						>`SELECT pg_backend_pid() AS pid`
					)[0]?.pid ?? 0;
				resetStarted.release();
				return new Proxy(tx, {
					get(target, key) {
						if (key === "$queryRaw")
							return async (
								sql: TemplateStringsArray,
								...values: unknown[]
							) => {
								const result = await target.$queryRaw(sql, ...values);
								if (sql.join("?").includes('FROM "LiveChannel" ORDER BY id'))
									lockedIds.push(
										...(result as { id: string }[]).map((row) => row.id),
									);
								return result;
							};
						return Reflect.get(target, key);
					},
				});
			});
			reset = Promise.allSettled([deleteOperationalData(resetClient)]);
			await resetStarted.ready;
			const until = Date.now() + 5_000;
			let blocked = false;
			while (Date.now() < until) {
				blocked =
					(
						await admin.$queryRaw<
							{ blocked: boolean }[]
						>`SELECT ${admissionPid}::integer = ANY(pg_blocking_pids(${resetPid}::integer)) AS blocked`
					)[0]?.blocked ?? false;
				if (blocked) break;
				await new Promise((r) => setTimeout(r, 5));
			}
			expect(blocked).toBe(true);
			releaseAdmission.release();
			expect((await admission)[0]?.status).toBe("fulfilled");
			const [outcome] = await reset;
			expect(outcome?.status).toBe("rejected");
			if (
				outcome?.status === "rejected" &&
				!(outcome.reason instanceof ResetRaceLost)
			) {
				expect(outcome.reason).toMatchObject({
					code: "P2010",
					meta: { code: "40001" },
				});
			}
			// A fresh Serializable attempt sees the winning admission under its
			// channel locks and rejects through the normal active-work guard.
			lockedIds.length = 0;
			await expect(deleteOperationalData(resetClient)).rejects.toBeInstanceOf(
				ResetRaceLost,
			);
			expect(lockedIds).toEqual(channelIds);
			expect(await tenant.liveChannel.count()).toBe(2);
			expect(await tenant.liveChannelRun.count()).toBe(2);
			expect(
				(
					await tenant.liveChannel.findUniqueOrThrow({
						where: { id: channelIds[0] },
					})
				).status,
			).toBe("RUNNING");
			expect(
				await foreignTenant.liveChannel.findUniqueOrThrow({
					where: { id: foreign.id },
				}),
			).toEqual(foreign);
		} finally {
			releaseAdmission.release();
			await admission;
			await reset;
			await admin.liveChannel.deleteMany({
				where: { organizationId: { in: organizationIds } },
			});
			await admin.organization.deleteMany({
				where: { id: { in: organizationIds } },
			});
			await runtime.$disconnect();
			await admin.$disconnect();
		}
	},
	20_000,
);
