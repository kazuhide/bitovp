import { randomBytes } from "node:crypto";
import { parseEncryptedSecret, type SecretCipher } from "@bitovp/core";
import type { AppPrismaClient } from "./client";
import { DEFAULT_ORGANIZATION_ID, tenantOrganizationId } from "./tenant-client";

/**
 * The webhook MASTER secret (WP-G G-1) — the one input every per-registration
 * signature key is derived from (`deriveWebhookKey` in core).
 *
 * Resolution order, fixed: `BITMOVIN_WEBHOOK_SECRET` from the environment
 * WINS whenever it is set; otherwise the AppSetting row under
 * `WEBHOOK_MASTER_SECRET_KEY`; otherwise 32 random bytes are generated on
 * the spot, encrypted under MASTER_KEY (AES-256-GCM, AAD bound to the row
 * key so the blob cannot be re-homed under another setting) and persisted
 * with a CREATE — never an upsert, so two processes racing to first use
 * cannot each write their own secret: the loser's create fails on the
 * primary key and it re-reads the winner's row.
 *
 * Zero-config on purpose: a laptop behind a quick tunnel needs signed
 * webhooks exactly as much as a hosted install, and "set an env var first"
 * is how the receiver ended up persisting `signatureValid=false` rows.
 */
export const WEBHOOK_MASTER_SECRET_KEY = "webhook.masterSecret";

const aad = (organizationId: string) =>
	`app-setting:${WEBHOOK_MASTER_SECRET_KEY}${organizationId === DEFAULT_ORGANIZATION_ID ? "" : `:org:${organizationId}`}`;

/** `{ v: 1, encrypted: <serialized EncryptedSecret> }` — the envelope credentials use. */
function storedEnvelope(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "encrypted" || keys[1] !== "v") {
		return null;
	}
	if (record.v !== 1 || typeof record.encrypted !== "string") {
		return null;
	}
	return record.encrypted.length > 0 ? record.encrypted : null;
}

export type WebhookMasterSecret = {
	/** Hex when generated; verbatim when it came from the environment. */
	secret: string;
	source: "env" | "generated";
};

export type ResolveWebhookMasterSecretDeps = {
	prisma: AppPrismaClient;
	cipher: SecretCipher;
	/** `BITMOVIN_WEBHOOK_SECRET`, already blank-stripped by loadEnv. */
	envSecret?: string;
	random?: (bytes: number) => Buffer;
};

export async function resolveWebhookMasterSecret(
	deps: ResolveWebhookMasterSecretDeps,
): Promise<WebhookMasterSecret> {
	const organizationId =
		tenantOrganizationId(deps.prisma) ?? DEFAULT_ORGANIZATION_ID;
	if (deps.envSecret && organizationId === DEFAULT_ORGANIZATION_ID) {
		return { secret: deps.envSecret, source: "env" };
	}
	const existing = await readStored(deps);
	if (existing !== null) {
		return { secret: existing, source: "generated" };
	}
	const fresh = (deps.random ?? randomBytes)(32).toString("hex");
	const encrypted = await deps.cipher.encrypt(fresh, aad(organizationId));
	// Round-trip before trusting it: a cipher that serializes something its
	// own parser rejects would otherwise be discovered on the first delivery.
	parseEncryptedSecret(encrypted);
	try {
		await deps.prisma.appSetting.create({
			data: {
				key: WEBHOOK_MASTER_SECRET_KEY,
				value: { v: 1, encrypted },
			},
		});
		return { secret: fresh, source: "generated" };
	} catch (err) {
		if ((err as { code?: string }).code !== "P2002") {
			throw err;
		}
		// Lost the first-use race — the other process's secret is THE secret.
		const winner = await readStored(deps);
		if (winner === null) {
			throw new Error(
				"webhook master secret: create conflicted but no row is readable",
			);
		}
		return { secret: winner, source: "generated" };
	}
}

async function readStored(
	deps: ResolveWebhookMasterSecretDeps,
): Promise<string | null> {
	const row = await deps.prisma.appSetting.findUnique({
		where: { key: WEBHOOK_MASTER_SECRET_KEY },
		select: { value: true },
	});
	if (!row) {
		return null;
	}
	const encrypted = storedEnvelope(row.value);
	if (encrypted === null) {
		// A hand-edited or half-written row must not be silently REPLACED by a
		// new secret (every registration would stop verifying): fail loudly.
		throw new Error(
			`AppSetting[${WEBHOOK_MASTER_SECRET_KEY}] is malformed — delete the row to regenerate (re-register every webhook afterwards)`,
		);
	}
	return deps.cipher.decrypt(
		encrypted,
		aad(tenantOrganizationId(deps.prisma) ?? DEFAULT_ORGANIZATION_ID),
	);
}

/** What a stored row looks like — for fixtures and the reset tooling. */
export async function encodeWebhookMasterSecretRow(
	cipher: SecretCipher,
	secret: string,
	organizationId: string = DEFAULT_ORGANIZATION_ID,
): Promise<{ v: 1; encrypted: string }> {
	return { v: 1, encrypted: await cipher.encrypt(secret, aad(organizationId)) };
}
