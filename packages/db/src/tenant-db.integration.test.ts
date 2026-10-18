import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
describe.runIf(Boolean(adminUrl && appUrl))(
	"real PostgreSQL organization isolation",
	() => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		let admin: AppPrismaClient;
		let app: AppPrismaClient;
		let a: AppPrismaClient;
		let b: AppPrismaClient;
		let credentialA: string;
		let credentialB: string;

		beforeAll(async () => {
			admin = createPrismaClient(adminUrl);
			app = createPrismaClient(appUrl);
			a = createTenantPrismaClient(app, orgA);
			b = createTenantPrismaClient(app, orgB);
			await admin.organization.createMany({
				data: [
					{ id: orgA, name: "Test A", slug: `test-${orgA}` },
					{ id: orgB, name: "Test B", slug: `test-${orgB}` },
				],
			});
			credentialA = (
				await a.credential.create({
					data: {
						label: "A",
						provider: "AWS_S3",
						encryptedSecret: "encrypted-A",
					},
				})
			).id;
			credentialB = (
				await b.credential.create({
					data: {
						label: "B",
						provider: "AWS_S3",
						encryptedSecret: "encrypted-B",
					},
				})
			).id;
		});

		afterAll(async () => {
			if (admin) {
				await admin.storageLocationPreset.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.appSetting.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.encodingJob.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.bitmovinAccount.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.credential.deleteMany({
					where: { organizationId: { in: [orgA, orgB] } },
				});
				await admin.organization.deleteMany({
					where: { id: { in: [orgA, orgB] } },
				});
				await admin.$disconnect();
			}
			if (app) await app.$disconnect();
		});

		it("isolates list, ID, explicit secret selects, raw SQL and unscoped queries", async () => {
			expect((await a.credential.findMany()).map((row) => row.id)).toEqual([
				credentialA,
			]);
			expect(
				await a.credential.findUnique({
					where: { id: credentialB },
					select: { encryptedSecret: true },
				}),
			).toBeNull();
			expect(
				await a.$queryRaw<
					{ label: string }[]
				>`SELECT label FROM "Credential" ORDER BY label`,
			).toEqual([{ label: "A" }]);
			expect(await app.credential.findMany()).toEqual([]);
			expect(await app.$queryRaw`SELECT label FROM "Credential"`).toEqual([]);
			expect(
				await a.credential.findUnique({ where: { id: credentialA } }),
			).not.toHaveProperty("encryptedSecret");
		});

		it("refuses global SQL, projections and nested identity writes before reaching PostgreSQL", async () => {
			expect(() => a.$queryRawUnsafe('SELECT * FROM public."User"')).toThrow(
				/Global identity SQL/,
			);
			expect(() =>
				a.$queryRawUnsafe(
					'SELECT * FROM "public"."bitovp_auth_token"($1)',
					"prefix01",
				),
			).toThrow(/Global identity SQL/);
			expect(() =>
				a.credential.findUnique({
					where: { id: credentialA },
					include: { organization: true },
				}),
			).toThrow(/Global identity projections/);
			expect(() =>
				a.credential.update({
					where: { id: credentialA },
					data: { organization: { update: { active: false } } },
				}),
			).toThrow(/Global identity relation writes/);
			expect(() =>
				a.apiToken.update({
					where: { id: orgA },
					data: { user: { update: { passwordHash: "forbidden" } } },
				}),
			).toThrow(/Global identity relation writes/);
			expect(
				await admin.organization.findUnique({ where: { id: orgA } }),
			).toMatchObject({ active: true });
		});

		it("rejects cross-org create/connect, reassignment and an entire failed batch", async () => {
			await expect(
				a.storageLocationPreset.create({
					data: {
						label: "foreign",
						bucket: "bucket",
						role: "INPUT",
						credentialId: credentialB,
					},
				}),
			).rejects.toThrow();
			await expect(
				a.credential.update({
					where: { id: credentialA },
					data: { organizationId: orgB },
				}),
			).rejects.toThrow();
			await expect(
				a.$transaction([
					a.credential.create({
						data: {
							label: "rollback",
							provider: "AWS_S3",
							encryptedSecret: "cipher",
						},
					}),
					a.storageLocationPreset.create({
						data: {
							label: "foreign",
							bucket: "bucket",
							role: "INPUT",
							credentialId: credentialB,
						},
					}),
				]),
			).rejects.toThrow();
			expect(await a.credential.count()).toBe(1);
			expect(await b.credential.count()).toBe(1);
		});

		it("preserves logical setting keys and independent upserts in both organizations", async () => {
			await a.appSetting.upsert({
				where: { key: "test.same-key" },
				create: { key: "test.same-key", value: "A" },
				update: { value: "A" },
			});
			await b.appSetting.upsert({
				where: { key: "test.same-key" },
				create: { key: "test.same-key", value: "B" },
				update: { value: "B" },
			});
			expect(
				(await a.appSetting.findUnique({ where: { key: "test.same-key" } }))
					?.value,
			).toBe("A");
			expect(
				(await b.appSetting.findUnique({ where: { key: "test.same-key" } }))
					?.value,
			).toBe("B");
		});

		it("keeps ownership when the original account SetNull relation is deleted", async () => {
			const account = await a.bitmovinAccount.create({
				data: { label: "temporary", encryptedApiKey: "cipher" },
			});
			const job = await a.encodingJob.create({
				data: { name: "retained", plan: {}, bitmovinAccountId: account.id },
			});
			await a.bitmovinAccount.delete({ where: { id: account.id } });
			const retained = await a.encodingJob.findUniqueOrThrow({
				where: { id: job.id },
			});
			expect(retained.bitmovinAccountId).toBeNull();
			expect(retained.organizationId).toBe(orgA);
		});

		it("does not leak scope between simultaneous pooled transactions and enforces read-only raw SQL", async () => {
			const lists = await Promise.all(
				Array.from({ length: 12 }, (_, index) =>
					(index % 2 ? a : b).credential.findMany({
						select: { organizationId: true },
					}),
				),
			);
			lists.forEach((rows, index) => {
				expect(
					rows.every((row) => row.organizationId === (index % 2 ? orgA : orgB)),
				).toBe(true);
			});
			const readOnly = createTenantPrismaClient(app, orgA, { readOnly: true });
			await expect(
				readOnly.$executeRaw`DELETE FROM "Credential"`,
			).rejects.toThrow();
			expect(await a.credential.count()).toBe(1);
		});
	},
);
