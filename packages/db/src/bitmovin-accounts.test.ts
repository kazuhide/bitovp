import { randomBytes } from "node:crypto";
import { AesGcmCipher } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { createBitmovinAccountStore } from "./bitmovin-accounts";
import type { AppPrismaClient } from "./client";
import { fakeTable } from "./test-helpers";

function setup() {
	const bitmovinAccount = fakeTable(["encryptedApiKey"]);
	const prisma = { bitmovinAccount } as unknown as AppPrismaClient;
	const cipher = new AesGcmCipher(randomBytes(32));
	const store = createBitmovinAccountStore(prisma, cipher);
	return { store, bitmovinAccount };
}

describe("bitmovin account store", () => {
	it("encrypts the api key and reveals it server-side only", async () => {
		const { store, bitmovinAccount } = setup();
		const created = await store.create({
			label: "main",
			apiKey: "bitmovin-api-key-123",
			tenantOrgId: "org-1",
		});
		expect(created).not.toHaveProperty("encryptedApiKey");

		const stored = bitmovinAccount.rows.get(created.id);
		expect(stored?.encryptedApiKey).not.toContain("bitmovin-api-key-123");
		await expect(store.revealApiKey(created.id)).resolves.toBe(
			"bitmovin-api-key-123",
		);
	});

	it("re-encrypts on api key rotation", async () => {
		const { store, bitmovinAccount } = setup();
		const created = await store.create({ label: "main", apiKey: "old" });
		const before = bitmovinAccount.rows.get(created.id)?.encryptedApiKey;
		await store.update(created.id, { apiKey: "new" });
		expect(bitmovinAccount.rows.get(created.id)?.encryptedApiKey).not.toBe(
			before,
		);
		await expect(store.revealApiKey(created.id)).resolves.toBe("new");
	});

	it("omits ciphertext from list", async () => {
		const { store } = setup();
		await store.create({ label: "main", apiKey: "k" });
		for (const row of await store.list()) {
			expect(row).not.toHaveProperty("encryptedApiKey");
		}
	});
});
