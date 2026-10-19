import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
} from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const requestSha256 = "1".repeat(64);
const kinds = ["VOD_JOB", "LIVE_CHANNEL"] as const;
type ResourceKind = (typeof kinds)[number];

/** Both transactions must persist their candidate resource before claiming. */
function beforeReceiptBarrier() {
	let arrived = 0;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		async wait() {
			arrived += 1;
			if (arrived === 2) release();
			await ready;
		},
		// An earlier database failure must not leave the other attempt waiting.
		cancel: () => release(),
		arrivals: () => arrived,
	};
}

async function createResource(
	tx: AppTransactionClient,
	kind: ResourceKind,
	resourceId: string,
) {
	if (kind === "VOD_JOB") {
		await tx.encodingJob.create({
			data: { id: resourceId, name: "Create request candidate", plan: {} },
		});
		return;
	}
	await tx.liveChannel.create({
		data: { id: resourceId, name: "Create request candidate", plan: {} },
	});
	await tx.liveSchedule.createMany({
		data: [
			{
				liveChannelId: resourceId,
				action: "START",
				fireAt: new Date("2099-01-01T00:00:00Z"),
			},
			{
				liveChannelId: resourceId,
				action: "STOP",
				fireAt: new Date("2099-01-01T01:00:00Z"),
			},
		],
	});
}

async function resourceIds(
	client: AppPrismaClient,
	kind: ResourceKind,
	ids: string[],
) {
	const query = { where: { id: { in: ids } }, select: { id: true } };
	const rows =
		kind === "VOD_JOB"
			? await client.encodingJob.findMany(query)
			: await client.liveChannel.findMany(query);
	return rows.map((row) => row.id).sort();
}

async function createWithReceipt(
	client: AppPrismaClient,
	kind: ResourceKind,
	requestKey: string,
	resourceId = randomUUID(),
) {
	return client.$transaction(async (tx) => {
		await createResource(tx, kind, resourceId);
		await tx.createRequest.create({
			data: { kind, requestKey, requestSha256, resourceId },
		});
		return resourceId;
	});
}

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL create request atomicity and organization isolation",
	() => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let a: AppPrismaClient;
		let b: AppPrismaClient;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			const roles = await app.$queryRaw<
				{ rolsuper: boolean; rolbypassrls: boolean }[]
			>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
			expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Create request A", slug: `test-${orgA}` },
					{ id: orgB, name: "Create request B", slug: `test-${orgB}` },
				],
			});
		});

		afterAll(async () => {
			try {
				if (admin) {
					const where = { organizationId: { in: [orgA, orgB] } };
					await admin.createRequest.deleteMany({ where });
					await admin.liveSchedule.deleteMany({ where });
					await admin.liveChannel.deleteMany({ where });
					await admin.encodingJob.deleteMany({ where });
					await admin.organization.deleteMany({
						where: { id: { in: [orgA, orgB] } },
					});
				}
			} finally {
				if (admin) await admin.$disconnect();
				if (app) await app.$disconnect();
			}
		});

		it.each(
			kinds,
		)("rolls back the losing %s resource and schedules when receipt inserts race", async (kind) => {
			const requestKey = randomUUID();
			const candidates = [randomUUID(), randomUUID()];
			const barrier = beforeReceiptBarrier();
			const attempt = async (resourceId: string) => {
				try {
					return await a.$transaction(
						async (tx) => {
							await createResource(tx, kind, resourceId);
							await barrier.wait();
							await tx.createRequest.create({
								data: { kind, requestKey, requestSha256, resourceId },
							});
							return resourceId;
						},
						{ maxWait: 10_000, timeout: 15_000 },
					);
				} catch (error) {
					barrier.cancel();
					throw error;
				}
			};
			const outcomes = await Promise.allSettled(candidates.map(attempt));
			const winners = outcomes.filter(
				(row): row is PromiseFulfilledResult<string> =>
					row.status === "fulfilled",
			);
			const losers = outcomes.filter(
				(row): row is PromiseRejectedResult => row.status === "rejected",
			);
			expect(barrier.arrivals()).toBe(2);
			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);
			// Prisma can omit constraint metadata for runtime-role conflicts.
			// Receipt recovery must identify its insertion, not rely on target.
			expect(losers[0]?.reason).toMatchObject({
				code: "P2002",
				meta: { modelName: "CreateRequest", target: null },
			});
			const winnerId = winners[0]?.value;
			expect(winnerId).toBeDefined();
			expect(await resourceIds(a, kind, candidates)).toEqual([winnerId]);
			expect(
				await a.createRequest.findMany({ where: { kind, requestKey } }),
			).toMatchObject([
				{
					organizationId: orgA,
					kind,
					requestKey,
					requestSha256,
					resourceId: winnerId,
				},
			]);
			if (kind === "LIVE_CHANNEL") {
				const schedules = await a.liveSchedule.findMany({
					where: { liveChannelId: { in: candidates } },
					select: { liveChannelId: true, action: true },
					orderBy: { action: "asc" },
				});
				expect(schedules).toEqual([
					{ liveChannelId: winnerId, action: "START" },
					{ liveChannelId: winnerId, action: "STOP" },
				]);
			}
		}, 20_000);

		it("allows the same key in two organizations without exposing either receipt across scopes", async () => {
			const requestKey = randomUUID();
			const resourceA = await createWithReceipt(a, "VOD_JOB", requestKey);
			const resourceB = await createWithReceipt(b, "VOD_JOB", requestKey);
			expect(resourceA).not.toBe(resourceB);
			expect(
				await a.createRequest.findMany({ where: { requestKey } }),
			).toMatchObject([{ organizationId: orgA, resourceId: resourceA }]);
			expect(
				await b.createRequest.findMany({ where: { requestKey } }),
			).toMatchObject([{ organizationId: orgB, resourceId: resourceB }]);
			expect(
				await a.createRequest.findFirst({ where: { resourceId: resourceB } }),
			).toBeNull();
			expect(
				await app.createRequest.findMany({ where: { requestKey } }),
			).toEqual([]);
			expect(
				await app.$queryRaw`SELECT "resourceId" FROM "CreateRequest" WHERE "requestKey" = ${requestKey}`,
			).toEqual([]);
			expect(
				await admin.createRequest.count({
					where: { requestKey, organizationId: { in: [orgA, orgB] } },
				}),
			).toBe(2);
		});

		it("keeps VOD and Live request keys independent within one organization", async () => {
			const requestKey = randomUUID();
			const vodId = await createWithReceipt(a, "VOD_JOB", requestKey);
			const liveId = await createWithReceipt(a, "LIVE_CHANNEL", requestKey);
			const receipts = await a.createRequest.findMany({
				where: { requestKey },
				select: { kind: true, resourceId: true },
				orderBy: { kind: "asc" },
			});
			expect(receipts).toEqual([
				{ kind: "LIVE_CHANNEL", resourceId: liveId },
				{ kind: "VOD_JOB", resourceId: vodId },
			]);
		});

		it("rejects cross-organization ownership at insertion and reassignment", async () => {
			const requestKey = randomUUID();
			const resourceId = await createWithReceipt(a, "VOD_JOB", requestKey);
			await expect(
				a.createRequest.create({
					data: {
						organizationId: orgB,
						kind: "VOD_JOB",
						requestKey: randomUUID(),
						requestSha256,
						resourceId: randomUUID(),
					},
				}),
			).rejects.toThrow();
			await expect(
				a.createRequest.updateMany({
					where: { kind: "VOD_JOB", requestKey },
					data: { organizationId: orgB },
				}),
			).rejects.toThrow();
			expect(
				await a.createRequest.findFirst({ where: { requestKey } }),
			).toMatchObject({ organizationId: orgA, resourceId });
			expect(await b.createRequest.findMany({ where: { requestKey } })).toEqual(
				[],
			);
		});

		it.each(
			kinds,
		)("retains the %s receipt after deletion and refuses recreation with that key", async (kind) => {
			const requestKey = randomUUID();
			const resourceId = await createWithReceipt(a, kind, requestKey);
			if (kind === "VOD_JOB") {
				await a.encodingJob.delete({ where: { id: resourceId } });
			} else {
				await a.liveChannel.delete({ where: { id: resourceId } });
			}
			expect(await resourceIds(a, kind, [resourceId])).toEqual([]);
			expect(
				await a.createRequest.findFirst({ where: { kind, requestKey } }),
			).toMatchObject({ organizationId: orgA, resourceId, requestSha256 });
			const replacementId = randomUUID();
			await expect(
				createWithReceipt(a, kind, requestKey, replacementId),
			).rejects.toMatchObject({ code: "P2002" });
			expect(await resourceIds(a, kind, [replacementId])).toEqual([]);
			if (kind === "LIVE_CHANNEL") {
				expect(
					await a.liveSchedule.count({
						where: { liveChannelId: { in: [resourceId, replacementId] } },
					}),
				).toBe(0);
			}
		});
	},
);
