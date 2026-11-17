import { describe, expect, it } from "vitest";
import { inspectMoqRelayMetadata } from "./moq-relay-metadata";

const origin = "https://draft-18.cloudflare.mediaoverquic.com";
const relayId = "0123456789abcdef0123456789abcdef";
const claims = () => ({
	iss: "cloudflare",
	aud: "moq.cloudflare.com",
	sub: relayId,
	exp: 1_893_456_000,
	iat: 1_763_337_600,
	jti: "token-id-must-stay-private",
	operations: ["subscribe"],
});
const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (
	payload: unknown = claims(),
	header: unknown = { alg: "EdDSA", typ: "JWT", kid: "private-key-id" },
) =>
	`${encode(header)}.${encode(payload)}.${Buffer.alloc(64, 1).toString("base64url")}`;

describe("configured Cloudflare MoQ relay metadata", () => {
	it.each([
		16, 18,
	])("projects only bounded unsigned token metadata for draft %i", (draft) => {
		const endpointOrigin = `https://draft-${draft}.cloudflare.mediaoverquic.com`;
		// The deliberately fake signature proves this is a local shape projection,
		// never a signature-verification or relay-connectivity assertion.
		expect(inspectMoqRelayMetadata(`${endpointOrigin}/${jwt()}`)).toEqual({
			kind: "cloudflare",
			relay: {
				provider: "cloudflare",
				endpointOrigin,
				configuredRelayId: relayId,
				tokenExpiresAt: "2030-01-01T00:00:00.000Z",
				tokenOperations: ["subscribe"],
				metadataSource: "unverified-token-claims",
			},
		});
	});

	it.each([
		"https://relay.example/private-token",
		`https://draft-23.cloudflare.mediaoverquic.com/${jwt()}`,
		`https://draft-18.cloudflare.mediaoverquic.com.attacker.example/${jwt()}`,
		`https://draft-18.cloudflare.mediaoverquic.com:444/${jwt()}`,
	])("does not guess metadata for other origins: %s", (url) => {
		expect(inspectMoqRelayMetadata(url)).toEqual({ kind: "other" });
	});

	it.each([
		{ operations: ["publish"] },
		{ operations: ["publish", "subscribe"] },
		{ operations: ["subscribe", "subscribe"] },
		{ operations: ["subscribe", "unknown"] },
		{ operations: "subscribe" },
		{ operations: [] },
		{ sub: "00000000-0000-4000-8000-000000000001" },
		{ sub: "F".repeat(32) },
		{ sub: "x".repeat(10_000) },
		{ exp: "2030-01-01T00:00:00Z" },
		{ exp: -1 },
		{ exp: 1.5 },
		{ exp: Number.MAX_SAFE_INTEGER },
		{ aud: "other-service" },
		{ iss: "other-issuer" },
	])("rejects malformed or overprivileged known-Cloudflare claims", (override) => {
		expect(
			inspectMoqRelayMetadata(`${origin}/${jwt({ ...claims(), ...override })}`),
		).toEqual({ kind: "invalid" });
	});

	it.each([
		"not-a-jwt",
		"a".repeat(9_000),
		`${encode({ alg: "EdDSA", typ: "JWT" })}.not-json.signature`,
		`${encode({ alg: "EdDSA", typ: "JWT" })}.${Buffer.from("{ invalid json").toString("base64url")}.${Buffer.alloc(64, 1).toString("base64url")}`,
		jwt(null),
		jwt([]),
		jwt(claims(), { alg: "none", typ: "JWT" }),
		jwt(claims(), { alg: "EdDSA", typ: "JWT", kid: "x".repeat(1_000) }),
		jwt({ ...claims(), ignored: "x".repeat(5_000) }),
		`${jwt()}/second-component`,
		`${jwt()}?token=another-token`,
	])("rejects malformed known-Cloudflare token input", (path) => {
		expect(inspectMoqRelayMetadata(`${origin}/${path}`)).toEqual({
			kind: "invalid",
		});
	});
});
