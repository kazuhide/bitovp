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

describe("publisher credentials in subscriber URLs", () => {
	const relay = "https://relay.example";
	const publisher = "publisher+scope";
	const encoded = encodeURIComponent(publisher);
	const nested = encodeURIComponent(encoded);

	it.each([
		`${relay}/subscriber;${publisher};live`,
		`${relay}/subscriber;${encoded};live`,
		`${relay}/subscriber?${encoded}=preview`,
		`${relay}/subscriber?capability=preview%2C${nested}%2Clive`,
		`${relay}/retired-${publisher}/../subscriber`,
		`${relay}/subscriber?capability=preview%2Cpublisher%${"25".repeat(24)}2Bscope%2Clive`,
	])("refuses publisher material in raw or normalized URL components (%#)", (url) => {
		expect(inspectMoqRelayMetadata(url, publisher)).toEqual({
			kind: "invalid",
		});
	});

	it.each([
		"/",
		"\\",
	])("checks a leading resource separator in an authored path segment removed by normalization (%#)", (separator) => {
		const publisherToken = `${separator}publisher-scope`;
		const url = `${relay}/${publisherToken}/../subscriber`;
		expect(new URL(url).pathname).toBe("//subscriber");
		expect(inspectMoqRelayMetadata(url, publisherToken)).toEqual({
			kind: "invalid",
		});
	});

	it("checks an escaped publisher token that begins at the canonical path separator", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/publish%65r-scope/subscriber`,
				"/publisher-scope",
			),
		).toEqual({ kind: "invalid" });
	});

	it("checks form-style query values without folding a path’s literal plus", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/subscriber?capability=preview%3Apublisher+scope`,
				"publisher scope",
			),
		).toEqual({ kind: "invalid" });
		expect(
			inspectMoqRelayMetadata(`${relay}/publisher+scope`, "publisher scope"),
		).toEqual({ kind: "other" });
	});

	it.each([
		`${relay}/subscriber?capability=preview+relay+issuer%2Bscope`,
		`${relay}/subscriber?preview+relay+issuer%2Bscope=subscribe`,
		`${relay}/subscriber?capability=${encodeURIComponent("preview+relay+issuer%2Bscope")}`,
	])("checks simultaneous query space and literal plus decoding at each layer (%#)", (url) => {
		expect(inspectMoqRelayMetadata(url, "relay issuer+scope")).toEqual({
			kind: "invalid",
		});
	});

	it("continues checking escapes remaining after a nested form layer", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/subscriber?capability=preview%3Arelay%2Bissuer%252Bscope%252520unit`,
				"relay issuer+scope unit",
			),
		).toEqual({ kind: "invalid" });
	});

	it.each([
		"h",
		"https",
		"test",
		"443",
	])("treats fixed HTTPS authority text as part of an independent endpoint (%s)", (publisherToken) => {
		expect(
			inspectMoqRelayMetadata(
				"https://subscriber.example.test:443/preview",
				publisherToken,
			),
		).toEqual({ kind: "other" });
	});

	it.each([
		["?capability=preview+plus%2Bscope", "?capability=preview plus+scope"],
		[
			"?capability=preview+plus%2Bscope",
			"/subscriber?capability=preview plus+scope",
		],
	])("checks a publisher token across the form query separator", (query, token) => {
		expect(
			inspectMoqRelayMetadata(`${relay}/subscriber${query}`, token),
		).toEqual({
			kind: "invalid",
		});
	});

	it("checks the query spelling after folding plus without decoding percent escapes", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/subscriber?capability=issuer+%2Bscope`,
				"issuer %2Bscope",
			),
		).toEqual({ kind: "invalid" });
	});

	it("does not consume percent depth when folding a fully decoded query", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/subscriber?filter=%2525252B`,
				publisher,
			),
		).toEqual({ kind: "other" });
	});

	it("checks a Unicode scalar conversion across the authored resource", () => {
		const resource = "/retired/../subscriber?capability=issuer+";
		const malformedScalar = String.fromCharCode(0xd800);
		const convertedScalar = String.fromCharCode(0xfffd);
		const authToken = resource.replace("+", " ") + convertedScalar;
		expect(
			inspectMoqRelayMetadata(relay + resource + malformedScalar, authToken),
		).toEqual({ kind: "invalid" });
	});

	it("preserves genuinely separate credentials and normal URL encoding", () => {
		expect(
			inspectMoqRelayMetadata(
				`${relay}/subscriber%25tag?filter=a%26b&track=preview%2Bstereo`,
				publisher,
			),
		).toEqual({ kind: "other" });
		expect(
			inspectMoqRelayMetadata(`${origin}/${jwt()}`, publisher),
		).toMatchObject({ kind: "cloudflare" });
	});
});
