import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppPrismaClient, createPrismaClient } from "./client";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const appUrl = process.env.BITOVP_TENANT_TEST_APP_URL;

describe.runIf(Boolean(adminUrl && appUrl))(
	"PostgreSQL statement timeout transactions",
	() => {
		let admin: AppPrismaClient;
		let runtime: AppPrismaClient;
		let tenant: AppPrismaClient;
		const organizationId = randomUUID();
		const otherOrganizationId = randomUUID();
		beforeAll(async () => {
			for (const value of [adminUrl, appUrl]) {
				if (!value)
					throw new Error("Dedicated transaction test URLs are required");
				const url = new URL(value);
				if (
					url.hostname !== "127.0.0.1" ||
					!/^\/bitovp_integration_[a-f0-9]{32}$/.test(url.pathname)
				)
					throw new Error(
						"Transaction tests require a dedicated loopback PostgreSQL fixture",
					);
			}
			admin = createPrismaClient(adminUrl);
			const url = new URL(appUrl as string);
			url.searchParams.set("connection_limit", "1");
			runtime = createPrismaClient(url.toString());
			for (const id of [organizationId, otherOrganizationId])
				await admin.organization.create({
					data: { id, name: "Transaction test", slug: id },
				});
			tenant = createTenantPrismaClient(runtime, organizationId);
			await admin.credential.createMany({
				data: [organizationId, otherOrganizationId].map((id) => ({
					organizationId: id,
					label: "Visible only in its tenant",
					provider: "AWS_S3",
					encryptedSecret: "unused-synthetic-secret",
				})),
			});
		});
		afterAll(async () => {
			try {
				if (admin) {
					await admin.credential.deleteMany({
						where: {
							organizationId: { in: [organizationId, otherOrganizationId] },
						},
					});
					await admin.organization.deleteMany({
						where: { id: { in: [organizationId, otherOrganizationId] } },
					});
				}
			} finally {
				await runtime?.$disconnect();
				await admin?.$disconnect();
			}
		});
		async function backend() {
			const [row] = await runtime.$queryRaw<
				{ pid: number; timeout: string }[]
			>`SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout`;
			if (!row) throw new Error("The fixture did not return its own backend");
			return row;
		}
		async function assertReusable(pid: number, originalTimeout: string) {
			const [state] = await admin.$queryRaw<
				{ state: string }[]
			>`SELECT state FROM pg_stat_activity WHERE pid = ${pid}`;
			expect(state?.state).toBe("idle");
			const reused = await backend();
			expect(reused).toEqual({ pid, timeout: originalTimeout });
		}
		function expectCancellation(error: unknown) {
			expect(error).toMatchObject({ code: "P2010", meta: { code: "57014" } });
		}

		it("cancels native callback SQL, stops following work and frees the same pooled backend", async () => {
			const original = await backend();
			let afterSleep = false;
			const started = performance.now();
			const error = await runtime
				.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT pg_sleep(3)`;
						afterSleep = true;
						await tx.$queryRaw`SELECT 1`;
					},
					{ timeout: 30000, statementTimeoutMs: 100 },
				)
				.catch((error) => error);
			expectCancellation(error);
			expect(afterSleep).toBe(false);
			expect(performance.now() - started).toBeLessThan(2000);
			await assertReusable(original.pid, original.timeout);
		});

		it("preserves native batch results and atomically rolls back a cancelled batch", async () => {
			const result = await runtime.$transaction(
				[
					runtime.$queryRaw<{ value: number }[]>`SELECT 7::integer AS value`,
					runtime.$queryRaw<
						{ value: string }[]
					>`SELECT 'second'::text AS value`,
				],
				{ statementTimeoutMs: 5000 },
			);
			expect(result).toEqual([[{ value: 7 }], [{ value: "second" }]]);
			const original = await backend();
			const error = await runtime
				.$transaction(
					[
						runtime.$queryRaw`SELECT set_config('bitovp.organization_id', ${organizationId}, true)`,
						runtime.credential.create({
							data: {
								label: "Rolled back native batch",
								provider: "AWS_S3",
								encryptedSecret: "unused-synthetic-secret",
							},
						}),
						runtime.$queryRaw`SELECT pg_sleep(3)`,
					],
					{ statementTimeoutMs: 100 },
				)
				.catch((error) => error);
			expectCancellation(error);
			expect(
				await tenant.credential.count({
					where: { label: "Rolled back native batch" },
				}),
			).toBe(0);
			await assertReusable(original.pid, original.timeout);
		});

		it("retains tenant RLS, read-only context and raw guards with callback setup", async () => {
			const readOnly = createTenantPrismaClient(runtime, organizationId, {
				readOnly: true,
			});
			const result = await readOnly.$transaction(
				async (tx) => {
					const [settings] = await tx.$queryRaw<
						{ scope: string; readOnly: string; timeout: string }[]
					>`SELECT current_setting('bitovp.organization_id') AS scope, current_setting('transaction_read_only') AS "readOnly", current_setting('statement_timeout') AS timeout`;
					expect(
						() =>
							tx.$queryRaw`SELECT set_config('statement_timeout', '0', true)`,
					).toThrow(/Unsafe SQL/);
					expect(() =>
						tx.credential.create({
							data: {
								label: "Refused",
								provider: "AWS_S3",
								encryptedSecret: "unused-synthetic-secret",
							},
						}),
					).toThrow(/read-only/);
					return {
						settings,
						rows: await tx.credential.findMany({
							select: { organizationId: true },
						}),
					};
				},
				{ statementTimeoutMs: 5000, isolationLevel: "RepeatableRead" },
			);
			expect(result.settings).toEqual({
				scope: organizationId,
				readOnly: "on",
				timeout: "5s",
			});
			expect(result.rows).toEqual([{ organizationId }]);
			await expect(
				readOnly.$transaction(
					(tx) =>
						tx.$executeRaw`UPDATE "Credential" SET label = 'Refused' WHERE "organizationId" = ${organizationId}::uuid`,
					{ statementTimeoutMs: 5000 },
				),
			).rejects.toMatchObject({ code: "P2010", meta: { code: "25006" } });
			const original = await backend();
			const error = await tenant
				.$transaction(
					async (tx) => {
						await tx.credential.create({
							data: {
								label: "Rolled back callback",
								provider: "AWS_S3",
								encryptedSecret: "unused-synthetic-secret",
							},
						});
						await tx.$queryRaw`SELECT pg_sleep(3)`;
					},
					{ statementTimeoutMs: 100 },
				)
				.catch((error) => error);
			expectCancellation(error);
			expect(
				await tenant.credential.count({
					where: { label: "Rolled back callback" },
				}),
			).toBe(0);
			await assertReusable(original.pid, original.timeout);
		});

		it("cancels tenant lazy batches without committing earlier writes or leaking settings", async () => {
			const original = await backend();
			const error = await tenant
				.$transaction(
					[
						tenant.credential.create({
							data: {
								label: "Rolled back tenant batch",
								provider: "AWS_S3",
								encryptedSecret: "unused-synthetic-secret",
							},
						}),
						tenant.$queryRaw`SELECT pg_sleep(3)`,
					],
					{ statementTimeoutMs: 100 },
				)
				.catch((error) => error);
			expectCancellation(error);
			expect(
				await tenant.credential.count({
					where: { label: "Rolled back tenant batch" },
				}),
			).toBe(0);
			await assertReusable(original.pid, original.timeout);
		});

		it("bounds an in-flight statement that outlives the native transaction deadline", async () => {
			const original = await backend();
			let afterSleep = false;
			const started = performance.now();
			const operation = runtime
				.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT pg_sleep(3)`;
						afterSleep = true;
					},
					{ timeout: 200, statementTimeoutMs: 500 },
				)
				.catch((error) => error);
			const error = await operation;
			expect(error).toMatchObject({ code: "P2028" });
			expect(afterSleep).toBe(false);
			expect(performance.now() - started).toBeGreaterThanOrEqual(450);
			expect(performance.now() - started).toBeLessThan(2000);
			await assertReusable(original.pid, original.timeout);
		});

		it("keeps the existing five-second native default when no setting is supplied", async () => {
			const original = await backend();
			let afterExpiry = false;
			const error = await runtime
				.$transaction(async (tx) => {
					const [row] = await tx.$queryRaw<
						{ timeout: string }[]
					>`SELECT current_setting('statement_timeout') AS timeout`;
					expect(row?.timeout).toBe(original.timeout);
					await new Promise((resolve) => setTimeout(resolve, 5100));
					await tx.$queryRaw`SELECT 1`;
					afterExpiry = true;
				})
				.catch((error) => error);
			expect(error).toMatchObject({ code: "P2028" });
			expect(afterExpiry).toBe(false);
			await assertReusable(original.pid, original.timeout);
		}, 15000);
	},
);
