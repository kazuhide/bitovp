import { randomBytes } from "node:crypto";
import { AesGcmCipher, SecretDecryptError } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { AppPrismaClient } from "./client";
import { createCredentialStore } from "./credentials";
import { fakeTable } from "./test-helpers";

function setup() {
	const credential = fakeTable(["encryptedSecret"]);
	const prisma = { credential } as unknown as AppPrismaClient;
	const cipher = new AesGcmCipher(randomBytes(32));
	const store = createCredentialStore(prisma, cipher);
	return { store, credential };
}

const secret = JSON.stringify({
	accessKeyId: "AKIAEXAMPLE",
	secretAccessKey: "verysecret",
});

describe("credential store", () => {
	it("encrypts on create and never returns ciphertext", async () => {
		const { store, credential } = setup();
		const created = await store.create({
			label: "prod-s3",
			provider: "AWS_S3",
			config: { region: "ap-northeast-1" },
			secret,
		});
		expect(created).not.toHaveProperty("encryptedSecret");

		const stored = credential.rows.get(created.id);
		expect(stored?.encryptedSecret).toBeTypeOf("string");
		expect(stored?.encryptedSecret).not.toContain("verysecret");
		expect(stored?.encryptedSecret).not.toContain("AKIAEXAMPLE");
	});

	it("reveals the original secret server-side", async () => {
		const { store } = setup();
		const created = await store.create({
			label: "x",
			provider: "GCS_HMAC",
			secret,
		});
		await expect(store.revealSecret(created.id)).resolves.toBe(secret);
	});

	it("rejects decryption after a provider flip (AAD binds provider)", async () => {
		const { store, credential } = setup();
		const created = await store.create({
			label: "a",
			provider: "AWS_S3",
			secret,
		});
		const row = credential.rows.get(created.id);
		if (!row) {
			throw new Error("row missing");
		}
		row.provider = "GENERIC_S3";
		await expect(store.revealSecret(created.id)).rejects.toBeInstanceOf(
			SecretDecryptError,
		);
	});

	it("rejects ciphertext swapped between rows (AAD binding)", async () => {
		const { store, credential } = setup();
		const a = await store.create({ label: "a", provider: "AWS_S3", secret });
		const b = await store.create({
			label: "b",
			provider: "AWS_S3",
			secret: JSON.stringify({ other: true }),
		});
		const rowA = credential.rows.get(a.id);
		const rowB = credential.rows.get(b.id);
		if (!rowA || !rowB) {
			throw new Error("rows missing");
		}
		rowB.encryptedSecret = rowA.encryptedSecret;
		await expect(store.revealSecret(b.id)).rejects.toBeInstanceOf(
			SecretDecryptError,
		);
	});

	it("re-encrypts on secret update", async () => {
		const { store, credential } = setup();
		const created = await store.create({
			label: "x",
			provider: "AZURE_BLOB",
			secret,
		});
		const before = credential.rows.get(created.id)?.encryptedSecret;
		await store.update(created.id, { secret: '{"accountKey":"new"}' });
		const after = credential.rows.get(created.id)?.encryptedSecret;
		expect(after).not.toBe(before);
		await expect(store.revealSecret(created.id)).resolves.toBe(
			'{"accountKey":"new"}',
		);
	});

	it("omits ciphertext from list and get", async () => {
		const { store } = setup();
		const created = await store.create({
			label: "x",
			provider: "OCI_OBJECT_STORAGE",
			secret,
		});
		for (const row of await store.list()) {
			expect(row).not.toHaveProperty("encryptedSecret");
		}
		expect(await store.get(created.id)).not.toHaveProperty("encryptedSecret");
	});
});
