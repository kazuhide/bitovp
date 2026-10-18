/**
 * Envelope for an encrypted secret, serialized to a JSON string for storage
 * in Postgres text columns. Versioned so a future KMS-backed cipher (or
 * algorithm rotation) can coexist with existing rows.
 */
export type EncryptedSecret = {
	v: 1;
	alg: "aes-256-gcm";
	/** Optional key id — enables master-key rotation with a keyring. */
	kid?: string;
	/** base64, 12-byte random nonce */
	iv: string;
	/** base64 ciphertext */
	ct: string;
	/** base64, 16-byte GCM auth tag */
	tag: string;
};

/**
 * Cipher boundary for secrets at rest (REQUIREMENTS §6: AES-256-GCM, key
 * from env/KMS). Async so a KMS implementation can drop in without
 * touching call sites. `aad` binds a ciphertext to its owning record
 * (e.g. "credential:<id>") so blobs cannot be swapped between rows.
 */
export interface SecretCipher {
	encrypt(plaintext: string, aad?: string): Promise<string>;
	decrypt(serialized: string, aad?: string): Promise<string>;
}

/** Thrown for any decryption failure; intentionally carries no detail. */
export class SecretDecryptError extends Error {
	constructor() {
		super(
			"Secret decryption failed (wrong master key, tampered data, or AAD mismatch)",
		);
		this.name = "SecretDecryptError";
	}
}

/**
 * MASTER_KEY missing/malformed. Typed so HTTP layers can map it to a
 * generic 503 without string-sniffing or echoing config state to clients.
 */
export class MasterKeyConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MasterKeyConfigError";
	}
}
