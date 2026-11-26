import type BitmovinApi from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

const MAX_ITEMS = 10_000;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 15_000;
const querySchema = z.object({ bitmovinAccountId: z.uuid() });

// SDK 1.288.0: EncodingErrorDefinition + ErrorRetryHint. Unknown future hints
// remain informational; none of these definitions authorizes a retry.
const definitionSchema = z.object({
	code: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	category: z.string().max(500).optional(),
	message: z.string().max(4_000).optional(),
	description: z.string().max(16_000).optional(),
	retryHint: z.string().max(100).optional(),
});
const pageSchema = z.object({
	totalCount: z.number().int().min(0).max(MAX_ITEMS),
	offset: z.number().int().nonnegative().optional(),
	items: z.array(definitionSchema).max(PAGE_SIZE),
});

class InvalidCatalogueError extends Error {}

const responseSchema = z.object({ data: z.object({ result: pageSchema }) });

async function validateProviderResponse(_url: string, response: Response) {
	if (!response.ok) return;
	// The SDK maps absent/null/falsy `items` to [], losing evidence that the
	// response is incomplete. Validate the original JSON before model mapping.
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		throw new InvalidCatalogueError();
	}
	if (!responseSchema.safeParse(body).success)
		throw new InvalidCatalogueError();
}

/** A complete, validated catalogue, never a truncated page labelled as complete. */
async function readCatalogue(api: BitmovinApi, signal: AbortSignal) {
	const items: z.infer<typeof definitionSchema>[] = [];
	const codes = new Set<number>();
	let totalCount: number | undefined;
	for (let pageNumber = 0; pageNumber < MAX_ITEMS / PAGE_SIZE; pageNumber++) {
		signal.throwIfAborted();
		const offset = items.length;
		const result = pageSchema.safeParse(
			await api.encoding.errorDefinitions.list({ limit: PAGE_SIZE, offset }),
		);
		signal.throwIfAborted();
		if (!result.success) throw new InvalidCatalogueError();
		const page = result.data;
		if (
			(page.offset !== undefined && page.offset !== offset) ||
			(totalCount !== undefined && totalCount !== page.totalCount) ||
			offset + page.items.length > page.totalCount ||
			(page.items.length === 0 && offset < page.totalCount)
		) {
			throw new InvalidCatalogueError();
		}
		totalCount = page.totalCount;
		for (const item of page.items) {
			if (codes.has(item.code)) throw new InvalidCatalogueError();
			codes.add(item.code);
			items.push(item);
		}
		if (items.length === totalCount) return { items, totalCount };
	}
	throw new InvalidCatalogueError();
}

/** GET catalogue only; account lookup and decryption stay tenant-scoped. */
export async function GET(req: Request) {
	const query = querySchema.safeParse({
		bitmovinAccountId: new URL(req.url).searchParams.get("bitmovinAccountId"),
	});
	if (!query.success) return validationError(query.error);
	try {
		const ctx = await getServerContext();
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
		const signal = AbortSignal.any([req.signal, timeout.signal]);
		let invalidResponse = false;
		try {
			signal.throwIfAborted();
			const api = await bitmovinClientForAccount(
				ctx,
				query.data.bitmovinAccountId,
				signal,
				async (url, response) => {
					try {
						await validateProviderResponse(url, response);
					} catch (err) {
						// The SDK wraps transport errors. Preserve our rejection reason
						// without relying on its internal error/cause representation.
						invalidResponse = true;
						throw err;
					}
				},
			);
			if (!api) return jsonError(404, "Bitmovin account not found");
			try {
				const result = await readCatalogue(api, signal);
				return NextResponse.json(result, {
					headers: { "Cache-Control": "private, no-store" },
				});
			} catch (err) {
				if (signal.aborted) throw err;
				if (invalidResponse || err instanceof InvalidCatalogueError) {
					return jsonError(
						502,
						"Invalid encoding error catalogue from Bitmovin",
					);
				}
				return bitmovinProxyError(err);
			}
		} catch (err) {
			if (req.signal.aborted) return jsonError(499, "Request cancelled");
			if (timeout.signal.aborted) {
				return jsonError(504, "Encoding error catalogue request timed out");
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		// Local auth, storage and crypto errors are not upstream API failures.
		return routeError(err);
	}
}
