import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	createPrismaClient,
	createTenantPrismaClient,
	TENANT_ORGANIZATION,
} from "@bitovp/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { expect, it } from "vitest";
import { createTenantConsumer } from "./consumer";
import { tenantQueue } from "./queue";
import {
	contextualTenantPrisma,
	currentOrganizationId,
	runInOrganization,
} from "./scope";

it.skipIf(
	!process.env.TENANT_TEST_REDIS_URL || !process.env.TENANT_TEST_DB_FILE,
)(
	"real BullMQ admits own DB resources and blocks cross-tenant read/remove/dispatch",
	async () => {
		const redisUrl = process.env.TENANT_TEST_REDIS_URL ?? "";
		if (redisUrl !== "redis://127.0.0.1:16379")
			throw Error("Only the dedicated tenant test Redis is allowed");
		const config = JSON.parse(
			await readFile(process.env.TENANT_TEST_DB_FILE ?? "", "utf8"),
		) as { adminUrl: string; runtimeUrl: string };
		const admin = createPrismaClient(config.adminUrl),
			app = createPrismaClient(config.runtimeUrl);
		const orgA = randomUUID(),
			orgB = randomUUID();
		const a = createTenantPrismaClient(app, orgA),
			b = createTenantPrismaClient(app, orgB);
		const prisma = contextualTenantPrisma(
			(id) => (id === orgA ? a : b),
			TENANT_ORGANIZATION,
		);
		const name = `mt-isolation-${randomUUID()}`,
			connection = { url: redisUrl };
		const raw = new Queue(name, { connection }),
			events = new QueueEvents(name, { connection });
		const seen: { org: string | undefined; jobId: string }[] = [];
		const consume = createTenantConsumer({
			prisma,
			forEachOrganization: async () => {},
			isOrganizationActive: async (id) =>
				(
					await admin.organization.findUnique({
						where: { id },
						select: { active: true },
					})
				)?.active === true,
		});
		const worker = new Worker(
			name,
			consume("orchestrator", async (job) => {
				seen.push({
					org: currentOrganizationId(),
					jobId: job.data.encodingJobId,
				});
				return "owned-resource-only";
			}),
			{ connection, concurrency: 2 },
		);
		worker.on("error", () => {});
		try {
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Queue test A", slug: `queue-${orgA}` },
					{ id: orgB, name: "Queue test B", slug: `queue-${orgB}` },
				],
			});
			const rowA = await a.encodingJob.create({
					data: { name: "Queue A", plan: {}, status: "QUEUED" },
				}),
				rowB = await b.encodingJob.create({
					data: { name: "Queue B", plan: {}, status: "QUEUED" },
				});
			await events.waitUntilReady();
			await worker.waitUntilReady();
			const queue = tenantQueue(raw);
			const [jobA, jobB] = await Promise.all([
				runInOrganization(orgA, () =>
					queue.add("encode", { encodingJobId: rowA.id }, { jobId: rowA.id }),
				),
				runInOrganization(orgB, () =>
					queue.add("encode", { encodingJobId: rowB.id }, { jobId: rowB.id }),
				),
			]);
			expect(
				await Promise.all([
					jobA.waitUntilFinished(events, 5000),
					jobB.waitUntilFinished(events, 5000),
				]),
			).toEqual(["owned-resource-only", "owned-resource-only"]);
			expect(seen).toEqual(
				expect.arrayContaining([
					{ org: orgA, jobId: rowA.id },
					{ org: orgB, jobId: rowB.id },
				]),
			);
			expect(seen).toHaveLength(2);
			expect(
				await runInOrganization(orgB, () => queue.getJob(rowA.id)),
			).toBeUndefined();
			const owned = await runInOrganization(orgA, () => queue.getJob(rowA.id));
			expect(owned?.data).toEqual({ encodingJobId: rowA.id });
			expect(() => runInOrganization(orgB, () => owned?.remove())).toThrow(
				"Tenant queue job unavailable",
			);
			const forged = await raw.add(
				"encode",
				{ organizationId: orgB, payload: { encodingJobId: rowA.id } },
				{ jobId: `forged-${randomUUID()}` },
			);
			await expect(forged.waitUntilFinished(events, 5000)).rejects.toThrow(
				"Tenant resource unavailable",
			);
			expect(seen).toHaveLength(2);
			await runInOrganization(orgA, () => owned?.remove());
			expect(await raw.getJob(rowA.id)).toBeUndefined();
		} finally {
			await worker.close();
			await events.close();
			await raw.obliterate({ force: true });
			await raw.close();
			await admin.encodingJob.deleteMany({
				where: { organizationId: { in: [orgA, orgB] } },
			});
			await admin.organization.deleteMany({
				where: { id: { in: [orgA, orgB] } },
			});
			await app.$disconnect();
			await admin.$disconnect();
		}
	},
	20_000,
);
