import "server-only";
import { z } from "zod";
import {
	PerTitleEncodingLoaderError,
	type PerTitleEncodingReadPort,
} from "./per-title-encoding-loader";
import { readBoundedBody } from "./request-body";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_RESPONSE_BYTES;
const uuid = z.uuid();
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

class PerTitleEncodingHttpError extends Error {
	constructor(readonly httpStatusCode: number) {
		super("Encoding settings are unavailable from Bitmovin");
		this.name = "PerTitleEncodingHttpError";
	}
}

/** Read original JSON so newer API settings are not erased by SDK model constructors. */
export function createPerTitleEncodingHttpPort(options: {
	apiKey: string;
	tenantOrgId?: string;
	signal: AbortSignal;
	fetch?: typeof fetch;
}): PerTitleEncodingReadPort {
	const { signal } = options;
	const transport = options.fetch ?? fetch;
	const headers = new Headers({
		"X-Api-Key": options.apiKey,
		Accept: "application/json",
		...(options.tenantOrgId ? { "X-Tenant-Org-Id": options.tenantOrgId } : {}),
	});
	let remaining = MAX_TOTAL_BYTES;
	const identifier = (value: string) => {
		const parsed = uuid.safeParse(value);
		if (!parsed.success)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		return parsed.data;
	};
	const get = async (
		path: string,
		page?: { limit: number; offset: number },
	): Promise<unknown> => {
		signal.throwIfAborted();
		if (remaining <= 0)
			throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
		const url = new URL(`https://api.bitmovin.com/v1${path}`);
		if (page) {
			url.searchParams.set("limit", String(page.limit));
			url.searchParams.set("offset", String(page.offset));
		}
		const response = await transport(url.href, {
			method: "GET",
			headers,
			signal,
			redirect: "error",
			cache: "no-store",
		});
		signal.throwIfAborted();
		if (!response.ok) {
			// Do not consume error bodies: they can contain reflected credentials or request details.
			void response.body?.cancel().catch(() => {});
			throw new PerTitleEncodingHttpError(response.status);
		}
		const bytes = await readBoundedBody(
			response,
			Math.min(MAX_RESPONSE_BYTES, remaining),
		);
		signal.throwIfAborted();
		if (bytes === null || bytes.byteLength > remaining)
			throw new PerTitleEncodingLoaderError("IMPORT_LIMIT_EXCEEDED");
		remaining -= bytes.byteLength;
		let envelope: unknown;
		try {
			envelope = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		}
		if (
			!object(envelope) ||
			envelope.status !== "SUCCESS" ||
			!object(envelope.data) ||
			!Object.hasOwn(envelope.data, "result")
		)
			throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
		return envelope.data.result;
	};
	const video = (codec: string) => ({
		get: (id: string) =>
			get(`/encoding/configurations/video/${codec}/${identifier(id)}`),
	});
	return {
		encoding: {
			encodings: {
				getStartRequest: async (id) =>
					get(`/encoding/encodings/${identifier(id)}/start`),
				streams: {
					list: async (id, page) => {
						const result = await get(
							`/encoding/encodings/${identifier(id)}/streams`,
							page,
						);
						if (
							!object(result) ||
							!Array.isArray(result.items) ||
							(result.totalCount !== undefined &&
								typeof result.totalCount !== "number")
						)
							throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
						return {
							items: result.items,
							...(result.totalCount !== undefined
								? { totalCount: result.totalCount }
								: {}),
						};
					},
				},
			},
			configurations: {
				type: {
					get: async (id) => {
						const result = await get(
							`/encoding/configurations/${identifier(id)}/type`,
						);
						if (!object(result))
							throw new PerTitleEncodingLoaderError("UPSTREAM_UNAVAILABLE");
						return { type: result.type };
					},
				},
				video: {
					h264: video("h264"),
					h265: video("h265"),
					h265v2: video("h265v2"),
					vp9: video("vp9"),
					av1: video("av1"),
				},
			},
		},
	};
}
