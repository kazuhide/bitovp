import "server-only";
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

/** URL form decoding tolerates literal percent signs from an earlier escape. */
function mayContainPublisherToken(
	value: string,
	publisherToken: string,
	formQuery = false,
): boolean {
	let candidates = new Set([value]);
	for (let pass = 0; pass <= MAX_PERCENT_DECODE_PASSES; pass++) {
		const next = new Set<string>();
		for (const candidate of candidates) {
			if (
				candidate.includes(publisherToken) ||
				(formQuery && candidate.replaceAll("+", " ").includes(publisherToken))
			)
				return true;
			if (!candidate.includes("%")) continue;

			// Use one value so existing separators are preserved. Within the
			// fixed depth, keep at most two variants per value. A percent-only
			// pass preserves literal plus; a form pass folds it before decoding.
			const field = candidate.replaceAll("&", "%26");
			const percentOnly = field.replaceAll("+", "%2B");
			const variants =
				formQuery && field !== percentOnly
					? [field, percentOnly]
					: [percentOnly];
			for (const variant of variants) {
				const decoded = new URLSearchParams(`value=${variant}`).get("value");
				if (decoded !== null && decoded !== candidate) next.add(decoded);
			}
		}
		if (next.size === 0) return false;
		candidates = next;
	}
	// The remaining nested escape could still carry a publishing capability.
	return true;
}

function queryMayContainPublisherToken(
	params: URLSearchParams,
	publisherToken: string,
): boolean {
	for (const [name, value] of params) {
		if (
			mayContainPublisherToken(name, publisherToken, true) ||
			mayContainPublisherToken(value, publisherToken, true)
		)
			return true;
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
				mayContainPublisherToken(authoredResource, publisherToken) ||
				decodeURIComponent(path).includes(publisherToken) ||
				(resolvedResource !== authoredResource &&
					mayContainPublisherToken(resolvedResource, publisherToken)) ||
				mayContainPublisherToken(url.search.slice(1), publisherToken, true) ||
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
