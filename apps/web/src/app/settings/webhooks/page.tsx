import { loadEnv, webhookReceiverPath } from "@bitovp/core";
import { resolveWebhookMasterSecret } from "@bitovp/db";
import { localizedTitle } from "@/lib/i18n/metadata";
import { getServerContext } from "@/lib/server/context";
import { readCurrentIngress } from "@/lib/server/ingress";
import { type IngressWire, WebhooksClient } from "./webhooks-client";

export const generateMetadata = localizedTitle("pageTitles.webhooks");

// Reflects runtime state (the worker's persisted ingress, the webhook
// secret's source) — must not be frozen at build time.
export const dynamic = "force-dynamic";

/**
 * WP-G G-1: the page reads the PERSISTED ingress (what the worker resolved),
 * never PUBLIC_BASE_URL — and reports the signature key's SOURCE, never the
 * key. Every read here degrades to a rendered "unknown" rather than a 500:
 * this is the screen an operator opens to find out why webhooks are not
 * arriving, so it has to render while the database or MASTER_KEY is the
 * thing that is broken.
 */
export default async function WebhooksPage() {
	const ctx = await getServerContext();
	const snapshot = await readCurrentIngress(ctx.prisma);
	const ingress: IngressWire | null = snapshot
		? {
				mode: snapshot.mode,
				baseUrl: snapshot.current?.baseUrl ?? null,
				source: snapshot.current?.source ?? null,
				observedAt: snapshot.current?.observedAt ?? null,
				checkedAt: snapshot.checkedAt,
				reason: snapshot.reason ?? null,
			}
		: null;
	// WP-G G-2: registrations are per encoding, each with its own token — the
	// card shows the receiver PATTERN under the current ingress, not a URL
	// anyone should copy. The account-level `acct` receiver still exists for
	// hooks registered by the G-1b window, but nothing registers it now.
	const receiverPattern =
		ingress?.baseUrl !== null && ingress?.baseUrl !== undefined
			? `${ingress.baseUrl}${webhookReceiverPath("j", "A".repeat(22)).replace(
					"A".repeat(22),
					"<token>",
				)}`
			: null;
	let secretSource: "env" | "generated" | "unavailable" = "unavailable";
	try {
		secretSource = (
			await resolveWebhookMasterSecret({
				prisma: ctx.prisma,
				cipher: ctx.cipher,
				envSecret: loadEnv().BITMOVIN_WEBHOOK_SECRET,
			})
		).source;
	} catch {
		secretSource = "unavailable";
	}
	return (
		<WebhooksClient
			ingress={ingress}
			receiverEndpoint={receiverPattern}
			secretSource={secretSource}
		/>
	);
}
