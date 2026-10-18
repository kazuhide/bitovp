import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeWebhookSignature, verifyWebhookSignature } from "./signature";

const secret = "webhook-secret";
const body = '{"type":"ENCODING_FINISHED","id":"abc"}';
const validSignature = createHmac("sha512", secret).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
	it("accepts the matching HMAC-SHA512 hex digest", () => {
		expect(verifyWebhookSignature(body, validSignature, secret)).toBe(true);
	});

	it("accepts uppercase hex and surrounding whitespace", () => {
		expect(
			verifyWebhookSignature(body, ` ${validSignature.toUpperCase()} `, secret),
		).toBe(true);
	});

	it("rejects missing, truncated, and tampered signatures", () => {
		expect(verifyWebhookSignature(body, null, secret)).toBe(false);
		expect(
			verifyWebhookSignature(body, validSignature.slice(0, -2), secret),
		).toBe(false);
		const tampered = `${validSignature.slice(0, -1)}${
			validSignature.endsWith("0") ? "1" : "0"
		}`;
		expect(verifyWebhookSignature(body, tampered, secret)).toBe(false);
	});

	it("rejects a signature computed over a different body", () => {
		expect(
			verifyWebhookSignature('{"type":"OTHER"}', validSignature, secret),
		).toBe(false);
	});

	it("computeWebhookSignature matches node crypto directly", () => {
		expect(computeWebhookSignature(body, secret)).toBe(validSignature);
	});

	it("accepts the base64 encoding of the same digest — the wire encoding is undocumented until X0", () => {
		const base64 = createHmac("sha512", secret).update(body).digest("base64");
		expect(base64).toHaveLength(88);
		expect(verifyWebhookSignature(body, base64, secret)).toBe(true);
		expect(verifyWebhookSignature(body, ` ${base64} `, secret)).toBe(true);
		// The wrong body, and the digest of another secret, still fail in base64.
		expect(verifyWebhookSignature('{"type":"OTHER"}', base64, secret)).toBe(
			false,
		);
		expect(
			verifyWebhookSignature(
				body,
				createHmac("sha512", "other").update(body).digest("base64"),
				secret,
			),
		).toBe(false);
	});

	it("rejects encodings of the wrong length and mixed shapes rather than decoding leniently", () => {
		// base64url (no padding) is NOT accepted — Buffer.from would silently
		// skip the unknown characters; the shape check refuses first.
		const url = createHmac("sha512", secret).update(body).digest("base64url");
		expect(verifyWebhookSignature(body, url, secret)).toBe(false);
		// A 64-byte digest of another algorithm's length (SHA-256 hex = 64 chars).
		expect(
			verifyWebhookSignature(body, validSignature.slice(0, 64), secret),
		).toBe(false);
	});
});
