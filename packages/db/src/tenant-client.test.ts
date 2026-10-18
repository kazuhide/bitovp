import { describe, expect, it } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	createTenantPrismaClient,
	tenantOrganizationId,
} from "./tenant-client";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function database(superuser = false) {
	const committed: string[] = [];
	let transactions = 0;
	const base = {
		credential: {
			fields: { id: { name: "id" } },
			create: () => {
				throw new Error("eager operation");
			},
			findMany: () => {
				throw new Error("eager operation");
			},
			update: () => {
				throw new Error("eager operation");
			},
		},
		appSetting: {
			findUnique: () => {
				throw new Error("eager operation");
			},
		},
		$transaction: async (callback: (tx: object) => Promise<unknown>) => {
			transactions++;
			let org: string | undefined;
			const pending: string[] = [];
			const tx = {
				$executeRaw: async (_strings: TemplateStringsArray, value: string) => {
					org = value;
					return 1;
				},
				$queryRaw: async (strings: TemplateStringsArray) =>
					strings.join("").includes("pg_roles")
						? [{ rolsuper: superuser, rolbypassrls: false }]
						: [{ org }],
				$executeRawUnsafe: async () => 0,
				credential: {
					create: async ({ data }: { data: { label: string } }) => {
						if (data.label === "failure") throw new Error("write refused");
						pending.push(`${org}:${data.label}`);
						return { organizationId: org, label: data.label };
					},
					findMany: async () => pending,
				},
				appSetting: { findUnique: async (args: unknown) => args },
			};
			const result = await callback(tx);
			committed.push(...pending);
			return result;
		},
	} as unknown as AppPrismaClient;
	return { base, committed, transactions: () => transactions };
}

describe("tenant command facade", () => {
	it("does not execute a command until awaited, then uses its captured organization", async () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		const command = a.credential.create({
			data: { label: "one", provider: "AWS_S3", encryptedSecret: "cipher" },
		});
		expect(db.transactions()).toBe(0);
		await command;
		expect(db.committed).toEqual([`${ORG_A}:one`]);
		expect(tenantOrganizationId(a)).toBe(ORG_A);
	});

	it("preserves atomic batch rollback and rejects foreign or already started commands", async () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		const b = createTenantPrismaClient(db.base, ORG_B);
		const create = (client: AppPrismaClient, label: string) =>
			client.credential.create({
				data: { label, provider: "AWS_S3", encryptedSecret: "cipher" },
			});
		await expect(
			a.$transaction([create(a, "one"), create(a, "failure")]),
		).rejects.toThrow("write refused");
		expect(db.committed).toEqual([]);
		await expect(a.$transaction([create(b, "foreign")])).rejects.toThrow(
			/foreign/i,
		);
		const started = create(a, "started");
		await started;
		await expect(a.$transaction([started])).rejects.toThrow(/started/i);
		const duplicate = create(a, "duplicate");
		await expect(a.$transaction([duplicate, duplicate])).rejects.toThrow(
			/duplicate/i,
		);
		const consumed = create(a, "consumed");
		await a.$transaction([consumed]);
		await expect(consumed).rejects.toThrow(/consumed/i);
		expect(
			db.committed.filter((row) => row.endsWith(":consumed")),
		).toHaveLength(1);
	});

	it("refuses bypass roles and rejects writes in a view-as context", async () => {
		const db = database(true);
		const a = createTenantPrismaClient(db.base, ORG_A);
		await expect(a.$queryRaw`SELECT 1`).rejects.toThrow(/BYPASSRLS/);
		const readOnly = createTenantPrismaClient(database().base, ORG_A, {
			readOnly: true,
		});
		expect(() =>
			readOnly.credential.create({
				data: {
					label: "forbidden",
					provider: "AWS_S3",
					encryptedSecret: "cipher",
				},
			}),
		).toThrow(/read-only/);
	});

	it("scopes interactive transactions and raw SQL in the same short transaction", async () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		const rows = await a.$transaction(async (tx) => {
			expect(tenantOrganizationId(tx)).toBe(ORG_A);
			await tx.credential.create({
				data: {
					label: "inside",
					provider: "AWS_S3",
					encryptedSecret: "cipher",
				},
			});
			return tx.$queryRaw`SELECT current_setting('bitovp.organization_id')`;
		});
		expect(rows).toEqual([{ org: ORG_A }]);
		expect(db.transactions()).toBe(1);
		expect(db.committed).toEqual([`${ORG_A}:inside`]);
		await expect(
			a.$executeRaw`UPDATE "Credential" SET label = 'same' WHERE id = ${ORG_A}::uuid`,
		).resolves.toBe(1);
	});

	it("translates logical setting uniqueness without changing logical keys", async () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		const result = await a.appSetting.findUnique({
			where: { key: "feature.flags" },
		});
		expect(result).toEqual({
			where: {
				organizationId_key: { organizationId: ORG_A, key: "feature.flags" },
			},
		});
	});

	it("rejects missing/invalid scope and blocks lifecycle/extension escapes", () => {
		const db = database();
		expect(() => createTenantPrismaClient(db.base, "")).toThrow(
			/organization/i,
		);
		const a = createTenantPrismaClient(db.base, ORG_A);
		expect(() => a.$extends({})).toThrow(/unsupported/i);
		expect(() => a.$executeRaw`TRUNCATE TABLE "Credential"`).toThrow(
			/Unsafe SQL/,
		);
		expect(
			() =>
				a.$queryRaw`SELECT set_config('bitovp.organization_id', 'another', true)`,
		).toThrow(/Unsafe SQL/);
		expect(() => a.$queryRawUnsafe("SELECT 1; DELETE FROM Credential")).toThrow(
			/Unsafe SQL/,
		);
		expect(a.credential.fields.id).toEqual({ name: "id" });
	});

	it.each([
		'SELECT * FROM "User"',
		'SELECT * FROM public."Organization"',
		'SELECT * FROM "public"."Membership"',
		"SELECT * FROM setupcode",
		"SELECT * FROM public.platformsetting",
		'SELECT * FROM "public"."bitovp_auth_token"($1)',
		"SELECT * FROM bitovp_webhook_organization($1)",
	])("rejects global tables and privileged auth resolvers in raw SQL: %s", (sql) => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		expect(() => a.$queryRawUnsafe(sql)).toThrow(/Global identity SQL/);
		expect(() => a.$executeRawUnsafe(sql)).toThrow(/Global identity SQL/);
		expect(db.transactions()).toBe(0);
	});

	it("rejects global relation projections at any depth before query or transaction execution", async () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		for (const args of [
			{ include: { organization: true } },
			{ select: { organization: { select: { memberships: true } } } },
			{ select: { presets: { include: { organization: true } } } },
			{ select: { _count: { select: { organization: true } } } },
			{
				include: {
					account: { include: { user: { select: { passwordHash: true } } } },
				},
			},
		]) {
			expect(() => a.credential.findMany(args as never)).toThrow(
				/Global identity projections/,
			);
		}
		expect(db.transactions()).toBe(0);
		await a.credential.findMany({ select: { id: true, organizationId: true } });
		await a.credential.findMany({ include: { organization: false } });
		await expect(
			a.$transaction(async (tx) =>
				tx.credential.findMany({ include: { organization: true } }),
			),
		).rejects.toThrow(/Global identity projections/);
	});

	it("rejects nested global writes while preserving arbitrary JSON plans and settings", () => {
		const db = database();
		const a = createTenantPrismaClient(db.base, ORG_A);
		for (const data of [
			{ organization: { update: { active: false } } },
			{ watchRules: { create: { organization: { connect: { id: ORG_B } } } } },
			{
				watchRules: {
					updateMany: {
						where: {},
						data: { organization: { update: { active: false } } },
					},
				},
			},
			{
				watchRules: {
					upsert: {
						where: {},
						create: {},
						update: { organization: { delete: true } },
					},
				},
			},
		]) {
			expect(() =>
				a.credential.update({ where: { id: ORG_A }, data } as never),
			).toThrow(/Global identity relation writes/);
		}
		expect(() =>
			a.credential.create({
				data: {
					label: "JSON",
					provider: "AWS_S3",
					encryptedSecret: "cipher",
					organizationId: ORG_A,
					config: { organization: { update: { active: false } } },
				},
			} as never),
		).not.toThrow();
		expect((a as unknown as Record<string, unknown>)._engine).toBeUndefined();
		expect(
			(a.credential as unknown as Record<string, unknown>).$parent,
		).toBeUndefined();
		expect(db.transactions()).toBe(0);
	});
});
