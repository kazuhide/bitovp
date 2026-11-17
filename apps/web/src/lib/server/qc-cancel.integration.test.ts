import { randomUUID } from "node:crypto";
import {
	type AppPrismaClient,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/vmaf-jobs/[id]/cancel/route";

const context = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/context", () => ({ getServerContext: context }));
vi.mock("@/lib/server/feature-flags", () => ({
	requireQcVmafEnabled: async () => null,
}));

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const cancelError =
	"Local measurement cancellation requested; cleanup continues";

describe.runIf(Boolean(adminUrl && runtimeUrl))(
	"LOCAL QC cancellation through the route and PostgreSQL",
	() => {
		const organizationId = randomUUID();
		const foreignOrganizationId = randomUUID();
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let competingRuntime: AppPrismaClient;
		let tenant: AppPrismaClient;
		let competitor: AppPrismaClient;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			runtime = createPrismaClient(runtimeUrl);
			competingRuntime = createPrismaClient(runtimeUrl);
			for (const id of [organizationId, foreignOrganizationId])
				await admin.organization.create({
					data: { id, name: "QC cancel integration", slug: id },
				});
			tenant = createTenantPrismaClient(runtime, organizationId);
			competitor = createTenantPrismaClient(competingRuntime, organizationId);
		});

		afterAll(async () => {
			try {
				if (admin) {
					const ids = [organizationId, foreignOrganizationId];
					await admin.vmafJob.deleteMany({
						where: { organizationId: { in: ids } },
					});
					await admin.organization.deleteMany({ where: { id: { in: ids } } });
				}
			} finally {
				await Promise.allSettled([
					admin?.$disconnect(),
					runtime?.$disconnect(),
					competingRuntime?.$disconnect(),
				]);
			}
		});

		function cancel(id: string) {
			return POST(
				new Request(`http://test/api/vmaf-jobs/${id}/cancel`, {
					method: "POST",
				}),
				{
					params: Promise.resolve({ id }),
				},
			);
		}

		async function seed(
			client: AppPrismaClient,
			params: Prisma.InputJsonObject,
		) {
			const job = await client.vmafJob.create({
				data: {
					mode: "VOD",
					status: "RUNNING",
					model: "vmaf_v0.6.1",
					params,
					doneUnits: 1,
					totalUnits: 2,
				},
			});
			const result = await client.vmafResult.create({
				data: {
					vmafJobId: job.id,
					renditionRef: { index: 0 },
					pooled: { mean: 91.25 },
					frames: [91.25],
				},
			});
			return { job, result };
		}

		it("preserves the committed completion when cancellation already read RUNNING", async () => {
			const { job, result } = await seed(tenant, {
				execution: { backend: "LOCAL" },
			});
			const where = { id: job.id };
			const gateVerdict = { outcome: "PASS" };
			// Complete on a separate runtime client after the real SELECT committed
			// and before the route gets its original row back. The route's update
			// uses the original delegate with its unmodified production predicate.
			context.mockResolvedValue({
				prisma: {
					vmafJob: {
						findUnique: async (args: Prisma.VmafJobFindUniqueArgs) => {
							const row = await tenant.vmafJob.findUnique(args);
							expect(row?.status).toBe("RUNNING");
							await competitor.vmafJob.update({
								where,
								data: { status: "FINISHED", doneUnits: 2, gateVerdict },
							});
							return row;
						},
						updateMany: (args: Prisma.VmafJobUpdateManyArgs) =>
							tenant.vmafJob.updateMany(args),
					},
				},
			});
			const response = await cancel(job.id);
			expect(response.status).toBe(200);
			const saved = await competitor.vmafJob.findUniqueOrThrow({
				where,
				include: { results: true },
			});
			expect(
				saved.status,
				"Cancellation overwrote a committed completion",
			).toBe("FINISHED");
			expect(await response.json()).toEqual({
				id: job.id,
				cancelRequested: false,
				stopped: false,
			});
			expect(saved).toMatchObject({
				doneUnits: 2,
				gateVerdict,
				error: null,
				params: job.params,
				results: [result],
			});
		});

		it("accepts legacy LOCAL cancellation once and keeps partial results on retry", async () => {
			const { job, result } = await seed(tenant, { sampleSeconds: 10 });
			context.mockResolvedValue({ prisma: tenant });
			for (const cancelRequested of [true, false]) {
				const response = await cancel(job.id);
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({
					id: job.id,
					cancelRequested,
					stopped: false,
				});
				expect(
					await competitor.vmafJob.findUniqueOrThrow({
						where: { id: job.id },
						include: { results: true },
					}),
				).toMatchObject({
					status: "ERROR",
					error: cancelError,
					params: job.params,
					doneUnits: 1,
					totalUnits: 2,
					results: [result],
				});
			}
			expect(
				await competitor.vmafJob.updateMany({
					where: { id: job.id, status: "RUNNING" },
					data: { status: "FINISHED" },
				}),
			).toEqual({ count: 0 });
		});

		it("hides a running foreign job from the tenant requesting cancellation", async () => {
			const foreign = createTenantPrismaClient(
				competingRuntime,
				foreignOrganizationId,
			);
			const { job } = await seed(foreign, { execution: { backend: "LOCAL" } });
			context.mockResolvedValue({ prisma: tenant });
			expect((await cancel(job.id)).status).toBe(404);
			expect(
				await foreign.vmafJob.findUniqueOrThrow({ where: { id: job.id } }),
			).toMatchObject({ status: "RUNNING", error: null });
		});
	},
);
