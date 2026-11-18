import { describe, expect, it } from "vitest";
import { redactSecrets } from "../crypto/redact";
import { bucketAddressing } from "./addressing";
import { providersForIoKind } from "./io-kind-providers";
import {
	CREDENTIAL_PROVIDER_BROWSABLE,
	CREDENTIAL_PROVIDER_GROUP,
	createCredentialSchema,
	updateCredentialSchema,
} from "./schemas";

const credential = {
	provider: "MOQ",
	label: "Test relay",
	config: {},
	secret: { relayUrl: "moqt://relay.example:443/moq" },
};

describe("MoQ relay credentials", () => {
	it.each([
		[8192, true],
		[8193, false],
		[16384, false],
	])("keeps subscriber URL length %i consistent with the Player boundary", (length, accepted) => {
		const prefix = "https://subscribe.example/moq?token=";
		const playbackUrl = prefix + "s".repeat(Number(length) - prefix.length);
		const input = {
			...credential,
			secret: { ...credential.secret, playbackUrl },
		};
		expect(createCredentialSchema.safeParse(input).success).toBe(accepted);
		expect(
			updateCredentialSchema("MOQ").safeParse({ secret: input.secret }).success,
		).toBe(accepted);
	});
	it("accepts a relay without authentication and preserves optional token settings", () => {
		expect(createCredentialSchema.parse(credential)).toEqual(credential);
		const authenticated = {
			...credential,
			secret: {
				...credential.secret,
				authToken: "test-token",
				authTokenType: 1,
			},
		};
		expect(createCredentialSchema.parse(authenticated)).toEqual(authenticated);
		expect(
			updateCredentialSchema("MOQ").parse({ secret: authenticated.secret }),
		).toEqual({ secret: authenticated.secret });
	});

	it.each([
		"https://relay.example/moq",
		"moqt:///missing-host",
		"moqt://user:pass@relay.example/",
		"moqt://relay.example/?token=private",
		"moqt://relay.example/?",
		"moqt://relay.example/#msf:channel&c4m=private",
		"moqt://relay.example/#",
		"moqt://relay.example:99999/",
		"moqt://relay.example:0/",
		" moqt://relay.example/",
		"moqt://relay.example/\n",
	])("rejects an unsafe or malformed relay URL: %s", (relayUrl) => {
		expect(
			createCredentialSchema.safeParse({
				...credential,
				secret: { relayUrl },
			}).success,
		).toBe(false);
	});

	it.each([
		{ authTokenType: 1 },
		{ authToken: "" },
		{ authToken: "token", authTokenType: -1 },
		{ authToken: "token", authTokenType: 0.5 },
		{ authToken: "token", authTokenType: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects invalid authentication settings: %j", (auth) => {
		expect(
			createCredentialSchema.safeParse({
				...credential,
				secret: { ...credential.secret, ...auth },
			}).success,
		).toBe(false);
	});

	it("rejects secret fields in config and unknown secret fields instead of stripping them", () => {
		expect(
			createCredentialSchema.safeParse({
				...credential,
				config: { authToken: "misplaced-token" },
			}).success,
		).toBe(false);
		expect(
			createCredentialSchema.safeParse({
				...credential,
				secret: { ...credential.secret, token: "misspelled-token" },
			}).success,
		).toBe(false);
	});

	it("classifies MOQ as a delivery destination with no storage browser/address", () => {
		expect(CREDENTIAL_PROVIDER_GROUP.MOQ).toBe("STORAGE");
		expect(CREDENTIAL_PROVIDER_BROWSABLE.MOQ).toBe(false);
		expect(providersForIoKind("MOQ")).toEqual(["MOQ"]);
		expect(bucketAddressing("MOQ", {})).toBeNull();
	});

	it("redacts relay endpoints and tokens if a secret object reaches an audit snapshot", () => {
		expect(
			redactSecrets({
				relayUrl: credential.secret.relayUrl,
				authToken: "private-token",
				authTokenType: 1,
			}),
		).toEqual({
			relayUrl: "[REDACTED]",
			authToken: "[REDACTED]",
			authTokenType: 1,
		});
	});

	it("keeps an independent subscribe-only playback URL in the encrypted secret", () => {
		const playbackUrl =
			"https://subscribe.example/moq/subscribe-only?token=private";
		const input = {
			...credential,
			secret: { ...credential.secret, playbackUrl },
		};
		expect(createCredentialSchema.parse(input)).toEqual(input);
		expect(
			updateCredentialSchema("MOQ").parse({ secret: input.secret }),
		).toEqual({
			secret: input.secret,
		});
		expect(redactSecrets({ playbackUrl })).toEqual({
			playbackUrl: "[REDACTED]",
		});
	});

	it.each([
		"http://subscribe.example/moq",
		"moqt://subscribe.example/moq",
		"https://user:password@subscribe.example/moq",
		"https://subscribe.example/moq#private",
		"https://subscribe.example/moq#",
		" https://subscribe.example/moq",
		"https://subscribe.example/moq\n",
		"https://subscribe.example/moq?token=unescaped space",
	])("rejects an invalid playback URL: %s", (playbackUrl) => {
		expect(
			createCredentialSchema.safeParse({
				...credential,
				secret: { ...credential.secret, playbackUrl },
			}).success,
		).toBe(false);
	});
});
