import { z } from "zod";

/**
 * Public ingress detection (WP-G G-1).
 *
 * Bitmovin can only deliver a webhook to a URL it can reach, and until this
 * module the only answer was a hand-set `PUBLIC_BASE_URL` — nothing on a
 * laptop, and a stale value the moment a tunnel URL rotated. The resolver
 * here answers ONE question, "what is this install's public base URL right
 * now?", in one of four modes, and the WORKER re-asks it every 30 s and
 * persists the answer under `AppSetting[INGRESS_SETTING_KEY]`. The web app
 * reads the persisted answer only — never the env directly — so
 * registration, the proxy's Host allowlist and the settings screen all
 * agree on one value.
 *
 * Pure by construction: env is passed in, the sidecar is reached through an
 * injected `fetch`, the clock is injected. Tests drive every mode without a
 * network.
 */

export const INGRESS_MODES = [
	"none",
	"static",
	"quick-tunnel",
	"named-tunnel",
] as const;

export type IngressMode = (typeof INGRESS_MODES)[number];

/** Where a resolved value came from — one source per mode that resolves. */
export const INGRESS_SOURCES = [
	"PUBLIC_BASE_URL",
	"cloudflared-quicktunnel",
	"INGRESS_HOSTNAME",
] as const;

export type IngressSource = (typeof INGRESS_SOURCES)[number];

/** The `AppSetting.key` the worker writes and the web app reads. */
export const INGRESS_SETTING_KEY = "ingress.current";

/** Worker re-resolve cadence; the settings screen shows staleness against it. */
export const INGRESS_RESOLVE_INTERVAL_MS = 30_000;

/**
 * The cloudflared sidecar's metrics server answers `/quicktunnel` with
 * `{"hostname":"<x>.trycloudflare.com"}` (cloudflared `metrics/metrics.go`,
 * verified at the pinned tag 2026.8.3 — the handler is unconditional, and
 * the hostname is the empty string until the tunnel is up). `docker-compose.yml`
 * publishes it as service `ingress` on 20241, which is the first of
 * cloudflared's own "known" metrics ports.
 */
export const DEFAULT_QUICKTUNNEL_METRICS_URL =
	"http://ingress:20241/quicktunnel";

/** How long one sidecar probe may take before it counts as unreachable. */
export const QUICKTUNNEL_PROBE_TIMEOUT_MS = 3_000;

export const resolvedIngressSchema = z.strictObject({
	/** Origin only — scheme + host (+ port), no path, no trailing slash. */
	baseUrl: z.string().url(),
	source: z.enum(INGRESS_SOURCES),
	/** ISO — when THIS value was first observed (carried across unchanged ticks). */
	observedAt: z.string().datetime(),
});

export type ResolvedIngress = z.infer<typeof resolvedIngressSchema>;

/**
 * The persisted row. `current: null` is a first-class state (no public
 * ingress) and carries its `reason` so the settings screen can say WHY —
 * "sidecar unreachable" and "PUBLIC_BASE_URL unset" need different fixes.
 */
export const ingressSnapshotSchema = z.strictObject({
	v: z.literal(1),
	mode: z.enum(INGRESS_MODES),
	current: resolvedIngressSchema.nullable(),
	/** ISO — when the resolver last ran, changed or not. */
	checkedAt: z.string().datetime(),
	reason: z.string().optional(),
});

export type IngressSnapshot = z.infer<typeof ingressSnapshotSchema>;

/** Parse a stored value; malformed or absent ⇒ null (never throws). */
export function parseIngressSnapshot(value: unknown): IngressSnapshot | null {
	const parsed = ingressSnapshotSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export type IngressConfig = {
	mode: IngressMode;
	publicBaseUrl?: string;
	ingressHostname?: string;
	quickTunnelMetricsUrl: string;
};

export type IngressEnv = {
	INGRESS_MODE?: string;
	PUBLIC_BASE_URL?: string;
	INGRESS_HOSTNAME?: string;
	INGRESS_QUICKTUNNEL_METRICS_URL?: string;
};

/**
 * Env → config. `INGRESS_MODE` defaults to `static`, which is exactly the
 * pre-G-1 behaviour (PUBLIC_BASE_URL drives the registered URL; unset ⇒ no
 * ingress), so an existing `.env` keeps working unchanged. An unknown mode
 * is refused loudly rather than mapped to `none`: a typo must not silently
 * turn webhooks off.
 */
export function parseIngressConfig(env: IngressEnv): IngressConfig {
	const raw = env.INGRESS_MODE?.trim();
	const mode = raw === undefined || raw === "" ? "static" : raw;
	if (!(INGRESS_MODES as readonly string[]).includes(mode)) {
		throw new Error(
			`INGRESS_MODE must be one of ${INGRESS_MODES.join(" | ")}, got "${mode}"`,
		);
	}
	return {
		mode: mode as IngressMode,
		publicBaseUrl: blankToUndefined(env.PUBLIC_BASE_URL),
		ingressHostname: blankToUndefined(env.INGRESS_HOSTNAME),
		quickTunnelMetricsUrl:
			blankToUndefined(env.INGRESS_QUICKTUNNEL_METRICS_URL) ??
			DEFAULT_QUICKTUNNEL_METRICS_URL,
	};
}

function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export type IngressResolution =
	| { ok: true; current: ResolvedIngress }
	| { ok: false; reason: string };

export type IngressResolverDeps = {
	fetch?: typeof fetch;
	now?: () => Date;
};

/**
 * Normalize a base URL to its ORIGIN. Bitmovin stores whatever we register
 * verbatim and `comparableUrl` compares registrations by string, so a
 * trailing slash or a stray path here would fork "ours" into two URLs.
 * Only http(s) qualifies — a webhook target is an HTTP URL by definition.
 */
export function normalizeIngressBaseUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	if (url.username || url.password) {
		return null;
	}
	return url.origin;
}

/** The hostname (no port) of a resolved base URL — the proxy allowlist's unit. */
export function ingressHostnameOf(baseUrl: string): string | null {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Resolve once, in the configured mode. Never throws. */
export async function resolveIngress(
	config: IngressConfig,
	deps: IngressResolverDeps = {},
): Promise<IngressResolution> {
	const observedAt = (deps.now?.() ?? new Date()).toISOString();
	switch (config.mode) {
		case "none":
			return { ok: false, reason: "INGRESS_MODE=none — no public ingress" };
		case "static": {
			if (!config.publicBaseUrl) {
				return {
					ok: false,
					reason: "PUBLIC_BASE_URL is not set (INGRESS_MODE=static)",
				};
			}
			const baseUrl = normalizeIngressBaseUrl(config.publicBaseUrl);
			if (!baseUrl) {
				return {
					ok: false,
					reason: "PUBLIC_BASE_URL is not an http(s) URL",
				};
			}
			return {
				ok: true,
				current: { baseUrl, source: "PUBLIC_BASE_URL", observedAt },
			};
		}
		case "named-tunnel": {
			if (!config.ingressHostname) {
				return {
					ok: false,
					reason: "INGRESS_HOSTNAME is not set (INGRESS_MODE=named-tunnel)",
				};
			}
			// A named Cloudflare tunnel terminates TLS at the edge: the public
			// origin is always https, whatever the sidecar speaks to `web`.
			const baseUrl = normalizeIngressBaseUrl(
				`https://${config.ingressHostname}`,
			);
			if (!baseUrl) {
				return {
					ok: false,
					reason: "INGRESS_HOSTNAME is not a valid hostname",
				};
			}
			return {
				ok: true,
				current: { baseUrl, source: "INGRESS_HOSTNAME", observedAt },
			};
		}
		case "quick-tunnel":
			return resolveQuickTunnel(config, deps, observedAt);
	}
}

async function resolveQuickTunnel(
	config: IngressConfig,
	deps: IngressResolverDeps,
	observedAt: string,
): Promise<IngressResolution> {
	const doFetch = deps.fetch ?? globalThis.fetch;
	let body: unknown;
	try {
		const res = await doFetch(config.quickTunnelMetricsUrl, {
			method: "GET",
			signal: AbortSignal.timeout(QUICKTUNNEL_PROBE_TIMEOUT_MS),
		});
		if (!res.ok) {
			return {
				ok: false,
				reason: `cloudflared metrics answered HTTP ${res.status} at ${config.quickTunnelMetricsUrl}`,
			};
		}
		body = await res.json();
	} catch (err) {
		return {
			ok: false,
			reason: `cloudflared metrics unreachable at ${config.quickTunnelMetricsUrl}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
	const hostname =
		typeof body === "object" &&
		body !== null &&
		typeof (body as { hostname?: unknown }).hostname === "string"
			? ((body as { hostname: string }).hostname ?? "").trim()
			: "";
	if (hostname === "") {
		// cloudflared answers `{"hostname":""}` until the edge assigned one.
		return {
			ok: false,
			reason: "cloudflared has not reported a quick-tunnel hostname yet",
		};
	}
	const baseUrl = normalizeIngressBaseUrl(`https://${hostname}`);
	if (!baseUrl) {
		return {
			ok: false,
			reason: `cloudflared reported an unusable hostname: ${hostname}`,
		};
	}
	return {
		ok: true,
		current: { baseUrl, source: "cloudflared-quicktunnel", observedAt },
	};
}

/**
 * Change detection for the persisted value: mode or base URL differ. The
 * timestamps are deliberately NOT part of it — every tick re-stamps
 * `checkedAt`, and a change is what re-registers every webhook.
 */
export function ingressChanged(
	previous: IngressSnapshot | null,
	next: IngressSnapshot,
): boolean {
	const prevUrl = previous?.current?.baseUrl ?? null;
	const nextUrl = next.current?.baseUrl ?? null;
	if (prevUrl !== nextUrl) {
		return true;
	}
	// Same URL (or both absent) under a different mode is still a change —
	// the operator switched configuration; the screen must say so even when
	// the tunnel happened to keep its name.
	return previous !== null && previous.mode !== next.mode;
}

/**
 * Build the next snapshot from the previous one and a fresh resolution.
 * `observedAt` survives an unchanged tick so the screen can say "since
 * 09:12", not "since 30 seconds ago" forever.
 */
export function nextIngressSnapshot(
	previous: IngressSnapshot | null,
	mode: IngressMode,
	resolution: IngressResolution,
	now: Date,
): IngressSnapshot {
	const checkedAt = now.toISOString();
	if (!resolution.ok) {
		return { v: 1, mode, current: null, checkedAt, reason: resolution.reason };
	}
	const prior = previous?.current ?? null;
	const unchanged =
		prior !== null &&
		prior.baseUrl === resolution.current.baseUrl &&
		prior.source === resolution.current.source;
	return {
		v: 1,
		mode,
		current: unchanged
			? { ...resolution.current, observedAt: prior.observedAt }
			: resolution.current,
		checkedAt,
	};
}
