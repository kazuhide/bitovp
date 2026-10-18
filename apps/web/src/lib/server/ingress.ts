import "server-only";
import {
	deriveScopedToken,
	type IngressSnapshot,
	LEGACY_WEBHOOK_RECEIVER_PATH,
	loadEnv,
	webhookReceiverPath,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { readIngressSnapshot, resolveWebhookMasterSecret } from "@bitovp/db";
import { getServerContext } from "./context";

/**
 * The web app's view of the public ingress (WP-G G-1): the row the worker's
 * monitor persists, NEVER `PUBLIC_BASE_URL` read here — the two would
 * disagree the moment a tunnel rotated, and every consumer of "where does
 * Bitmovin deliver to" (registration, the settings screen, the legacy
 * receiver's https rule) must see one value.
 */

/** Null when there is no row, the row is malformed, or the DB is unreachable. */
export async function readCurrentIngress(
	prisma?: AppPrismaClient,
): Promise<IngressSnapshot | null> {
	try {
		const client = prisma ?? (await getServerContext()).prisma;
		return await readIngressSnapshot(client);
	} catch {
		return null;
	}
}

/** The resolved public base URL, or null — the ONE question most callers have. */
export async function currentIngressBaseUrl(
	prisma?: AppPrismaClient,
): Promise<string | null> {
	return (await readCurrentIngress(prisma))?.current?.baseUrl ?? null;
}

export type AccountReceiver = {
	/** Absolute URL of the signed account-level receiver (`acct` scope). */
	endpoint: string;
	/** Absolute URL of the pre-G-1 receiver — hooks registered there are legacy. */
	legacyEndpoint: string;
	secretSource: "env" | "generated";
};

/**
 * The account-level receiver as screens and read routes see it: the signed
 * `acct` endpoint, the legacy endpoint and the secret's SOURCE — never a key
 * (WP-G G-2b removed the account-level registration POST, so no web path
 * holds one). Null without a public ingress; a missing MASTER_KEY throws
 * (the caller maps it to 503 like every other secret-touching route).
 */
export async function accountReceiver(
	context?: Awaited<ReturnType<typeof getServerContext>>,
): Promise<AccountReceiver | null> {
	const ctx = context ?? (await getServerContext());
	const baseUrl = await currentIngressBaseUrl(ctx.prisma);
	if (baseUrl === null) {
		return null;
	}
	const master = await resolveWebhookMasterSecret({
		prisma: ctx.prisma,
		cipher: ctx.cipher,
		envSecret: loadEnv().BITMOVIN_WEBHOOK_SECRET,
	});
	// The token only: the HMAC key is derived where a registration is made
	// (the worker's registrar, WP-G G-2/G-3), never on a read path (rev407b).
	const token = deriveScopedToken(master.secret, "acct");
	return {
		endpoint: `${baseUrl}${webhookReceiverPath("acct", token)}`,
		legacyEndpoint: `${baseUrl}${LEGACY_WEBHOOK_RECEIVER_PATH}`,
		secretSource: master.source,
	};
}
