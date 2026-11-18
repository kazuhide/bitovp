import "server-only";
import { z } from "zod";

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

/** Local configured metadata only. The relay verifies the JWT signature and
 * enforces authorization; these unsigned claims grant no application access. */
export function inspectMoqRelayMetadata(
	playbackUrl: string,
	publisherToken?: string,
): Inspection {
	try {
		const url = new URL(playbackUrl);
		if (
			publisherToken &&
			[
				...url.pathname.split("/").map(decodeURIComponent),
				...url.searchParams.values(),
			].includes(publisherToken)
		)
			return { kind: "invalid" };
		const endpointOrigin = CLOUDFLARE_ORIGINS.find(
			(origin) => origin === url.origin,
		);
		if (!endpointOrigin) return { kind: "other" };
		if (url.username || url.password || url.search || url.hash)
			return { kind: "invalid" };
		const token = url.pathname.slice(1);
		if (token.length > 8_192) return { kind: "invalid" };
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
