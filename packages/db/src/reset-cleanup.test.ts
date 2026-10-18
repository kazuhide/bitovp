import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	acknowledgeResetCleanupEntity,
	appendResetCleanupEncoding,
	createResetCleanupTask,
	mutateResetCleanupTask,
	type ResetCleanupPayload,
	readResetCleanupTask,
	recordResetCleanupWebhookResult,
	revealResetCleanupAccount,
} from "./reset-cleanup";
import { fakeTable } from "./test-helpers";

function fixture() {
	const table = fakeTable(["encryptedPayload"]);
	let loseOnce = false;
	const delegate = {
		...table,
		findFirst: vi.fn(
			async ({ where }: { where: { entityKeys: { has: string } } }) =>
				[...table.rows.values()].find((row) =>
					(row.entityKeys as string[]).includes(where.entityKeys.has),
				) ?? null,
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string; revision: number };
				data: Record<string, unknown>;
			}) => {
				const row = table.rows.get(where.id);
				if (!row) return { count: 0 };
				if (loseOnce) {
					loseOnce = false;
					row.revision = (row.revision as number) + 1;
					return { count: 0 };
				}
				if (row.revision !== where.revision) return { count: 0 };
				Object.assign(row, data, { revision: where.revision + 1 });
				return { count: 1 };
			},
		),
	};
	return {
		table,
		delegate,
		prisma: { resetCleanupTask: delegate } as unknown as AppPrismaClient,
		cipher: new AesGcmCipher(randomBytes(32)),
		loseNextUpdate: () => {
			loseOnce = true;
		},
	};
}
const payload = (): ResetCleanupPayload => ({
	v: 1,
	accounts: [],
	encodings: [],
	webhooks: [],
	verificationIntents: [],
	pendingEntities: [],
});

describe("durable reset cleanup", () => {
	it("does not let a displaced worker acknowledge the current owner's SDK work", async () => {
		const f = fixture();
		const value = payload();
		value.pendingEntities.push({
			entityKey: "encodingJob:job",
			accountId: "account",
			status: "RUNNING",
			ownerToken: "new-owner",
		});
		const id = await createResetCleanupTask(f.prisma, f.cipher, value);
		const row = f.table.rows.get(id);
		if (!row) throw new Error("Missing receipt");
		row.revision = 0;
		await acknowledgeResetCleanupEntity(
			f.prisma,
			f.cipher,
			"encodingJob:job",
			"old-owner",
		);
		expect(
			(await readResetCleanupTask(f.prisma, f.cipher, id))?.payload
				.pendingEntities,
		).toHaveLength(1);
		await acknowledgeResetCleanupEntity(
			f.prisma,
			f.cipher,
			"encodingJob:job",
			"new-owner",
		);
		expect(
			(await readResetCleanupTask(f.prisma, f.cipher, id))?.payload
				.pendingEntities,
		).toEqual([]);
	});
	it("rejects stale provider proof after a late encoding result changes the receipt", async () => {
		const f = fixture();
		const id = await createResetCleanupTask(f.prisma, f.cipher, payload(), [
			"encodingJob:gone",
		]);
		const row = f.table.rows.get(id);
		if (!row) throw new Error("Missing receipt");
		row.revision = 0;
		await appendResetCleanupEncoding(
			f.prisma,
			f.cipher,
			"encodingJob:gone",
			"late",
			null,
		);
		await expect(
			mutateResetCleanupTask(
				f.prisma,
				f.cipher,
				id,
				(value) => {
					value.encodings = [];
				},
				0,
			),
		).resolves.toBe(false);
		expect(
			(await readResetCleanupTask(f.prisma, f.cipher, id))?.payload.encodings,
		).toHaveLength(1);
	});
	it("keeps a late webhook ID after the registration disappeared and acknowledges its creator", async () => {
		const f = fixture();
		const value = payload();
		value.pendingEntities.push({
			entityKey: "webhookRegistration:gone",
			ownerToken: "owner",
			accountId: "account",
			status: "SKIPPED",
		});
		value.webhooks.push({
			id: "gone",
			scope: "j",
			encodingId: "encoding",
			accountId: "account",
			kind: "finished",
			providerWebhookId: null,
			url: "https://test.invalid/token",
			tokenHash: "hash",
			configuration: { createAttempted: true },
			status: "SKIPPED",
			claimedUntil: new Date().toISOString(),
		});
		const id = await createResetCleanupTask(f.prisma, f.cipher, value);
		const row = f.table.rows.get(id);
		if (!row) throw new Error("Missing receipt");
		row.revision = 0;
		await recordResetCleanupWebhookResult(
			f.prisma,
			f.cipher,
			"gone",
			"late-hook",
			"owner",
		);
		const read = await readResetCleanupTask(f.prisma, f.cipher, id);
		expect(read?.payload.pendingEntities).toEqual([]);
		expect(read?.payload.webhooks[0]?.providerWebhookId).toBe("late-hook");
		await recordResetCleanupWebhookResult(
			f.prisma,
			f.cipher,
			"gone",
			"older-late-hook",
			"displaced-owner",
		);
		expect(
			(await readResetCleanupTask(f.prisma, f.cipher, id))?.payload.webhooks[0]
				?.providerWebhookIds,
		).toEqual(["late-hook", "older-late-hook"]);
	});
	it("encrypts every cleanup detail, omits raw reads, and binds ciphertext to receipt identity", async () => {
		const f = fixture();
		const data = payload();
		data.accounts.push({
			id: "account",
			encryptedApiKey: await f.cipher.encrypt(
				"private-api-key",
				"bitmovin-account:account",
			),
			tenantOrgId: "org",
		});
		data.encodings.push({
			entityKey: "encodingJob:job",
			encodingId: "sensitive-encoder",
			accountId: "account",
		});
		const id = await createResetCleanupTask(f.prisma, f.cipher, data);
		const stored = f.table.rows.get(id);
		expect(stored?.encryptedPayload).not.toContain("private-api-key");
		expect(stored?.encryptedPayload).not.toContain("sensitive-encoder");
		expect(await f.table.findUnique({ where: { id } })).not.toHaveProperty(
			"encryptedPayload",
		);
		const read = await readResetCleanupTask(f.prisma, f.cipher, id);
		expect(read?.payload).toEqual(data);
		const account = data.accounts[0];
		if (!account) throw new Error("Missing account");
		await expect(revealResetCleanupAccount(f.cipher, account)).resolves.toEqual(
			{ apiKey: "private-api-key", tenantOrgId: "org" },
		);
		const other = await createResetCleanupTask(f.prisma, f.cipher, payload());
		const otherRow = f.table.rows.get(other);
		if (!otherRow) throw new Error("Missing receipt");
		otherRow.encryptedPayload = stored?.encryptedPayload;
		await expect(
			readResetCleanupTask(f.prisma, f.cipher, other),
		).rejects.toThrow();
	});
	it("reopens a settled receipt on a late SDK result and retries concurrent cleanup updates", async () => {
		const f = fixture();
		const id = await createResetCleanupTask(f.prisma, f.cipher, payload(), [
			"encodingJob:gone",
		]);
		const row = f.table.rows.get(id);
		if (!row) throw new Error("Missing receipt");
		Object.assign(row, {
			revision: 0,
			settledAt: new Date(),
		});
		f.loseNextUpdate();
		await expect(
			appendResetCleanupEncoding(
				f.prisma,
				f.cipher,
				"encodingJob:gone",
				"late-encoding",
				null,
			),
		).resolves.toBe(true);
		expect(f.delegate.updateMany).toHaveBeenCalledTimes(2);
		expect(f.table.rows.get(id)?.settledAt).toBeNull();
		expect(
			(await readResetCleanupTask(f.prisma, f.cipher, id))?.payload.encodings,
		).toEqual([
			{
				entityKey: "encodingJob:gone",
				encodingId: "late-encoding",
				accountId: null,
			},
		]);
		await expect(
			appendResetCleanupEncoding(
				f.prisma,
				f.cipher,
				"encodingJob:unrelated",
				"other",
				null,
			),
		).resolves.toBe(false);
	});
});
