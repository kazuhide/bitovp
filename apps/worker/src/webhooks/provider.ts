import { SignatureType, WebhookHttpMethod } from "@bitmovin/api-sdk";
import type { WebhookRegistrationKind } from "@bitovp/core";
import { type AppPrismaClient, writeAuditLog } from "@bitovp/db";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import { createRetryingFetch } from "../orchestrator/retrying-fetch";
import type { RegistrarProviderApi } from "./registrar";

/**
 * The registrar's provider boundary (WP-G G-2): the four per-encoding
 * webhook kinds on the real SDK — `createByEncodingId` and
 * `deleteByEncodingIdAndWebhookId` — behind the same audit trail every
 * other worker-side Bitmovin call leaves (C7). The signature KEY is in the
 * request Bitmovin receives and is redacted from the audit snapshot: an
 * audit row is readable by every ADMIN and a key in a log is a key.
 *
 * `remove` treats a 404 as success: the hook is already gone, which is the
 * state the caller wants. Every other failure propagates so the registrar
 * records it on the row and backs off.
 */
export const WEBHOOK_REGISTRAR_ACTOR = "worker:webhook-registrar";

/** Every method the registrar calls — the structural probe pins these. */
export const REQUIRED_PER_ENCODING_METHODS = [
	"createByEncodingId",
	"deleteByEncodingIdAndWebhookId",
] as const;

type PerEncodingApi = {
	createByEncodingId(
		encodingId: string,
		webhook: { url: string; signature: { type: "HMAC"; key: string } },
	): Promise<{ id?: string }>;
	deleteByEncodingIdAndWebhookId(
		encodingId: string,
		webhookId: string,
	): Promise<unknown>;
};

/** Only retirement of previously owned account-level hooks remains. */
type HeartbeatApi = { deleteByWebhookId(webhookId: string): Promise<unknown> };

export const REQUIRED_HEARTBEAT_METHODS = [
	"deleteByWebhookId",
	"createByEncodingId",
	"listByEncodingId",
	"getByEncodingIdAndWebhookId",
	"deleteByEncodingIdAndWebhookId",
] as const;

export function heartbeatApi(api: BitmovinApi): HeartbeatApi {
	return api.notifications.webhooks.encoding.encodings
		.liveEncodingHeartbeat as unknown as HeartbeatApi;
}

export function perEncodingApi(
	api: BitmovinApi,
	kind: WebhookRegistrationKind,
): PerEncodingApi {
	const group = api.notifications.webhooks.encoding
		.encodings as unknown as Record<WebhookRegistrationKind, PerEncodingApi>;
	return group[kind];
}

/** The SDK's BitmovinError carries `httpStatusCode` (see ops/shared.ts). */
function httpStatusOf(err: unknown): number | undefined {
	const status =
		typeof err === "object" && err !== null
			? (err as { httpStatusCode?: unknown }).httpStatusCode
			: undefined;
	return typeof status === "number" ? status : undefined;
}

function isNotFound(err: unknown): boolean {
	return httpStatusOf(err) === 404;
}

export function createRegistrarProvider(deps: {
	prisma: AppPrismaClient;
	revealBitmovinAccount(
		accountId: string,
	): Promise<{ apiKey: string; tenantOrgId: string | null }>;
	/** Test seam: the SDK constructor. */
	makeApi?: (args: { apiKey: string; tenantOrgId?: string }) => BitmovinApi;
}): (bitmovinAccountId: string) => Promise<RegistrarProviderApi> {
	const makeApi =
		deps.makeApi ??
		((args) =>
			new BitmovinApi({
				apiKey: args.apiKey,
				...(args.tenantOrgId ? { tenantOrgId: args.tenantOrgId } : {}),
				fetch: registrarFetch(),
			}));
	return async (bitmovinAccountId) => {
		const account = await deps.revealBitmovinAccount(bitmovinAccountId);
		const api = makeApi({
			apiKey: account.apiKey,
			...(account.tenantOrgId ? { tenantOrgId: account.tenantOrgId } : {}),
		});
		// writeAuditLog never throws (an audit failure must not fail the call
		// it documents) — the same contract sdk-ops relies on.
		const audited = async <T>(
			method: string,
			path: string,
			request: unknown,
			call: () => Promise<T>,
			response: (result: T) => unknown,
		): Promise<T> => {
			const startedAt = Date.now();
			try {
				const result = await call();
				await writeAuditLog(deps.prisma, {
					actor: WEBHOOK_REGISTRAR_ACTOR,
					method,
					path,
					bitmovinAccountId,
					statusCode: 200,
					durationMs: Date.now() - startedAt,
					request,
					response: response(result),
				});
				return result;
			} catch (err) {
				await writeAuditLog(deps.prisma, {
					actor: WEBHOOK_REGISTRAR_ACTOR,
					method,
					path,
					bitmovinAccountId,
					statusCode: httpStatusOf(err),
					durationMs: Date.now() - startedAt,
					request,
					// SDK messages may include nested stringified request bodies.
					// Keep the typed status and operation path, never exception text.
					error: "Webhook provider operation failed",
				});
				throw err;
			}
		};
		return {
			async getHeartbeatEncodingVersion(encodingId) {
				return audited(
					"GET",
					`/encoding/encodings/${encodingId}`,
					undefined,
					() => api.encoding.encodings.get(encodingId),
					(result) => ({
						requested: result.encoderVersion,
						resolved: result.selectedEncoderVersion,
					}),
				).then((result) => ({
					requested: result.encoderVersion ?? null,
					resolved: result.selectedEncoderVersion ?? null,
				}));
			},
			async listEncodingHeartbeats(encodingId) {
				const result: {
					id: string;
					name?: string;
					url?: string;
					interval?: number;
				}[] = [];
				for (let offset = 0; ; offset += 100) {
					const page = await audited(
						"GET",
						`/notifications/webhooks/encoding/encodings/${encodingId}/live-encoding-heartbeat`,
						{ offset, limit: 100 },
						() =>
							api.notifications.webhooks.encoding.encodings.liveEncodingHeartbeat.listByEncodingId(
								encodingId,
								{ offset, limit: 100 },
							),
						(page) => ({ count: page.items?.length ?? 0 }),
					);
					for (const hook of page.items ?? [])
						if (hook.id)
							result.push({
								id: hook.id,
								name: hook.name,
								url: hook.url,
								interval: hook.interval,
							});
					if ((page.items?.length ?? 0) < 100) return result;
				}
			},
			async getEncodingHeartbeatCustomData(encodingId, webhookId) {
				return audited(
					"GET",
					`/notifications/webhooks/encoding/encodings/${encodingId}/live-encoding-heartbeat/${webhookId}/customData`,
					undefined,
					() =>
						api.notifications.webhooks.encoding.encodings.liveEncodingHeartbeat.customdata.getCustomDataByEncodingIdAndWebhookId(
							encodingId,
							webhookId,
						),
					() => ({ present: true }),
				).then((result) => result.customData);
			},
			async createEncodingHeartbeat(encodingId, payload) {
				const result = await audited(
					"POST",
					`/notifications/webhooks/encoding/encodings/${encodingId}/live-encoding-heartbeat`,
					{
						name: payload.name,
						interval: payload.interval,
						url: "[redacted]",
						signature: { type: "HMAC", key: "[redacted]" },
						customData: "[correlation]",
					},
					() =>
						api.notifications.webhooks.encoding.encodings.liveEncodingHeartbeat.createByEncodingId(
							encodingId,
							{
								...payload,
								signature: { ...payload.signature, type: SignatureType.HMAC },
								method: WebhookHttpMethod.POST,
								insecureSsl: false,
							},
						),
					(result) => ({ id: result.id }),
				);
				if (!result.id) throw new Error("provider returned no webhook id");
				return { id: result.id };
			},
			async removeEncodingHeartbeat(encodingId, webhookId) {
				try {
					await audited(
						"DELETE",
						`/notifications/webhooks/encoding/encodings/${encodingId}/live-encoding-heartbeat/${webhookId}`,
						undefined,
						() =>
							api.notifications.webhooks.encoding.encodings.liveEncodingHeartbeat.deleteByEncodingIdAndWebhookId(
								encodingId,
								webhookId,
							),
						() => ({ id: webhookId }),
					);
				} catch (error) {
					if (!isNotFound(error)) throw error;
				}
			},
			async create(encodingId, kind, payload) {
				const created = await audited(
					"POST",
					`/notifications/webhooks/encoding/encodings/${encodingId}/${kind}`,
					{ url: "[redacted]", signature: { type: "HMAC", key: "[redacted]" } },
					() =>
						perEncodingApi(api, kind).createByEncodingId(encodingId, payload),
					(result) => ({ id: result.id }),
				);
				if (!created.id) {
					throw new Error("provider returned no webhook id");
				}
				return { id: created.id };
			},
			async remove(encodingId, kind, webhookId) {
				try {
					await audited(
						"DELETE",
						`/notifications/webhooks/encoding/encodings/${encodingId}/${kind}/${webhookId}`,
						undefined,
						() =>
							perEncodingApi(api, kind).deleteByEncodingIdAndWebhookId(
								encodingId,
								webhookId,
							),
						() => ({ id: webhookId }),
					);
				} catch (err) {
					if (isNotFound(err)) {
						return;
					}
					throw err;
				}
			},
			async removeHeartbeat(webhookId) {
				try {
					await audited(
						"DELETE",
						`/notifications/webhooks/encoding/encodings/live-encoding-heartbeat/${webhookId}`,
						undefined,
						() => heartbeatApi(api).deleteByWebhookId(webhookId),
						() => ({ id: webhookId }),
					);
				} catch (err) {
					if (isNotFound(err)) {
						return;
					}
					throw err;
				}
			},
		};
	};
}

/** Unlike inert resources, each heartbeat POST starts recurring deliveries. */
export function registrarFetch(fetchImpl: typeof fetch = fetch) {
	const retrying = createRetryingFetch({
		fetchImpl: (url, init) => fetchImpl(url, init as RequestInit),
	});
	return (url: string, init?: unknown): Promise<Response> => {
		const method = (
			init as { method?: string } | undefined
		)?.method?.toUpperCase();
		if (
			method === "POST" &&
			/\/encodings\/[^/]+\/live-encoding-heartbeat(?:\?|$)/.test(url)
		)
			return fetchImpl(url, init as RequestInit);
		return retrying(url, init);
	};
}
