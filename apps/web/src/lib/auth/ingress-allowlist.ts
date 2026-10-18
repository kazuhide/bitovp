import "server-only";
import { ingressHostnameOf } from "@bitovp/core";
import { getPrisma, readIngressSnapshot } from "@bitovp/db";

/**
 * The public ingress hostname, for the proxy's Host/Origin allowlist (WP-G
 * G-1). A quick tunnel's hostname is minted by Cloudflare at sidecar start,
 * so it cannot be in `ALLOWED_ORIGIN_HOSTS` — the value lives in the row
 * the worker's ingress monitor persists, and the proxy consults it ONLY
 * for a Host/Origin the static allowlist already rejected. That keeps the
 * common path free of any database read, and bounds the uncommon one:
 *
 * - a hit is served from a per-process cache for `TTL_MS`;
 * - a MISS may refresh the cache no more than once per `MISS_FLOOR_MS`, so
 *   a flood of unknown Hosts cannot become a flood of queries;
 * - a database fault reads as "no ingress hostname" — the static allowlist
 *   still applies, so the failure direction is closed, never open.
 *
 * The persisted value is configuration written by the worker (env or the
 * sidecar's self-report), never request input, so trusting it here does not
 * reopen the reflection weakness the allowlist exists to close.
 */
const TTL_MS = 15_000;
const MISS_FLOOR_MS = 5_000;

type Cache = { at: number; hostname: string | null };
let cache: Cache | null = null;
let inflight: Promise<string | null> | null = null;

/** Test seam. */
export function resetIngressHostnameCache(): void {
	cache = null;
	inflight = null;
}

async function readFromDatabase(): Promise<string | null> {
	try {
		const snapshot = await readIngressSnapshot(getPrisma());
		const baseUrl = snapshot?.current?.baseUrl;
		return baseUrl ? ingressHostnameOf(baseUrl) : null;
	} catch {
		return null;
	}
}

/**
 * The current ingress hostname, lowercase, or null. `candidate` is the
 * hostname that just missed the static allowlist: when the cache is warm
 * and already names it, no refresh is needed; when the cache is warm and
 * does NOT name it, a refresh happens only past the miss floor.
 */
export async function ingressHostname(
	candidate: string,
	now: number = Date.now(),
	read: () => Promise<string | null> = readFromDatabase,
): Promise<string | null> {
	if (cache !== null) {
		const age = now - cache.at;
		if (age < TTL_MS && (cache.hostname === candidate || age < MISS_FLOOR_MS)) {
			return cache.hostname;
		}
	}
	// One read in flight at a time (security-review #310 finding 3): ten
	// concurrent cold misses used to be ten queries; now they share one.
	inflight ??= read().finally(() => {
		inflight = null;
	});
	const hostname = await inflight;
	cache = { at: now, hostname };
	return hostname;
}
