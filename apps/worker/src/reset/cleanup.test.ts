import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import type { AppPrismaClient, ResetCleanupPayload } from "@bitovp/db";
import { expect, it, vi } from "vitest";
import {
	cleanResetPayload,
	createResetCleanupSweep,
	RESET_ENCODING_ABSENT,
	type ResetCleanupProvider,
} from "./cleanup";

function fixture() {
	const payload: ResetCleanupPayload = {
		v: 1,
		accounts: [
			{ id: "account", encryptedApiKey: "encrypted", tenantOrgId: null },
		],
		encodings: [
			{
				entityKey: "liveChannel:selected",
				encodingId: "encoding",
				accountId: "account",
			},
		],
		webhooks: [],
		verificationIntents: [],
		pendingEntities: [],
	};
	const provider: ResetCleanupProvider = {
		status: vi.fn().mockResolvedValue("FINISHED"),
		stop: vi.fn(),
		releaseTemporaryKeys: vi.fn(),
		removeWebhook: vi.fn(),
	};
	return { payload, provider };
}
it("requires terminal readback after STOP and releases exact encoding keys", async () => {
	const { payload, provider } = fixture();
	vi.mocked(provider.status).mockResolvedValueOnce("RUNNING");
	const result = await cleanResetPayload(payload, async () => provider);
	expect(provider.stop).toHaveBeenCalledWith("encoding");
	expect(provider.releaseTemporaryKeys).toHaveBeenCalledWith("encoding");
	expect([...result.encodings]).toEqual(["account:encoding"]);
});
it("keeps failed provider cleanup and key release durable", async () => {
	const { payload, provider } = fixture();
	vi.mocked(provider.releaseTemporaryKeys).mockRejectedValue(
		new Error("offline"),
	);
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
});
it("does not clear CREATED while a late START can still return", async () => {
	const { payload, provider } = fixture();
	payload.pendingEntities.push({
		entityKey: "liveChannel:selected",
		accountId: "account",
		status: "PROVISIONING",
	});
	vi.mocked(provider.status).mockResolvedValue("CREATED");
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
	expect(provider.releaseTemporaryKeys).not.toHaveBeenCalled();
});
it("keeps the displaced encoder across a CREATED read through either of its mirrored ownership records", async () => {
	const { payload, provider } = fixture();
	payload.encodings.push({
		entityKey: "liveChannelRun:historical",
		accountId: "account",
		encodingId: "encoding",
		requireTerminal: true,
	});
	vi.mocked(provider.status).mockResolvedValue("CREATED");
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
	expect(provider.releaseTemporaryKeys).not.toHaveBeenCalled();
	vi.mocked(provider.status).mockResolvedValue("FINISHED");
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(1);
});
it("settles CREATED with positive never-started evidence and no owner in flight", async () => {
	const { payload, provider } = fixture();
	const [row] = payload.encodings;
	if (!row) throw new Error("Missing test encoder");
	row.allowCreated = true;
	vi.mocked(provider.status).mockResolvedValue("CREATED");
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(1);
});
it("retains a rotated or unbound account on verified absence and accepts an exact terminal result", async () => {
	const { payload, provider } = fixture();
	vi.mocked(provider.status).mockResolvedValue(RESET_ENCODING_ABSENT);
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
	expect(provider.releaseTemporaryKeys).not.toHaveBeenCalled();
	const row = payload.encodings[0];
	if (!row) throw new Error("Missing encoder fixture");
	row.allowVerifiedMissing = true;
	payload.encodings.push({
		...row,
		entityKey: "liveChannelRun:old",
		allowVerifiedMissing: undefined,
	});
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
	vi.mocked(provider.status).mockResolvedValue("FINISHED");
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(1);
});
it("accepts verified absence using the bound credential only after every mirrored writer closes", async () => {
	const { payload, provider } = fixture();
	const row = payload.encodings[0];
	if (!row) throw new Error("Missing encoder fixture");
	row.allowVerifiedMissing = true;
	payload.encodings.push({ ...row, entityKey: "liveChannelRun:other" });
	payload.pendingEntities.push({
		entityKey: "liveChannelRun:other",
		accountId: "account",
		status: "PROVISIONING",
	});
	vi.mocked(provider.status).mockResolvedValue(RESET_ENCODING_ABSENT);
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(0);
	payload.pendingEntities = [];
	expect(
		(await cleanResetPayload(payload, async () => provider)).encodings.size,
	).toBe(1);
	expect(provider.stop).not.toHaveBeenCalled();
});
it("never calls a provider without the saved selected account", async () => {
	const { payload, provider } = fixture();
	payload.accounts = [];
	const factory = vi.fn(async () => provider);
	expect((await cleanResetPayload(payload, factory)).encodings.size).toBe(0);
	expect(factory).not.toHaveBeenCalled();
});

it("does not erase a late encoding/ACK using a pre-append terminal readback", async () => {
	const { payload, provider } = fixture();
	const cipher = new AesGcmCipher(randomBytes(32));
	const state = {
		id: "receipt",
		revision: 0,
		encryptedPayload: await cipher.encrypt(
			JSON.stringify(payload),
			"reset-cleanup:receipt",
		),
	};
	let exists = true;
	const delegate = {
		findMany: vi.fn(async () => (exists ? [{ id: state.id }] : [])),
		findUnique: vi.fn(async () => (exists ? { ...state } : null)),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { revision: number };
				data: { encryptedPayload?: string; revision?: { increment: number } };
			}) => {
				if (where.revision !== state.revision) return { count: 0 };
				if (data.encryptedPayload)
					state.encryptedPayload = data.encryptedPayload;
				if (data.revision) state.revision += data.revision.increment;
				return { count: 1 };
			},
		),
		deleteMany: vi.fn(async ({ where }: { where: { revision: number } }) => {
			if (where.revision !== state.revision) return { count: 0 };
			exists = false;
			return { count: 1 };
		}),
	};
	const prisma = { resetCleanupTask: delegate } as unknown as AppPrismaClient;
	vi.mocked(provider.status).mockImplementationOnce(async () => {
		// The original owner returns from CREATE, journals its id, then ACKs.
		payload.encodings.push({
			entityKey: "liveChannel:selected",
			accountId: "account",
			encodingId: "late-created",
		});
		state.encryptedPayload = await cipher.encrypt(
			JSON.stringify(payload),
			"reset-cleanup:receipt",
		);
		state.revision += 1;
		return "FINISHED";
	});
	await createResetCleanupSweep({
		prisma,
		cipher,
		providerFor: async () => provider,
	})();
	expect(delegate.deleteMany).not.toHaveBeenCalled();
	expect(
		JSON.parse(
			await cipher.decrypt(state.encryptedPayload, "reset-cleanup:receipt"),
		).encodings,
	).toHaveLength(2);
	// A fresh worker retries both identities and then removes the credentials.
	await createResetCleanupSweep({
		prisma,
		cipher,
		providerFor: async () => provider,
	})();
	expect(provider.status).toHaveBeenCalledWith("late-created");
	expect(exists).toBe(false);
});
