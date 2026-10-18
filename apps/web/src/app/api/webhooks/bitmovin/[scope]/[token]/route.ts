import { receiveSignedWebhook } from "@/lib/server/webhook-receiver";

type RouteParams = { params: Promise<{ scope: string; token: string }> };

/**
 * Signed Bitmovin webhook receiver (WP-G G-1):
 * `/api/webhooks/bitmovin/<scope>/<token>` — `j` per-job (G-2), `hb` the
 * live heartbeat hook (G-3), `acct` the account-level standard set.
 *
 * Public by necessity (Bitmovin cannot present a session cookie), so it
 * authenticates every delivery itself: the token names the registration,
 * the HMAC key is derived from it, and nothing is persisted unless the
 * signature over the raw body matches. Unknown URL → 404, bad signature →
 * 401, both without a database write. The whole decision lives in
 * `lib/server/webhook-receiver.ts` so it can be tested without the App
 * Router's params plumbing.
 */
export async function POST(req: Request, { params }: RouteParams) {
	return receiveSignedWebhook(req, await params);
}
