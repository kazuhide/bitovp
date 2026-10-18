import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPrismaClient } from "./client";
import { privateEnv, readAppEnv } from "./runtime-role-setup";
import { createTenantPrismaClient } from "./tenant-client";

const adminUrl = process.env.BITOVP_TENANT_TEST_ADMIN_URL;
describe.runIf(Boolean(adminUrl))(
	"runtime role CLI against a dedicated PostgreSQL database",
	() => {
		it("prepares fresh migrations and upgrades existing credentials without giving runtime DDL/TRUNCATE/bypass", async () => {
			const sourceUrl = new URL(adminUrl ?? "");
			const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
			const database = `bitovp_role_${suffix}`;
			const role = `bitovp_runtime_${suffix}`;
			const upgradedRole = `${role}_upgrade`;
			const admin = createPrismaClient(sourceUrl.toString());
			const directory = mkdtempSync(join(tmpdir(), "bitovp-role-db-"));
			const adminFile = join(directory, ".env.migrate");
			const appFile = join(directory, ".env");
			const upgradedAdmin = join(directory, ".env.upgrade.migrate");
			const upgradedApp = join(directory, ".env.upgrade");
			sourceUrl.pathname = `/${database}`;
			const composeUrl = new URL(sourceUrl);
			composeUrl.hostname = "postgres";
			composeUrl.port = "5432";
			let scopedAdmin: ReturnType<typeof createPrismaClient> | undefined;
			let runtime: ReturnType<typeof createPrismaClient> | undefined;
			let upgradeRuntime: ReturnType<typeof createPrismaClient> | undefined;
			const command = (script: string, args: string[] = []) => {
				try {
					return execFileSync(
						"pnpm",
						["--filter", "@bitovp/db", script, ...args],
						{
							cwd: join(__dirname, "../../.."),
							env: {
								...process.env,
								MIGRATION_DATABASE_URL: "",
								RUNTIME_DATABASE_ROLE: "",
								RUNTIME_DATABASE_PASSWORD: "",
								BITOVP_MIGRATION_IN_CONTAINER: "",
							},
							encoding: "utf8",
							stdio: ["ignore", "pipe", "pipe"],
						},
					);
				} catch {
					throw new Error(
						"Runtime setup CLI failed on its dedicated test database.",
					);
				}
			};
			try {
				await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
				scopedAdmin = createPrismaClient(sourceUrl.toString());
				writeFileSync(
					adminFile,
					`DATABASE_URL=${sourceUrl.toString()}\nCOMPOSE_MIGRATION_DATABASE_URL=${composeUrl.toString()}\n`,
					{ mode: 0o600 },
				);
				const preserved =
					"MASTER_KEY=fixture-preserved\nAUTH_PASSWORD_HASH=scrypt$16384$8$1$fixture-salt$fixture-hash\nAUTH_SESSION_SECRET=fixture-preserved-session\n";
				writeFileSync(appFile, preserved, { mode: 0o600 });
				const output = command("db:runtime:prepare", [
					"--admin-env",
					adminFile,
					"--app-env",
					appFile,
					"--runtime-role",
					role,
				]);
				const runtimeUrl = new URL(readAppEnv(appFile).DATABASE_URL ?? "");
				expect(output.includes(decodeURIComponent(runtimeUrl.password))).toBe(
					false,
				);
				expect(readFileSync(appFile, "utf8").startsWith(preserved)).toBe(true);
				expect(statSync(appFile).mode & 0o777).toBe(0o600);
				command("db:migrate:deploy", ["--admin-env", adminFile]);
				runtime = createPrismaClient(runtimeUrl.toString());
				const flags = await runtime.$queryRaw<
					{
						rolsuper: boolean;
						rolbypassrls: boolean;
						rolcreaterole: boolean;
						rolcreatedb: boolean;
					}[]
				>`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname=current_user`;
				expect(flags).toEqual([
					{
						rolsuper: false,
						rolbypassrls: false,
						rolcreaterole: false,
						rolcreatedb: false,
					},
				]);
				const organizationId = randomUUID();
				await scopedAdmin.organization.create({
					data: {
						id: organizationId,
						name: "Prepared role",
						slug: organizationId,
					},
				});
				const tenant = createTenantPrismaClient(runtime, organizationId);
				await tenant.credential.create({
					data: {
						label: "isolated",
						provider: "AWS_S3",
						encryptedSecret: "fixture-ciphertext",
					},
				});
				expect(await runtime.credential.count()).toBe(0);
				expect(await tenant.credential.count()).toBe(1);
				await expect(
					runtime.$executeRawUnsafe('TRUNCATE TABLE "Credential" CASCADE'),
				).rejects.toThrow();
				await expect(
					runtime.$executeRawUnsafe(
						'ALTER TABLE "Credential" DISABLE ROW LEVEL SECURITY',
					),
				).rejects.toThrow();
				await expect(
					runtime.$executeRawUnsafe(
						"CREATE TABLE public.forbidden_runtime_ddl(id INT)",
					),
				).rejects.toThrow();
				await expect(
					runtime.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"'),
				).rejects.toThrow();
				await scopedAdmin.$executeRawUnsafe(
					"CREATE TABLE public.runtime_future_grants(id INT)",
				);
				await runtime.$executeRawUnsafe(
					"INSERT INTO public.runtime_future_grants(id) VALUES (1)",
				);
				expect(
					await runtime.$queryRawUnsafe(
						"SELECT id FROM public.runtime_future_grants",
					),
				).toEqual([{ id: 1 }]);
				await expect(
					runtime.$executeRawUnsafe(
						"TRUNCATE TABLE public.runtime_future_grants",
					),
				).rejects.toThrow();
				const user = await scopedAdmin.user.create({
					data: {
						email: `${suffix}@upgrade.invalid`,
						displayName: "Existing identity",
						passwordHash: "fixture-hash",
					},
				});
				writeFileSync(
					upgradedApp,
					`${preserved}DATABASE_URL=${sourceUrl.toString()}\n`,
					{ mode: 0o600 },
				);
				command("db:runtime:import-admin", [
					"--admin-env",
					upgradedAdmin,
					"--app-env",
					upgradedApp,
					"--runtime-role",
					upgradedRole,
				]);
				expect(
					new URL(readAppEnv(upgradedApp).DATABASE_URL ?? "").password,
				).toBe("");
				expect(
					new URL(privateEnv(upgradedAdmin).DATABASE_URL ?? "").username,
				).toBe(sourceUrl.username);
				command("db:runtime:prepare", [
					"--admin-env",
					upgradedAdmin,
					"--app-env",
					upgradedApp,
				]);
				command("db:migrate:deploy", ["--admin-env", upgradedAdmin]);
				upgradeRuntime = createPrismaClient(
					readAppEnv(upgradedApp).DATABASE_URL,
				);
				expect(
					await upgradeRuntime.user.findUnique({
						where: { id: user.id },
						select: { displayName: true },
					}),
				).toEqual({ displayName: "Existing identity" });
				expect(readFileSync(upgradedApp, "utf8").startsWith(preserved)).toBe(
					true,
				);
				await expect(
					upgradeRuntime.$executeRawUnsafe('TRUNCATE TABLE "User" CASCADE'),
				).rejects.toThrow();
			} finally {
				await runtime?.$disconnect();
				await upgradeRuntime?.$disconnect();
				await scopedAdmin?.$disconnect();
				await admin.$executeRawUnsafe(
					`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
				);
				for (const name of [role, upgradedRole])
					await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`);
				await admin.$disconnect();
				rmSync(directory, { recursive: true, force: true });
			}
		}, 60000);
	},
);
