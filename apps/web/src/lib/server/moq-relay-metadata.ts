import "server-only";
import { toUSVString } from "node:util";
import { z } from "zod";

const MAX_MOQ_URL_LENGTH = 8_192;
const MAX_PERCENT_DECODE_PASSES = 4;

const CLOUDFLARE_ORIGINS = [
	"https://draft-16.cloudflare.mediaoverquic.com",
	"https://draft-18.cloudflare.mediaoverquic.com",
] as const;
const claimsSchema = z.object({
	iss: z.literal("cloudflare"),
	aud: z.literal("moq.cloudflare.com"),
	sub: z.string().regex(/^[0-9a-f]{32}$/),
	exp: z.number().int().nonnegative().max(253_402_300_799),
	operations: z.tuple([z.literal("subscribe")]),
});
const headerSchema = z.object({
	alg: z.literal("EdDSA"),
	typ: z.literal("JWT"),
});

type RelayMetadata = {
	provider: "cloudflare";
	endpointOrigin: (typeof CLOUDFLARE_ORIGINS)[number];
	configuredRelayId: string;
	tokenExpiresAt: string;
	tokenOperations: ["subscribe"];
	metadataSource: "unverified-token-claims";
};
type Inspection =
	| { kind: "other" }
	| { kind: "invalid" }
	| { kind: "cloudflare"; relay: RelayMetadata };

function jsonPart(part: string, maxBytes: number): unknown {
	if (part.length > Math.ceil((maxBytes * 4) / 3))
		throw new Error("Invalid JWT");
	const bytes = Buffer.from(part, "base64url");
	if (bytes.length > maxBytes || bytes.toString("base64url") !== part)
		throw new Error("Invalid JWT");
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Enumerate URL decoding variants within the percent-decoding depth budget. */
function componentVariants(
	value: string,
	formQuery: boolean,
): Set<string> | null {
	const seen = new Set<string>();
	// URL parsers coerce to Unicode scalar values, while the descriptor can
	// retain the original string. Account for both before decoding.
	let frontier = new Set([value, toUSVString(value)]);
	for (let pass = 0; pass <= MAX_PERCENT_DECODE_PASSES; pass++) {
		const layer = new Set(frontier);
		if (formQuery) {
			// Form decoding folds literal plus before percent decoding. Retain
			// both spellings at this layer, including any remaining escapes.
			for (const candidate of frontier) {
				layer.add(candidate.replaceAll("+", " "));
			}
		}
		for (const candidate of layer) seen.add(candidate);

		const next = new Set<string>();
		for (const candidate of layer) {
			if (!candidate.includes("%")) continue;
			// Read a single value, preserving literal separators and plus.
			const field = candidate.replaceAll("&", "%26").replaceAll("+", "%2B");
			const decoded = new URLSearchParams(`value=${field}`).get("value");
			if (decoded !== null && !seen.has(decoded)) next.add(decoded);
		}
		if (!next.size) return seen;
		if (pass === MAX_PERCENT_DECODE_PASSES) return null;
		frontier = next;
	}
	return null;
}

function resourceMayContainPublisherToken(
	resource: string,
	publisherToken: string,
): boolean {
	const delimiter = resource.indexOf("?");
	const path = delimiter === -1 ? resource : resource.slice(0, delimiter);
	const query = delimiter === -1 ? "" : resource.slice(delimiter);
	const paths = componentVariants(path, false);
	const queries = componentVariants(query, true);
	if (!paths || !queries) return true;
	// Preserve the separator and apply form decoding only to query data.
	for (const prefix of paths) {
		for (const suffix of queries) {
			if ((prefix + suffix).includes(publisherToken)) return true;
		}
	}
	return false;
}

function queryMayContainPublisherToken(
	params: URLSearchParams,
	publisherToken: string,
): boolean {
	for (const [name, value] of params) {
		for (const part of [name, value]) {
			const variants = componentVariants(part, true);
			if (
				!variants ||
				[...variants].some((value) => value.includes(publisherToken))
			)
				return true;
		}
	}
	return false;
}

/** Local configured metadata only. The relay verifies the JWT signature and
 * enforces authorization; these unsigned claims grant no application access. */
export function inspectMoqRelayMetadata(
	playbackUrl: string,
	publisherToken?: string,
): Inspection {
	try {
		if (publisherToken && playbackUrl.length > MAX_MOQ_URL_LENGTH)
			return { kind: "invalid" };
		const url = new URL(playbackUrl);
		if (publisherToken) {
			// The descriptor can preserve authored path segments that parsing
			// resolves away. Compare the resource components of both forms.
			const authoredResource = playbackUrl.replace(
				/^https:[/\\]*[^/\\?#]*/i,
				"",
			);
			const path = url.pathname;
			const resolvedResource = path + url.search;
			if (
				resourceMayContainPublisherToken(authoredResource, publisherToken) ||
				decodeURIComponent(path).includes(publisherToken) ||
				(resolvedResource !== authoredResource &&
					resourceMayContainPublisherToken(resolvedResource, publisherToken)) ||
				queryMayContainPublisherToken(url.searchParams, publisherToken)
			)
				return { kind: "invalid" };
		}
		const endpointOrigin = CLOUDFLARE_ORIGINS.find(
			(origin) => origin === url.origin,
		);
		if (!endpointOrigin) return { kind: "other" };
		if (url.username || url.password || url.search || url.hash)
			return { kind: "invalid" };
		const token = url.pathname.slice(1);
		if (token.length > MAX_MOQ_URL_LENGTH) return { kind: "invalid" };
		const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
			token,
		);
		if (!parts) return { kind: "invalid" };
		const [, header, payload, signature] = parts;
		if (!header || !payload || !signature) return { kind: "invalid" };
		const signatureBytes = Buffer.from(signature, "base64url");
		if (
			signatureBytes.length !== 64 ||
			signatureBytes.toString("base64url") !== signature
		)
			return { kind: "invalid" };
		headerSchema.parse(jsonPart(header, 512));
		const claims = claimsSchema.parse(jsonPart(payload, 4_096));
		return {
			kind: "cloudflare",
			relay: {
				provider: "cloudflare",
				endpointOrigin,
				configuredRelayId: claims.sub,
				tokenExpiresAt: new Date(claims.exp * 1_000).toISOString(),
				tokenOperations: ["subscribe"],
				metadataSource: "unverified-token-claims",
			},
		};
	} catch {
		return { kind: "invalid" };
	}
}
