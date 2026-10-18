import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPrismaClient } from "./client";
import {
	createTenantPrismaClient,
	DEFAULT_ORGANIZATION_ID,
} from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
const runtimeUrl = process.env.BITOVP_TENANT_TEST_APP_URL;
const migration = "20261004110000_organization_isolation";

describe.runIf(Boolean(adminUrl && runtimeUrl))(
	"seeded legacy migration",
	() => {
		it("preserves existing users, credentials and orphan cleanup while moving ingress and creating Main memberships", async () => {
			const scratch = mkdtempSync(join(tmpdir(), "bitovp-legacy-"));
			const databaseName = `bitovp_legacy_${randomUUID().replaceAll("-", "")}`;
			const admin = createPrismaClient(adminUrl);
			const legacyUrl = new URL(adminUrl as string);
			legacyUrl.pathname = `/${databaseName}`;
			legacyUrl.searchParams.set("schema", "public");
			const scopedUrl = new URL(runtimeUrl as string);
			scopedUrl.pathname = `/${databaseName}`;
			scopedUrl.searchParams.set("schema", "public");
			const legacy = createPrismaClient(legacyUrl.toString());
			const runtime = createPrismaClient(scopedUrl.toString());
			const migrations = join(__dirname, "../prisma/migrations");
			const userId = randomUUID();
			const credentialId = randomUUID();
			const cleanupId = randomUUID();
			const deploy = () =>
				execFileSync(
					"pnpm",
					[
						"exec",
						"prisma",
						"migrate",
						"deploy",
						"--schema",
						join(scratch, "schema.prisma"),
					],
					{
						cwd: join(__dirname, ".."),
						env: { ...process.env, DATABASE_URL: legacyUrl.toString() },
						stdio: "pipe",
					},
				);
			try {
				await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
				const role = (
					await runtime.$queryRaw<
						{ name: string }[]
					>`SELECT current_user AS name`
				)[0]?.name;
				if (!role || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(role))
					throw new Error("Unexpected test runtime role name");
				writeFileSync(
					join(scratch, "schema.prisma"),
					readFileSync(join(__dirname, "../prisma/schema.prisma")),
				);
				for (const entry of readdirSync(migrations, { withFileTypes: true })) {
					if (entry.name === migration) continue;
					cpSync(
						join(migrations, entry.name),
						join(scratch, "migrations", entry.name),
						{ recursive: true },
					);
				}
				deploy();
				expect(
					(
						await legacy.$queryRaw<
							{ name: string }[]
						>`SELECT current_database() AS name`
					)[0]?.name,
				).toBe(databaseName);
				await legacy.$executeRaw`INSERT INTO "User" ("id","email","displayName","passwordHash","role","updatedAt") VALUES (${userId}::uuid,${`legacy-${userId}@invalid`},'Legacy','existing-password-hash','ADMIN',now())`;
				await legacy.$executeRaw`INSERT INTO "Credential" ("id","label","provider","encryptedSecret","updatedAt") VALUES (${credentialId}::uuid,'Legacy','AWS_S3','existing-ciphertext',now())`;
				await legacy.$executeRaw`INSERT INTO "ResetCleanupTask" ("id","encryptedPayload","entityKeys","updatedAt") VALUES (${cleanupId}::uuid,'existing-receipt',ARRAY['legacy:orphan'],now())`;
				await legacy.$executeRaw`INSERT INTO "AppSetting" ("key","value","updatedAt") VALUES ('ingress.current','{"legacy":true}'::jsonb,now()),('webhook.masterSecret','{"v":1,"encrypted":"existing-hook-cipher"}'::jsonb,now())`;
				cpSync(
					join(migrations, migration),
					join(scratch, "migrations", migration),
					{ recursive: true },
				);
				deploy();
				await legacy.$executeRawUnsafe(
					`GRANT USAGE ON SCHEMA "public" TO "${role}"`,
				);
				await legacy.$executeRawUnsafe(
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "${role}"`,
				);
				const main = createTenantPrismaClient(runtime, DEFAULT_ORGANIZATION_ID);
				expect(
					await main.credential.findUnique({
						where: { id: credentialId },
						select: { encryptedSecret: true, organizationId: true },
					}),
				).toEqual({
					encryptedSecret: "existing-ciphertext",
					organizationId: DEFAULT_ORGANIZATION_ID,
				});
				expect(
					await main.resetCleanupTask.findUnique({
						where: { id: cleanupId },
						select: { encryptedPayload: true, organizationId: true },
					}),
				).toEqual({
					encryptedPayload: "existing-receipt",
					organizationId: DEFAULT_ORGANIZATION_ID,
				});
				expect(
					(await legacy.user.findUniqueOrThrow({ where: { id: userId } }))
						.passwordHash,
				).toBe("existing-password-hash");
				expect(
					(
						await legacy.membership.findUniqueOrThrow({
							where: {
								userId_organizationId: {
									userId,
									organizationId: DEFAULT_ORGANIZATION_ID,
								},
							},
						})
					).role,
				).toBe("ADMIN");
				expect(
					(
						await main.appSetting.findUniqueOrThrow({
							where: { key: "webhook.masterSecret" },
						})
					).value,
				).toEqual({ v: 1, encrypted: "existing-hook-cipher" });
				expect(
					await main.appSetting.findUnique({
						where: { key: "ingress.current" },
					}),
				).toBeNull();
				expect(
					(
						await legacy.platformSetting.findUniqueOrThrow({
							where: { key: "ingress.current" },
						})
					).value,
				).toEqual({ legacy: true });
			} finally {
				await legacy.$disconnect();
				await runtime.$disconnect();
				await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
				await admin.$disconnect();
				rmSync(scratch, { recursive: true, force: true });
			}
		}, 30_000);
	},
);
