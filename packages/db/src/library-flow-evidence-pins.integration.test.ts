import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const sha = () => createHash("sha256").update(randomUUID()).digest("hex");

describe.runIf(Boolean(adminUrl && appUrl))(
	"dedicated PostgreSQL FLOW evidence retention",
	() => {
		const orgA = randomUUID(),
			orgB = randomUUID();
		let admin: AppPrismaClient, app: AppPrismaClient;
		let a: AppPrismaClient, b: AppPrismaClient;
		let first: Awaited<ReturnType<typeof fixture>>;
		let second: Awaited<ReturnType<typeof fixture>>;
		const rollback = new Error("owned fixture rollback");
		async function fixture(db: AppPrismaClient) {
			const credential = await db.credential.create({
				data: {
					label: "FLOW pin fixture",
					provider: "AWS_S3",
					encryptedSecret: "fixture",
				},
			});
			const source = await db.librarySource.create({
				data: {
					sourceKey: randomUUID(),
					originalJobId: randomUUID(),
					encodingId: randomUUID(),
					accountId: randomUUID(),
					snapshot: {},
					locales: ["ja"],
					state: "READY",
				},
			});
			const media = await db.libraryMediaVersion.create({
				data: {
					sourceId: source.id,
					credentialId: credential.id,
					outputCredentialId: credential.id,
					storage: { output: { credentialId: credential.id } },
				},
			});
			const task = await db.libraryMediaTask.create({
				data: {
					mediaVersionId: media.id,
					kind: "GENERATE",
					requestKey: randomUUID(),
					requestHash: sha(),
					cacheKey: sha(),
					parameters: {},
				},
			});
			const receipt = await db.libraryEvidenceReceipt.create({
				data: {
					sourceId: source.id,
					mediaVersionId: media.id,
					kind: "LOCAL_STORY_TRANSCRIPT_V1",
					proof: {},
					proofHash: sha(),
				},
			});
			return { source, media, task, receipt };
		}
		const insert = (db: AppPrismaClient, taskId: string, receiptId: string) =>
			db.$executeRaw`INSERT INTO "LibraryFlowEvidencePin" ("taskId","receiptId") VALUES (${taskId}::uuid,${receiptId}::uuid)`;
		beforeAll(async () => {
			// Pins have no DML release, including for the fixture administrator.
			// The owned integration database/container is discarded by the runner.
			for (const value of [adminUrl, appUrl]) {
				const url = new URL(value ?? "");
				expect(url.hostname).toBe("127.0.0.1");
				expect(url.pathname).toMatch(/^\/bitovp_integration_[a-f0-9]{32}$/);
			}
			expect(new URL(adminUrl ?? "").username).not.toBe(
				new URL(appUrl ?? "").username,
			);
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "FLOW pin fixture A", slug: orgA },
					{ id: orgB, name: "FLOW pin fixture B", slug: orgB },
				],
			});
			first = await fixture(a);
			second = await fixture(b);
		});
		afterAll(async () => {
			await admin?.$disconnect();
			await app?.$disconnect();
		});
		it("retains only the same-org task and receipt with an idempotent exact PK", async () => {
			expect(await insert(a, first.task.id, first.receipt.id)).toBe(1);
			expect(
				await a.libraryFlowEvidencePin.createMany({
					data: [{ taskId: first.task.id, receiptId: first.receipt.id }],
					skipDuplicates: true,
				}),
			).toEqual({ count: 0 });
			const rows = await a.$queryRaw<
				Array<Record<string, string>>
			>`SELECT * FROM "LibraryFlowEvidencePin"`;
			expect(rows).toEqual([
				{
					organizationId: orgA,
					taskId: first.task.id,
					receiptId: first.receipt.id,
				},
			]);
		});
		it("hides pins from another org and an ambient runtime connection", async () => {
			expect(await b.$queryRaw`SELECT * FROM "LibraryFlowEvidencePin"`).toEqual(
				[],
			);
			expect(
				await app.$queryRaw`SELECT * FROM "LibraryFlowEvidencePin"`,
			).toEqual([]);
		});
		it("rejects an explicit foreign organization even with its valid parents", async () => {
			await expect(
				a.$executeRaw`INSERT INTO "LibraryFlowEvidencePin" ("organizationId","taskId","receiptId") VALUES (${orgB}::uuid,${second.task.id}::uuid,${second.receipt.id}::uuid)`,
			).rejects.toThrow(/row-level security/);
		});
		it("rejects a task belonging to another org at commit", async () => {
			await expect(insert(a, second.task.id, first.receipt.id)).rejects.toThrow(
				/foreign key constraint/i,
			);
		});
		it("rejects a receipt belonging to another org at commit", async () => {
			await expect(insert(a, first.task.id, second.receipt.id)).rejects.toThrow(
				/foreign key constraint/i,
			);
		});
		it("rejects UPDATE including a no-op by the administrator", async () => {
			await expect(
				admin.$executeRaw`UPDATE "LibraryFlowEvidencePin" SET "receiptId"="receiptId" WHERE "organizationId"=${orgA}::uuid`,
			).rejects.toThrow(/immutable/);
		});
		it("rejects DELETE even by the administrator", async () => {
			await expect(
				admin.$executeRaw`DELETE FROM "LibraryFlowEvidencePin" WHERE "organizationId"=${orgA}::uuid`,
			).rejects.toThrow(/immutable/);
		});
		it("prevents deletion of a pinned receipt", async () => {
			await expect(
				a.libraryEvidenceReceipt.delete({ where: { id: first.receipt.id } }),
			).rejects.toThrow(/foreign key constraint/i);
			expect(
				await a.libraryEvidenceReceipt.findUnique({
					where: { id: first.receipt.id },
				}),
			).not.toBeNull();
		});
		it("prevents deletion of a pinned task", async () => {
			await expect(
				a.libraryMediaTask.delete({ where: { id: first.task.id } }),
			).rejects.toThrow(/foreign key constraint/i);
			expect(
				await a.libraryMediaTask.findUnique({ where: { id: first.task.id } }),
			).not.toBeNull();
		});
		it("cannot commit a pin after its receipt was removed in that transaction", async () => {
			const sample = await fixture(a);
			await expect(
				a.$transaction(async (tx) => {
					await tx.$executeRaw`INSERT INTO "LibraryFlowEvidencePin" ("taskId","receiptId") VALUES (${sample.task.id}::uuid,${sample.receipt.id}::uuid)`;
					await tx.libraryEvidenceReceipt.delete({
						where: { id: sample.receipt.id },
					});
				}),
			).rejects.toThrow(/foreign key constraint/i);
			expect(
				await a.libraryEvidenceReceipt.findUnique({
					where: { id: sample.receipt.id },
				}),
			).not.toBeNull();
		});
		it("blocks a concurrent delete while an accepted pin transaction holds the FK", async () => {
			const sample = await fixture(a);
			let release: () => void = () => {};
			let acquired: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				acquired = resolve;
			});
			const finish = new Promise<void>((resolve) => {
				release = resolve;
			});
			const writer = admin.$transaction(async (tx) => {
				await tx.$executeRaw`INSERT INTO "LibraryFlowEvidencePin" ("organizationId","taskId","receiptId") VALUES (${orgA}::uuid,${sample.task.id}::uuid,${sample.receipt.id}::uuid)`;
				await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
				acquired();
				await finish;
				throw rollback;
			});
			const writerResult = writer.catch((error) => error);
			try {
				await Promise.race([
					held,
					writerResult.then((error) => {
						throw error;
					}),
				]);
				await expect(
					admin.$transaction(async (tx) => {
						await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
						await tx.libraryEvidenceReceipt.delete({
							where: { id: sample.receipt.id },
						});
					}),
				).rejects.toThrow(/lock timeout/);
			} finally {
				release();
			}
			expect(await writerResult).toBe(rollback);
		});
		it("blocks pin acceptance while a concurrent receipt delete holds the row", async () => {
			const sample = await fixture(a);
			let release: () => void = () => {};
			let acquired: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				acquired = resolve;
			});
			const finish = new Promise<void>((resolve) => {
				release = resolve;
			});
			const deletion = admin.$transaction(async (tx) => {
				await tx.libraryEvidenceReceipt.delete({
					where: { id: sample.receipt.id },
				});
				acquired();
				await finish;
				throw rollback;
			});
			const deletionResult = deletion.catch((error) => error);
			try {
				await Promise.race([
					held,
					deletionResult.then((error) => {
						throw error;
					}),
				]);
				await expect(
					admin.$transaction(async (tx) => {
						await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '150ms'");
						await tx.$executeRaw`INSERT INTO "LibraryFlowEvidencePin" ("organizationId","taskId","receiptId") VALUES (${orgA}::uuid,${sample.task.id}::uuid,${sample.receipt.id}::uuid)`;
						await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
					}),
				).rejects.toThrow(/lock timeout/);
			} finally {
				release();
			}
			expect(await deletionResult).toBe(rollback);
			expect(await insert(a, sample.task.id, sample.receipt.id)).toBe(1);
		});
	},
);
