import type { SecretCipher } from "@bitovp/core";
import {
	type ResetCleanupAccount,
	revealResetCleanupAccount,
} from "@bitovp/db";
import { BitmovinApi } from "../bitmovin/sdk-ctor";
import type { ResetCleanupProvider } from "./cleanup";

type Hooks = {
	listByEncodingId(
		id: string,
		query: { offset: number; limit: number },
	): Promise<{ items?: { id?: string; url?: string }[] }>;
	list(query: {
		offset: number;
		limit: number;
	}): Promise<{ items?: { id?: string; url?: string }[] }>;
	deleteByEncodingIdAndWebhookId(id: string, hookId: string): Promise<unknown>;
	deleteByWebhookId(id: string): Promise<unknown>;
};
const is404 = (error: unknown) => {
	const candidate = error as {
		httpStatusCode?: number;
		errorCode?: number;
	} | null;
	return candidate?.httpStatusCode === 404 && candidate.errorCode === 1001;
};

export function resetCleanupProvider(
	cipher: SecretCipher,
	makeApi = (options: ConstructorParameters<typeof BitmovinApi>[0]) =>
		new BitmovinApi(options),
) {
	return async (
		account: ResetCleanupAccount,
	): Promise<ResetCleanupProvider> => {
		const auth = await revealResetCleanupAccount(cipher, account);
		const api = makeApi({
			apiKey: auth.apiKey,
			...(auth.tenantOrgId ? { tenantOrgId: auth.tenantOrgId } : {}),
		});
		const encodingAbsent = async (id: string) => {
			try {
				await api.encoding.encodings.get(id);
				return false;
			} catch (error) {
				if (!is404(error)) throw error;
				// A wrong tenant/denied account can mimic a missing resource.
				await api.encoding.encodings.list({ limit: 1 });
				return true;
			}
		};
		return {
			async status(id) {
				try {
					return String(
						(await api.encoding.encodings.status(id)).status ?? "UNKNOWN",
					);
				} catch (error) {
					if (is404(error) && (await encodingAbsent(id))) return "FINISHED";
					throw error;
				}
			},
			async stop(id) {
				try {
					const encoding = await api.encoding.encodings.get(id);
					if (encoding.type === "LIVE")
						await api.encoding.encodings.live.stop(id);
					else if (encoding.type === "VOD")
						await api.encoding.encodings.stop(id);
					else throw new Error("Reset cleanup encoding type unavailable");
				} catch (error) {
					if (!is404(error)) throw error;
				}
			},
			async releaseTemporaryKeys(encodingId) {
				const ids: string[] = [];
				for (let offset = 0; ; offset += 100) {
					const page = await api.encoding.live.streamKeys.list({
						type: "TEMPORARY",
						offset,
						limit: 100,
					});
					for (const key of page.items ?? [])
						if (key.id && key.assignedEncodingId === encodingId)
							ids.push(key.id);
					if ((page.items?.length ?? 0) < 100) break;
				}
				for (const id of ids)
					try {
						await api.encoding.live.streamKeys.delete(id);
					} catch (error) {
						if (!is404(error)) throw error;
					}
			},
			async removeWebhook(hook) {
				const groups = api.notifications.webhooks.encoding
					.encodings as unknown as Record<string, Hooks>;
				const hooks = groups[hook.kind];
				if (!hooks) return false;
				const accountLevel =
					hook.scope === "hb" && hook.encodingId.startsWith("account:");
				const remove = async (id: string) => {
					try {
						if (accountLevel) await hooks.deleteByWebhookId(id);
						else
							await hooks.deleteByEncodingIdAndWebhookId(hook.encodingId, id);
					} catch (error) {
						if (!is404(error)) throw error;
					}
				};
				const ownedIds = new Set<string>(hook.providerWebhookIds ?? []);
				if (hook.providerWebhookId) ownedIds.add(hook.providerWebhookId);
				// The complete token-bearing URL is the exact saved ownership marker.
				// No match is unresolved: a CREATE may still return after this scan.

				let listed = 0;
				for (let offset = 0; offset < 10_000; offset += 100) {
					const page = await (async () => {
						try {
							return accountLevel
								? await hooks.list({ offset, limit: 100 })
								: await hooks.listByEncodingId(hook.encodingId, {
										offset,
										limit: 100,
									});
						} catch (error) {
							if (
								!accountLevel &&
								is404(error) &&
								(await encodingAbsent(hook.encodingId))
							)
								return { items: [] };
							throw error;
						}
					})();
					listed += page.items?.length ?? 0;
					for (const item of page.items ?? []) {
						if (
							item.id &&
							item.url === hook.url &&
							typeof hook.url === "string" &&
							hook.url.length > 0
						) {
							ownedIds.add(item.id);
						}
					}
					if ((page.items?.length ?? 0) < 100) {
						// Complete pagination before DELETE, which otherwise shifts offsets.
						for (const id of ownedIds) await remove(id);
						if (ownedIds.size > 0) return true;
						if (listed !== 0 || hook.claimedUntil || accountLevel) return false;
						if (await encodingAbsent(hook.encodingId)) return true;
						const status = String(
							(await api.encoding.encodings.status(hook.encodingId)).status ??
								"UNKNOWN",
						);
						return ["FINISHED", "ERROR", "CANCELED"].includes(status);
					}
				}
				return false;
			},
		};
	};
}
