import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	AesGcmCipher,
	cipherFromEnv,
	masterKeyFromEnv,
	parseEncryptedSecret,
} from "./aes-gcm";
import { SecretDecryptError } from "./types";

const key = randomBytes(32);

function tamper(serialized: string, field: "ct" | "tag" | "iv"): string {
	const parsed = JSON.parse(serialized) as Record<string, string>;
	const buf = Buffer.from(parsed[field] as string, "base64");
	buf[0] = ((buf[0] as number) + 1) % 256;
	parsed[field] = buf.toString("base64");
	return JSON.stringify(parsed);
}

describe("AesGcmCipher", () => {
	it("roundtrips plaintext", async () => {
		const cipher = new AesGcmCipher(key);
		const blob = await cipher.encrypt('{"accessKeyId":"AKIA…"}');
		expect(blob).not.toContain("AKIA");
		await expect(cipher.decrypt(blob)).resolves.toBe('{"accessKeyId":"AKIA…"}');
	});

	it("produces a fresh IV per encryption", async () => {
		const cipher = new AesGcmCipher(key);
		const [a, b] = await Promise.all([
			cipher.encrypt("same"),
			cipher.encrypt("same"),
		]);
		expect(a).not.toBe(b);
		expect(parseEncryptedSecret(a).iv).not.toBe(parseEncryptedSecret(b).iv);
	});

	it("rejects tampered ciphertext, tag, and iv", async () => {
		const cipher = new AesGcmCipher(key);
		const blob = await cipher.encrypt("secret");
		for (const field of ["ct", "tag", "iv"] as const) {
			await expect(cipher.decrypt(tamper(blob, field))).rejects.toBeInstanceOf(
				SecretDecryptError,
			);
		}
	});

	it("rejects decryption with a different key", async () => {
		const blob = await new AesGcmCipher(key).encrypt("secret");
		const other = new AesGcmCipher(randomBytes(32));
		await expect(other.decrypt(blob)).rejects.toBeInstanceOf(
			SecretDecryptError,
		);
	});

	it("binds ciphertext to its AAD", async () => {
		const cipher = new AesGcmCipher(key);
		const blob = await cipher.encrypt("secret", "credential:abc");
		await expect(cipher.decrypt(blob, "credential:abc")).resolves.toBe(
			"secret",
		);
		await expect(
			cipher.decrypt(blob, "credential:other"),
		).rejects.toBeInstanceOf(SecretDecryptError);
		await expect(cipher.decrypt(blob)).rejects.toBeInstanceOf(
			SecretDecryptError,
		);
	});

	it("rejects malformed blobs", async () => {
		const cipher = new AesGcmCipher(key);
		for (const bad of ["not json", "{}", '{"v":2}']) {
			await expect(cipher.decrypt(bad)).rejects.toBeInstanceOf(
				SecretDecryptError,
			);
		}
	});

	it("requires a 32-byte key", () => {
		expect(() => new AesGcmCipher(randomBytes(16))).toThrow(/32 bytes/);
	});

	it("refuses an empty AAD on both sides", async () => {
		const cipher = new AesGcmCipher(key);
		await expect(cipher.encrypt("x", "")).rejects.toThrow(/non-empty/);
		const blob = await cipher.encrypt("x", "scope");
		await expect(cipher.decrypt(blob, "")).rejects.toThrow(/non-empty/);
	});

	it("stamps and roundtrips an optional key id", async () => {
		const cipher = new AesGcmCipher(key, { kid: "k1" });
		const blob = await cipher.encrypt("x");
		expect(parseEncryptedSecret(blob).kid).toBe("k1");
		await expect(cipher.decrypt(blob)).resolves.toBe("x");
	});

	it("is immune to caller-side key mutation", async () => {
		const mutable = Buffer.from(key);
		const cipher = new AesGcmCipher(mutable);
		const blob = await cipher.encrypt("x");
		mutable.fill(0);
		await expect(cipher.decrypt(blob)).resolves.toBe("x");
	});
});

describe("masterKeyFromEnv", () => {
	it("decodes a valid base64 key", () => {
		const raw = randomBytes(32).toString("base64");
		expect(masterKeyFromEnv({ MASTER_KEY: raw }).length).toBe(32);
	});

	it("fails with a generation hint when unset", () => {
		expect(() => masterKeyFromEnv({})).toThrow(/openssl rand -base64 32/);
	});

	it("rejects keys of the wrong length", () => {
		expect(() =>
			masterKeyFromEnv({ MASTER_KEY: randomBytes(16).toString("base64") }),
		).toThrow(/32 bytes/);
	});

	it("rejects non-strict base64 instead of decoding leniently", () => {
		expect(() =>
			masterKeyFromEnv({
				MASTER_KEY: `!!${randomBytes(31).toString("base64")}`,
			}),
		).toThrow(/strict base64/);
	});

	it("builds a working cipher from env", async () => {
		const cipher = cipherFromEnv({
			MASTER_KEY: randomBytes(32).toString("base64"),
		});
		await expect(cipher.decrypt(await cipher.encrypt("x"))).resolves.toBe("x");
	});
});
