import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	WEBHOOK_REGISTRATION_KINDS,
	type WebhookRegistrationKind,
} from "@bitovp/core";

/**
 * ACCOUNT-LEVEL Bitmovin webhook registrations  — since WP-G
 * G-2 a read-and-remove surface only: the worker's registrar registers the
 * four kinds PER ENCODING, and this module lists what the account still
 * holds at account level (hooks registered by earlier versions, or by hand)
 * so an operator can see and delete them.
 *
 * THE KIND SET IS CAPABILITY-CHECKED, NOT ASSUMED (review-187 C1: the
 * first cut put liveInputStreamChanged here on the strength of a mock that
 * manufactured the SDK surface — the real class has NO list and NO
 * deleteByWebhookId, so GET 502'd for every account and POST threw before
 * any create; the feature shipped 100% non-functional under six green
 * tests). Probed per kind against the pinned SDK (the probe is a test):
 * finished/error/transferError/liveManifestReady carry list+deleteByWebhookId
 * (and the per-encoding pair the registrar uses); liveInputStreamChanged is
 * create-only (unmanageable). The kinds themselves are core's
 * `WEBHOOK_REGISTRATION_KINDS`, shared with the registrar.
 */

export const REGISTRATION_KINDS = WEBHOOK_REGISTRATION_KINDS;

export type RegistrationKind = WebhookRegistrationKind;

/** Every method the code below calls — the structural probe pins these. */
export const REQUIRED_KIND_METHODS = ["list", "deleteByWebhookId"] as const;

type WebhookLike = {
	id?: string;
	url?: string;
};

type KindApi = {
	list(params?: unknown): Promise<{ items?: WebhookLike[] }>;
	deleteByWebhookId(id: string): Promise<unknown>;
};

export function kindApi(api: BitmovinApi, kind: RegistrationKind): KindApi {
	const group = api.notifications.webhooks.encoding
		.encodings as unknown as Record<RegistrationKind, KindApi>;
	return group[kind];
}

/**
 * Comparable form of a webhook URL (review-187 N2/(d)): Bitmovin may return
 * a normalized variant of what we registered — raw `===` would read ours as
 * external AND defeat the idempotency check, stacking duplicates. Scheme and
 * host are case-insensitive by RFC; the path keeps its case, minus a
 * trailing slash.
 */
export function comparableUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const path = url.pathname.replace(/\/$/, "");
		return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
	} catch {
		return raw;
	}
}

/** C24: bounds a pathological (or offset-ignoring) upstream. */
const MAX_REGISTRATION_PAGES = 5;

export type RegistrationRow = {
	kind: RegistrationKind;
	id: string;
	url: string;
	/** True when the URL is OUR receiver for this deployment (normalized) — signed or legacy. */
	ours: boolean;
	/**
	 * True when the URL is our PRE-G-1 receiver (`/api/webhooks/bitmovin`,
	 * unsigned). Still ours — one click removes it — but it delivers
	 * nowhere useful on an https install and is removed by G-2's migration.
	 */
	legacy: boolean;
};

export type ReceiverEndpoints = {
	/** The signed `acct` receiver; null when there is no public ingress. */
	current: string | null;
	/** The pre-G-1 receiver at the same base; null likewise. */
	legacy: string | null;
};

/** Every registration Bitmovin holds for the manageable kinds, ours flagged. */
export async function listRegistrations(
	api: BitmovinApi,
	endpoints: ReceiverEndpoints,
): Promise<RegistrationRow[]> {
	const target =
		endpoints.current === null ? null : comparableUrl(endpoints.current);
	const legacyTarget =
		endpoints.legacy === null ? null : comparableUrl(endpoints.legacy);
	const rows: RegistrationRow[] = [];
	for (const kind of REGISTRATION_KINDS) {
		// C6: limit ≤ 100 AND paginate — the first cut read one page while its
		// own comment said "never trust 'in practice'" (review-187 N1). BOUNDED
		// per C24's convention (MAX_PAGES, "bounds a pathological account"):
		// the N1 fix's unbounded loop was the codebase's only one, and an
		// upstream ignoring `offset` would have hung the handler with
		// unbounded memory (review-187 re-verdict, proven at 2001 calls).
		for (let pageIndex = 0; pageIndex < MAX_REGISTRATION_PAGES; pageIndex++) {
			const page = await kindApi(api, kind).list({
				offset: pageIndex * 100,
				limit: 100,
			});
			const items = page.items ?? [];
			for (const item of items) {
				if (!item.id || !item.url) {
					continue;
				}
				const comparable = comparableUrl(item.url);
				const current = target !== null && comparable === target;
				const legacy = legacyTarget !== null && comparable === legacyTarget;
				rows.push({
					kind,
					id: item.id,
					url: item.url,
					ours: current || legacy,
					legacy,
				});
			}
			if (items.length < 100) {
				break;
			}
			if (pageIndex === MAX_REGISTRATION_PAGES - 1) {
				// C24's other rail: no silent caps.
				console.warn(
					`[webhook-registration] ${kind}: stopped listing after ${MAX_REGISTRATION_PAGES} full pages — the account holds more registrations than this panel will enumerate`,
				);
			}
		}
	}
	return rows;
}

/**
 * WP-G G-2: the account-level "standard set" registration is GONE — the
 * worker's registrar registers the four kinds PER ENCODING
 * (`createByEncodingId`, apps/worker/src/webhooks/registrar.ts). What is
 * left here is the account-level LIST (so hooks registered by earlier
 * versions, or by hand, stay visible and removable) and the delete.
 */
export async function unregister(
	api: BitmovinApi,
	kind: RegistrationKind,
	webhookId: string,
): Promise<void> {
	await kindApi(api, kind).deleteByWebhookId(webhookId);
}
