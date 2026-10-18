import "server-only";
import { cipherFromEnv, type SecretCipher } from "@bitovp/core";
import {
	createBitmovinAccountStore,
	createCredentialStore,
	getTenantPrisma,
} from "@bitovp/db";
import { headers } from "next/headers";
import { resolveAuthenticatedContext } from "@/lib/auth/tenancy";

/**
 * Defers cipher construction until a secret is actually touched — list/read
 * routes must work (and render empty states) even when MASTER_KEY is
 * missing or malformed; the 503 belongs to encrypt/decrypt operations only
 * (mirrors core's masterKeyFromEnv design note).
 */
export function createLazyCipher(
	factory: () => SecretCipher = cipherFromEnv,
): SecretCipher {
	let real: SecretCipher | null = null;
	const resolved = () => {
		real ??= factory();
		return real;
	};
	return {
		// async so a throwing factory becomes a rejection (Promise contract).
		encrypt: async (plaintext, aad) => resolved().encrypt(plaintext, aad),
		decrypt: async (serialized, aad) => resolved().decrypt(serialized, aad),
	};
}

/**
 * Server-side only (route handlers / server components). Secrets never
 * cross this boundary toward the client: stores return ciphertext-free
 * summaries; reveal* results feed SDK clients exclusively.
 */
export async function getServerContext() {
	const tenant = await resolveAuthenticatedContext(await headers());
	return contextForOrganization(
		tenant.organizationId,
		tenant.isImpersonating,
		tenant,
	);
}

/** Only call after an independently authenticated webhook token resolved its org. */
export function contextForOrganization(
	organizationId: string,
	readOnly = false,
	tenant?: Awaited<ReturnType<typeof resolveAuthenticatedContext>>,
) {
	const prisma = getTenantPrisma(organizationId, { readOnly });
	const cipher = createLazyCipher();
	return {
		prisma,
		tenant,
		// Exposed for the one non-store secret the app keeps (the webhook
		// master secret, WP-G G-1) — still lazy, so a missing MASTER_KEY
		// surfaces only where a secret is actually touched.
		cipher,
		credentials: createCredentialStore(prisma, cipher),
		bitmovinAccounts: createBitmovinAccountStore(prisma, cipher),
	};
}

export type ServerContext = Awaited<ReturnType<typeof getServerContext>>;
