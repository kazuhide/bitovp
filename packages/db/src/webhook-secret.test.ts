import { randomBytes } from "node:crypto";
import { AesGcmCipher, type SecretCipher } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { AppPrismaClient } from "./client";
import { TENANT_ORGANIZATION } from "./tenant-client";
import {
	encodeWebhookMasterSecretRow,
	resolveWebhookMasterSecret,
	WEBHOOK_MASTER_SECRET_KEY,
} from "./webhook-secret";

/**
 * An AppSetting delegate keyed by `key` (fakeTable keys by `id`): findUnique,
 * create with the P2002 a real primary-key collision raises, and upsert.
 */
function fakeAppSetting() {
	const rows = new Map<string, { key: string; value: unknown }>();
	const calls = { create: 0, findUnique: 0 };
	const delegate = {
		rows,
		calls,
		async findUnique(args: {
			where: { key: string };
			select?: Record<string, boolean>;
		}) {
			calls.findUnique += 1;
			const row = rows.get(args.where.key);
			return row ? { value: row.value } : null;
		},
		async create(args: { data: { key: string; value: unknown } }) {
			calls.create += 1;
			if (rows.has(args.data.key)) {
				throw Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				});
			}
			rows.set(args.data.key, { key: args.data.key, value: args.data.value });
			return { ...args.data };
		},
	};
	return delegate;
}

function prismaWith(appSetting: ReturnType<typeof fakeAppSetting>) {
	return { appSetting } as unknown as AppPrismaClient;
}

const cipher: SecretCipher = new AesGcmCipher(randomBytes(32));

describe("resolveWebhookMasterSecret", () => {
	it("new organizations ignore the legacy environment secret and bind generated ciphertext to their organization", async () => {
		const table = fakeAppSetting();
		const prisma = prismaWith(table);
		Object.defineProperty(prisma, TENANT_ORGANIZATION, {
			value: "00000000-0000-4000-8000-00000000000a",
		});
		const generated = await resolveWebhookMasterSecret({
			prisma,
			cipher,
			envSecret: "legacy-secret",
		});
		expect(generated.source).toBe("generated");
		expect(generated.secret).not.toBe("legacy-secret");
		const foreign = prismaWith(table);
		Object.defineProperty(foreign, TENANT_ORGANIZATION, {
			value: "00000000-0000-4000-8000-00000000000b",
		});
		await expect(
			resolveWebhookMasterSecret({ prisma: foreign, cipher }),
		).rejects.toThrow();
	});
	it("the environment value wins — nothing is read or written", async () => {
		const table = fakeAppSetting();
		const result = await resolveWebhookMasterSecret({
			prisma: prismaWith(table),
			cipher,
			envSecret: "env-secret",
		});
		expect(result).toEqual({ secret: "env-secret", source: "env" });
		expect(table.calls).toEqual({ create: 0, findUnique: 0 });
	});

	it("generates 32 random bytes on first use, persists them encrypted, and returns the same value afterwards", async () => {
		const table = fakeAppSetting();
		const deps = { prisma: prismaWith(table), cipher };
		const first = await resolveWebhookMasterSecret(deps);
		expect(first.source).toBe("generated");
		expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
		// At rest: an AES-GCM envelope, not the secret.
		const stored = table.rows.get(WEBHOOK_MASTER_SECRET_KEY)?.value as {
			v: number;
			encrypted: string;
		};
		expect(stored.v).toBe(1);
		expect(stored.encrypted).not.toContain(first.secret);
		expect(JSON.parse(stored.encrypted)).toMatchObject({ alg: "aes-256-gcm" });
		// Second call: read, never regenerate.
		const second = await resolveWebhookMasterSecret(deps);
		expect(second).toEqual(first);
		expect(table.calls.create).toBe(1);
	});

	it("the env value overrides a previously generated secret", async () => {
		const table = fakeAppSetting();
		const deps = { prisma: prismaWith(table), cipher };
		const generated = await resolveWebhookMasterSecret(deps);
		const overridden = await resolveWebhookMasterSecret({
			...deps,
			envSecret: "env-wins",
		});
		expect(overridden).toEqual({ secret: "env-wins", source: "env" });
		expect(overridden.secret).not.toBe(generated.secret);
	});

	it("loses the first-use race gracefully: a P2002 on create re-reads the winner's secret", async () => {
		const table = fakeAppSetting();
		// Simulate the other process winning between our read and our create.
		const winnerRow = await encodeWebhookMasterSecretRow(cipher, "winner");
		const original = table.create.bind(table);
		let planted = false;
		table.create = async (args) => {
			if (!planted) {
				planted = true;
				table.rows.set(WEBHOOK_MASTER_SECRET_KEY, {
					key: WEBHOOK_MASTER_SECRET_KEY,
					value: winnerRow,
				});
			}
			return original(args);
		};
		const result = await resolveWebhookMasterSecret({
			prisma: prismaWith(table),
			cipher,
		});
		expect(result).toEqual({ secret: "winner", source: "generated" });
	});

	it("a malformed row fails loudly rather than being replaced by a fresh secret", async () => {
		const table = fakeAppSetting();
		table.rows.set(WEBHOOK_MASTER_SECRET_KEY, {
			key: WEBHOOK_MASTER_SECRET_KEY,
			value: { v: 2, nope: true },
		});
		await expect(
			resolveWebhookMasterSecret({ prisma: prismaWith(table), cipher }),
		).rejects.toThrow(/malformed/);
		expect(table.calls.create).toBe(0);
	});

	it("a row encrypted under another MASTER_KEY is a decrypt failure, not a silent regenerate", async () => {
		const table = fakeAppSetting();
		const otherCipher = new AesGcmCipher(randomBytes(32));
		table.rows.set(WEBHOOK_MASTER_SECRET_KEY, {
			key: WEBHOOK_MASTER_SECRET_KEY,
			value: await encodeWebhookMasterSecretRow(otherCipher, "theirs"),
		});
		await expect(
			resolveWebhookMasterSecret({ prisma: prismaWith(table), cipher }),
		).rejects.toThrow();
		expect(table.calls.create).toBe(0);
	});
});
