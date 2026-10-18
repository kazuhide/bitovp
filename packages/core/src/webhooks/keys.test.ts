import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	deriveScopedToken,
	deriveWebhookKey,
	isWebhookScope,
	isWebhookToken,
	newWebhookToken,
	WEBHOOK_SCOPES,
	webhookReceiverPath,
	webhookTokenEquals,
} from "./keys";
import { verifyWebhookSignature } from "./signature";

const MASTER =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("webhook tokens", () => {
	it("newWebhookToken is 22 base64url chars, unique per call, and validates", () => {
		const a = newWebhookToken();
		const b = newWebhookToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(a).not.toBe(b);
		expect(isWebhookToken(a)).toBe(true);
	});

	it("isWebhookToken refuses the shapes a URL could carry instead", () => {
		expect(isWebhookToken("")).toBe(false);
		expect(isWebhookToken("abc")).toBe(false);
		expect(isWebhookToken("a".repeat(23))).toBe(false);
		// base64 (not url-safe) alphabet and path characters.
		expect(isWebhookToken(`${"a".repeat(21)}+`)).toBe(false);
		expect(isWebhookToken(`${"a".repeat(21)}/`)).toBe(false);
		expect(isWebhookToken(`${"a".repeat(21)}.`)).toBe(false);
	});

	it("isWebhookScope admits exactly j / hb / acct", () => {
		for (const scope of WEBHOOK_SCOPES) {
			expect(isWebhookScope(scope)).toBe(true);
		}
		expect(isWebhookScope("job")).toBe(false);
		expect(isWebhookScope("")).toBe(false);
	});

	it("webhookTokenEquals is exact and length-safe", () => {
		const token = newWebhookToken();
		expect(webhookTokenEquals(token, token)).toBe(true);
		expect(webhookTokenEquals(token, newWebhookToken())).toBe(false);
		expect(webhookTokenEquals(token, token.slice(0, 21))).toBe(false);
	});
});

describe("deriveWebhookKey", () => {
	it("same master + same token ⇒ the same key (the receiver recomputes what was registered)", () => {
		const token = newWebhookToken();
		expect(deriveWebhookKey(MASTER, token)).toBe(
			deriveWebhookKey(MASTER, token),
		);
		expect(deriveWebhookKey(Buffer.from(MASTER, "utf8"), token)).toBe(
			deriveWebhookKey(MASTER, token),
		);
	});

	it("two tokens ⇒ two unrelated keys; two masters ⇒ two keys for one token", () => {
		const a = newWebhookToken();
		const b = newWebhookToken();
		expect(deriveWebhookKey(MASTER, a)).not.toBe(deriveWebhookKey(MASTER, b));
		expect(deriveWebhookKey(MASTER, a)).not.toBe(
			deriveWebhookKey(`${MASTER}x`, a),
		);
	});

	it("is 32 bytes of hex and a signature made with it verifies through the receiver's verifier", () => {
		const token = newWebhookToken();
		const key = deriveWebhookKey(MASTER, token);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		// What Bitmovin does with `signature.key`: HMAC-SHA512 over the body.
		const body = '{"type":"ENCODING_FINISHED"}';
		const header = createHmac("sha512", key).update(body).digest("hex");
		expect(verifyWebhookSignature(body, header, key)).toBe(true);
		expect(
			verifyWebhookSignature(
				body,
				header,
				deriveWebhookKey(MASTER, "b".repeat(22)),
			),
		).toBe(false);
	});

	it("refuses a malformed token and an empty master", () => {
		expect(() => deriveWebhookKey(MASTER, "short")).toThrow(/malformed token/);
		expect(() => deriveWebhookKey("", newWebhookToken())).toThrow(
			/must not be empty/,
		);
	});
});

describe("deriveScopedToken", () => {
	it("is stable per master+scope, differs across scopes and masters, and is a valid token", () => {
		const acct = deriveScopedToken(MASTER, "acct");
		expect(acct).toBe(deriveScopedToken(MASTER, "acct"));
		expect(isWebhookToken(acct)).toBe(true);
		expect(deriveScopedToken(MASTER, "hb")).not.toBe(acct);
		expect(deriveScopedToken(`${MASTER}x`, "acct")).not.toBe(acct);
	});

	it("a scoped token's key is the ordinary derivation — one verifier for every scope", () => {
		const token = deriveScopedToken(MASTER, "hb");
		expect(deriveWebhookKey(MASTER, token)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("webhookReceiverPath", () => {
	it("builds /api/webhooks/bitmovin/<scope>/<token> and refuses a bad token", () => {
		const token = newWebhookToken();
		expect(webhookReceiverPath("j", token)).toBe(
			`/api/webhooks/bitmovin/j/${token}`,
		);
		expect(() => webhookReceiverPath("j", "../x")).toThrow(/malformed token/);
	});
});
