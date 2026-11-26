import { randomBytes } from "node:crypto";
import { AesGcmCipher, SecretDecryptError } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import { createCredentialStore } from "./credentials";
import { fakeTable } from "./test-helpers";

describe("versioned server-side credential reveal", () => {
	it("returns metadata and decrypted secret from one selected database snapshot", async () => {
		const credential = fakeTable(["encryptedSecret"]);
		const cipher = new AesGcmCipher(randomBytes(32));
		const store = createCredentialStore(
			{ credential } as unknown as AppPrismaClient,
			cipher,
		);
		const secret = JSON.stringify({
			relayUrl: "moqt://relay.example",
			playbackUrl: "https://relay.example/subscriber-token",
		});
		const created = await store.create({
			provider: "MOQ",
			label: "relay",
			secret,
		});
		const read = vi.spyOn(credential, "findUniqueOrThrow");
		const initial = credential.rows.get(created.id)?.updatedAt;
		const decrypt = cipher.decrypt.bind(cipher);
		vi.spyOn(cipher, "decrypt").mockImplementation(async (serialized, aad) => {
			// A concurrent update after the selected snapshot must not mix new metadata
			// with the old ciphertext being decrypted.
			await credential.update({
				where: { id: created.id },
				data: { label: "edited" },
			});
			return decrypt(serialized, aad);
		});
		expect(await store.revealVersioned(created.id)).toEqual({
			id: created.id,
			provider: "MOQ",
			updatedAt: initial,
			secret,
		});
		expect(read).toHaveBeenCalledExactlyOnceWith({
			where: { id: created.id },
			select: {
				id: true,
				provider: true,
				updatedAt: true,
				encryptedSecret: true,
			},
		});
	});

	it("retains row/provider AAD binding and refuses missing scoped rows", async () => {
		const credential = fakeTable(["encryptedSecret"]);
		const store = createCredentialStore(
			{ credential } as unknown as AppPrismaClient,
			new AesGcmCipher(randomBytes(32)),
		);
		const created = await store.create({
			provider: "MOQ",
			label: "relay",
			secret: "private",
		});
		const row = credential.rows.get(created.id);
		if (!row) throw new Error("Missing fixture row");
		row.provider = "AWS_S3";
		await expect(store.revealVersioned(created.id)).rejects.toBeInstanceOf(
			SecretDecryptError,
		);
		await expect(store.revealVersioned("absent")).rejects.toThrow(
			"Record not found",
		);
	});
});
