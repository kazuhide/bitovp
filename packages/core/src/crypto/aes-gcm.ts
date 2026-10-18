import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
	type EncryptedSecret,
	MasterKeyConfigError,
	type SecretCipher,
	SecretDecryptError,
} from "./types";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const encryptedSecretSchema = z.object({
	v: z.literal(1),
	alg: z.literal("aes-256-gcm"),
	kid: z.string().min(1).optional(),
	iv: z.base64(),
	ct: z.base64(),
	tag: z.base64(),
});

export function serializeEncryptedSecret(secret: EncryptedSecret): string {
	return JSON.stringify(secret);
}

export function parseEncryptedSecret(serialized: string): EncryptedSecret {
	let raw: unknown;
	try {
		raw = JSON.parse(serialized);
	} catch {
		throw new SecretDecryptError();
	}
	const parsed = encryptedSecretSchema.safeParse(raw);
	if (!parsed.success) {
		throw new SecretDecryptError();
	}
	return parsed.data;
}

export class AesGcmCipher implements SecretCipher {
	readonly #key: Buffer;
	readonly #kid: string | undefined;

	constructor(key: Buffer, options: { kid?: string } = {}) {
		if (key.length !== KEY_BYTES) {
			throw new Error(
				`AES-256-GCM key must be ${KEY_BYTES} bytes, got ${key.length}`,
			);
		}
		// Defensive copy — immune to caller-side mutation of the key buffer.
		this.#key = Buffer.from(key);
		this.#kid = options.kid;
	}

	async encrypt(plaintext: string, aad?: string): Promise<string> {
		assertAad(aad);
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		if (aad) {
			cipher.setAAD(Buffer.from(aad, "utf8"));
		}
		const ct = Buffer.concat([
			cipher.update(plaintext, "utf8"),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		return serializeEncryptedSecret({
			v: 1,
			alg: "aes-256-gcm",
			...(this.#kid ? { kid: this.#kid } : {}),
			iv: iv.toString("base64"),
			ct: ct.toString("base64"),
			tag: tag.toString("base64"),
		});
	}

	async decrypt(serialized: string, aad?: string): Promise<string> {
		assertAad(aad);
		const secret = parseEncryptedSecret(serialized);
		const iv = Buffer.from(secret.iv, "base64");
		const tag = Buffer.from(secret.tag, "base64");
		if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
			throw new SecretDecryptError();
		}
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
			decipher.setAuthTag(tag);
			if (aad) {
				decipher.setAAD(Buffer.from(aad, "utf8"));
			}
			const pt = Buffer.concat([
				decipher.update(Buffer.from(secret.ct, "base64")),
				decipher.final(),
			]);
			return pt.toString("utf8");
		} catch {
			// Deliberately indistinguishable: wrong key / tamper / AAD mismatch.
			throw new SecretDecryptError();
		}
	}
}

/** Empty AAD would silently disable binding on both sides — refuse it. */
function assertAad(aad: string | undefined): void {
	if (aad !== undefined && aad.length === 0) {
		throw new Error("aad must be non-empty when provided");
	}
}

const base64Schema = z.base64();

/**
 * Reads and validates MASTER_KEY (strict base64, 32 bytes) from the
 * environment. Kept separate from loadEnv: only code that actually touches
 * secrets should require the key to be present. Strict validation matters:
 * Buffer.from(raw, "base64") silently skips invalid characters, which would
 * let a mangled key encrypt real data before anyone notices.
 */
export function masterKeyFromEnv(
	source: NodeJS.ProcessEnv = process.env,
): Buffer {
	const raw = source.MASTER_KEY?.trim();
	if (!raw) {
		throw new MasterKeyConfigError(
			"MASTER_KEY is not set. Generate one with: openssl rand -base64 32",
		);
	}
	if (!base64Schema.safeParse(raw).success) {
		throw new MasterKeyConfigError(
			"MASTER_KEY must be strict base64 (generate with: openssl rand -base64 32)",
		);
	}
	const key = Buffer.from(raw, "base64");
	if (key.length !== KEY_BYTES) {
		throw new MasterKeyConfigError(
			`MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
		);
	}
	return key;
}

export function cipherFromEnv(
	source: NodeJS.ProcessEnv = process.env,
): SecretCipher {
	return new AesGcmCipher(masterKeyFromEnv(source));
}
