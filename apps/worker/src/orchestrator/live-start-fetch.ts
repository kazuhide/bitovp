import { AsyncLocalStorage } from "node:async_hooks";
import type { SdkFetch } from "./retrying-fetch";

const FIELDS = ["dashManifestInterval", "muxingInitFileInterval"] as const;
type ReuploadSettings = Partial<Record<(typeof FIELDS)[number], number | null>>;

/** Restore the explicit nulls that the SDK's RestClient removes from JSON. */
export function createLiveStartFetch(base: SdkFetch) {
	const context = new AsyncLocalStorage<{
		encodingId: string;
		fields: (typeof FIELDS)[number][];
	}>();
	const fetch: SdkFetch = async (url, init) => {
		const current = context.getStore();
		if (!current?.fields.length) return base(url, init);
		const request = init as RequestInit | undefined;
		const target = new URL(url);
		const prefix = `/v1/encoding/encodings/${encodeURIComponent(current.encodingId)}/live/`;
		if (
			target.origin !== "https://api.bitmovin.com" ||
			request?.method !== "POST" ||
			![`${prefix}start`, `${prefix}hd/start`].includes(target.pathname)
		)
			return base(url, init);
		if (typeof request.body !== "string")
			throw new Error("Live START requires a serialized JSON body");
		const body = JSON.parse(request.body);
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			!body.reuploadSettings ||
			typeof body.reuploadSettings !== "object" ||
			Array.isArray(body.reuploadSettings)
		)
			throw new Error("Live START is missing its reupload settings");
		for (const field of current.fields) body.reuploadSettings[field] = null;
		return base(url, { ...request, body: JSON.stringify(body) });
	};
	return {
		fetch,
		run: <T>(
			encodingId: string,
			settings: ReuploadSettings | undefined,
			action: () => Promise<T>,
		) =>
			context.run(
				{
					encodingId,
					fields: FIELDS.filter((field) => settings?.[field] === null),
				},
				action,
			),
	};
}
