import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AesGcmCipher } from "@bitovp/core";
import {
	type AppPrismaClient,
	type AppTransactionClient,
	createPrismaClient,
	createTenantPrismaClient,
	type Prisma,
} from "@bitovp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requiredResetCategories } from "@/lib/reset-selection";
import type { ServerContext } from "./context";
import { deleteEncodingJobLocally } from "./delete-jobs";
import { deleteOperationalData } from "./reset";
import { countResetCategories, deleteSelectedData } from "./selected-reset";

const state = vi.hoisted(() => ({ context: null as ServerContext | null }));
vi.mock("./context", () => ({
	getServerContext: async () => {
		if (!state.context) throw new Error("Fixture context is not initialized");
		return state.context;
	},
}));
vi.mock("server-only", () => ({}));

import { POST as reset } from "@/app/api/admin/reset/route";
import { DELETE } from "@/app/api/encoding-jobs/[id]/route";
import { POST as bulkDelete } from "@/app/api/encoding-jobs/bulk-delete/route";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const code = "JOB_LIBRARY_EVIDENCE_REFERENCES";
const cipher = new AesGcmCipher(randomBytes(32));
function barrier() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { ready, release };
}
function waitForStart(
	ready: Promise<void>,
	completion: Promise<unknown>,
	label: string,
) {
	return Promise.race([
		ready,
		completion.then((result) => {
			throw new Error(`${label} finished before reaching the lock barrier`, {
				cause: result,
			});
		}),
	]);
}
function instrument(
	base: AppPrismaClient,
	open: (tx: AppTransactionClient) => Promise<void>,
	beforeCommit?: () => Promise<void>,
) {
	return new Proxy(base, {
		get(target, key) {
			if (key === "$transaction")
				return <T>(
					fn: (tx: AppTransactionClient) => Promise<T>,
					options?: {
						isolationLevel?: Prisma.TransactionIsolationLevel;
						timeout?: number;
						maxWait?: number;
					},
				) =>
					target.$transaction(async (tx) => {
						await open(tx);
						const value = await fn(tx);
						await beforeCommit?.();
						return value;
					}, options);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
function request(path: string, method = "POST", value?: unknown) {
	return new Request(`https://local.test${path}`, {
		method,
		headers: {
			"x-bitovp-actor": "session",
			"Content-Type": "application/json",
		},
		...(value === undefined ? {} : { body: JSON.stringify(value) }),
	});
}
function context(prisma: AppPrismaClient, organizationId: string) {
	return {
		prisma,
		cipher,
		tenant: { organizationId },
	} as unknown as ServerContext;
}

describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL job evidence retention",
	() => {
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		const organizations: string[] = [];
		beforeAll(() => {
			for (const value of [adminUrl, appUrl]) {
				if (
					!value ||
					!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
				) {
					throw new Error(
						"Job retention tests require dedicated loopback PostgreSQL URLs",
					);
				}
			}
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
		});
		afterAll(async () => {
			try {
				if (!admin) return;
				for (const organizationId of organizations) {
					const where = { organizationId };
					await admin.libraryEvidenceReceipt.deleteMany({ where });
					await admin.vmafJob.deleteMany({ where });
					await admin.encodingJob.deleteMany({ where });
					await admin.auditLog.deleteMany({ where });
					await admin.resetCleanupTask.deleteMany({ where });
					await admin.organization.delete({ where: { id: organizationId } });
				}
			} finally {
				state.context = null;
				await app?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function fixture(retained = true) {
			const organizationId = randomUUID();
			organizations.push(organizationId);
			await admin.organization.create({
				data: {
					id: organizationId,
					slug: organizationId,
					name: "Job evidence retention fixture",
				},
			});
			const prisma = createTenantPrismaClient(app, organizationId);
			const job = await prisma.encodingJob.create({
				data: { name: "Retained source", status: "FINISHED", plan: {} },
			});
			const child = await prisma.vmafJob.create({
				data: {
					encodingJobId: job.id,
					mode: "VOD",
					model: "fixture",
					status: "FINISHED",
				},
			});
			const ctx = context(prisma, organizationId);
			if (retained) await receipt(prisma, job.id);
			return { organizationId, prisma, job, child, ctx };
		}
		async function receipt(
			prisma: AppPrismaClient | AppTransactionClient,
			jobId: string,
		) {
			const proof = {
				schemaVersion: 1,
				fixture: "job-retention",
				jobId,
				identity: randomUUID(),
			};
			return prisma.libraryEvidenceReceipt.create({
				data: {
					kind: "INPUT_CAPTURE",
					jobId,
					encodingId: randomUUID(),
					proof,
					proofHash: createHash("sha256")
						.update(JSON.stringify(proof))
						.digest("hex"),
				},
			});
		}
		async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
			expect(
				await f.prisma.encodingJob.findUnique({ where: { id: f.job.id } }),
			).not.toBeNull();
			expect(
				await f.prisma.vmafJob.findUnique({ where: { id: f.child.id } }),
			).not.toBeNull();
			expect(
				await f.prisma.libraryEvidenceReceipt.count({
					where: { jobId: f.job.id },
				}),
			).toBe(1);
			expect(await f.prisma.resetCleanupTask.count()).toBe(0);
		}
		async function waitForLock(pid: number) {
			expect(pid).toBeGreaterThan(0);
			for (let i = 0; i < 100; i++) {
				const rows = await admin.$queryRaw<
					{ waiting: boolean }[]
				>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock') AS waiting`;
				if (rows[0]?.waiting) return;
				await delay(20);
			}
			throw new Error(
				"Expected the actual PostgreSQL backend to wait on a row/FK lock",
			);
		}

		it("retains the actual receipt FK, immutable receipt and terminal job dependents", async () => {
			const f = await fixture();
			const before = await f.prisma.libraryEvidenceReceipt.findFirstOrThrow({
				where: { jobId: f.job.id },
			});
			expect(
				await deleteEncodingJobLocally(f.ctx, f.job.id, {
					req: request(`/api/encoding-jobs/${f.job.id}`, "DELETE"),
				}),
			).toMatchObject({ ok: false, code, protectedCount: 1 });
			await preserved(f);
			await expect(
				f.prisma.libraryEvidenceReceipt.update({
					where: { id: before.id },
					data: { proof: { changed: true } },
				}),
			).rejects.toThrow();
			expect(
				await f.prisma.libraryEvidenceReceipt.findUnique({
					where: { id: before.id },
				}),
			).toEqual(before);
			await expect(
				f.prisma.encodingJob.delete({ where: { id: f.job.id } }),
			).rejects.toMatchObject({ code: "P2003" });
			expect(await f.prisma.auditLog.count()).toBe(0);
		});

		it("returns a safe 409 and protectedCount from the individual DELETE route", async () => {
			const f = await fixture();
			state.context = f.ctx;
			const response = await DELETE(
				request(`/api/encoding-jobs/${f.job.id}`, "DELETE"),
				{ params: Promise.resolve({ id: f.job.id }) },
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: expect.any(String),
				details: { code, protectedCount: 1 },
			});
			await preserved(f);
		});

		it("bulk delete skips retained evidence, deletes unreferenced jobs, and never reveals another tenant", async () => {
			const f = await fixture();
			const other = await fixture();
			state.context = f.ctx;
			const free = await f.prisma.encodingJob.create({
				data: { name: "Unreferenced", status: "ERROR", plan: {} },
			});
			const freeChild = await f.prisma.vmafJob.create({
				data: {
					encodingJobId: free.id,
					mode: "VOD",
					model: "fixture",
					status: "FINISHED",
				},
			});
			const response = await bulkDelete(
				request("/api/encoding-jobs/bulk-delete", "POST", {
					ids: [f.job.id, free.id, other.job.id],
				}),
			);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.deleted).toEqual([free.id]);
			expect(body.skipped).toEqual([
				{ id: f.job.id, reason: expect.any(String), code, protectedCount: 1 },
				{ id: other.job.id, reason: "Not found" },
			]);
			expect(
				await f.prisma.encodingJob.findUnique({ where: { id: free.id } }),
			).toBeNull();
			expect(
				await f.prisma.vmafJob.findUnique({ where: { id: freeChild.id } }),
			).toBeNull();
			await preserved(f);
			await preserved(other);
			const freeTenant = await fixture(false);
			expect(
				await deleteEncodingJobLocally(freeTenant.ctx, freeTenant.job.id, {
					req: request(`/api/encoding-jobs/${freeTenant.job.id}`, "DELETE"),
				}),
			).toMatchObject({ ok: true });
		});

		it("blocks vodJobs-only selected reset and exposes retention in its preview before cleanup handoff", async () => {
			const f = await fixture();
			state.context = f.ctx;
			const categories = requiredResetCategories(["vodJobs"]);
			expect(await countResetCategories(f.prisma)).toContainEqual({
				category: "vodJobs",
				count: 1,
				protectedCount: 1,
			});
			await expect(
				deleteSelectedData(f.prisma, categories, cipher),
			).rejects.toMatchObject({ code, protectedCount: 1 });
			const response = await reset(
				request("/api/admin/reset", "POST", { confirm: "RESET", categories }),
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				details: { code, protectedCount: 1 },
			});
			await preserved(f);
			expect(await f.prisma.auditLog.count()).toBe(0);
		});

		it("blocks legacy operational reset before any child deletion with the same safe 409", async () => {
			const f = await fixture();
			state.context = f.ctx;
			await expect(deleteOperationalData(f.prisma)).rejects.toMatchObject({
				code,
				protectedCount: 1,
			});
			const response = await reset(
				request("/api/admin/reset", "POST", { confirm: "RESET" }),
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				details: { code, protectedCount: 1 },
			});
			await preserved(f);
			expect(await f.prisma.auditLog.count()).toBe(0);
		});

		it("waits for a committing receipt and rechecks retention under the actual job row lock", async () => {
			const f = await fixture(false);
			const inserted = barrier();
			const releaseWriter = barrier();
			const deletionStarted = barrier();
			let deletePid = 0;
			const writer = Promise.allSettled([
				f.prisma.$transaction(async (tx) => {
					await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${f.job.id}::uuid FOR KEY SHARE`;
					await receipt(tx, f.job.id);
					inserted.release();
					await releaseWriter.ready;
				}),
			]);
			let deletion:
				| Promise<Awaited<ReturnType<typeof deleteEncodingJobLocally>>>
				| undefined;
			try {
				await waitForStart(inserted.ready, writer, "Receipt writer");
				const prisma = instrument(f.prisma, async (tx) => {
					deletePid =
						(
							await tx.$queryRaw<
								{ pid: number }[]
							>`SELECT pg_backend_pid() AS pid`
						)[0]?.pid ?? 0;
					deletionStarted.release();
				});
				deletion = deleteEncodingJobLocally(
					context(prisma, f.organizationId),
					f.job.id,
					{ req: request(`/api/encoding-jobs/${f.job.id}`, "DELETE") },
				);
				await waitForStart(
					deletionStarted.ready,
					deletion,
					"Deletion transaction",
				);
				await waitForLock(deletePid);
				releaseWriter.release();
				expect((await writer)[0]?.status).toBe("fulfilled");
				expect(await deletion).toMatchObject({
					ok: false,
					code,
					protectedCount: 1,
				});
				await preserved(f);
			} finally {
				releaseWriter.release();
				await writer;
				await deletion?.catch(() => {});
			}
		});

		it("holds the job deletion through commit so a later receipt cannot create a dangling FK", async () => {
			const f = await fixture(false);
			const deleted = barrier();
			const releaseDelete = barrier();
			const writerStarted = barrier();
			let writerPid = 0;
			const prisma = instrument(
				f.prisma,
				async () => {},
				async () => {
					deleted.release();
					await releaseDelete.ready;
				},
			);
			const deletion = deleteEncodingJobLocally(
				context(prisma, f.organizationId),
				f.job.id,
				{ req: request(`/api/encoding-jobs/${f.job.id}`, "DELETE") },
			);
			let writer: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await waitForStart(deleted.ready, deletion, "Deletion transaction");
				writer = Promise.allSettled([
					f.prisma.$transaction(async (tx) => {
						writerPid =
							(
								await tx.$queryRaw<
									{ pid: number }[]
								>`SELECT pg_backend_pid() AS pid`
							)[0]?.pid ?? 0;
						await receipt(tx, f.job.id);
						writerStarted.release();
						// Returning starts the real deferred-FK COMMIT. Tenant SQL
						// deliberately forbids changing constraints with SET.
					}),
				]);
				await waitForStart(writerStarted.ready, writer, "Late receipt writer");
				await waitForLock(writerPid);
				releaseDelete.release();
				expect(await deletion).toMatchObject({ ok: true });
				const outcome = (await writer)[0];
				expect(outcome?.status).toBe("rejected");
				if (outcome?.status === "rejected")
					expect(outcome.reason).toMatchObject({
						code: "P2003",
					});
				expect(
					await f.prisma.encodingJob.findUnique({ where: { id: f.job.id } }),
				).toBeNull();
				expect(
					await f.prisma.vmafJob.findUnique({ where: { id: f.child.id } }),
				).toBeNull();
				expect(
					await f.prisma.libraryEvidenceReceipt.count({
						where: { jobId: f.job.id },
					}),
				).toBe(0);
			} finally {
				releaseDelete.release();
				await deletion.catch(() => {});
				await writer;
			}
		});
	},
);
