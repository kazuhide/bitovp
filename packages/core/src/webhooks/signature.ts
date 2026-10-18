import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Bitmovin signs webhook deliveries with HMAC-SHA512 over the raw body
 * using the key configured on the webhook resource; the digest arrives in
 * this header. Verify against the RAW request body — any re-serialized
 * JSON will not match.
 *
 * The digest ENCODING is not documented (the SDK's `WebhookSignature` says
 * only "SHA512 … from the webhook body"; developer.bitmovin.com has no
 * signature page — checked 2026-09-02). Until the first real delivery pins
 * it (WP-G X0), both standard encodings of a 64-byte HMAC-SHA512 are
 * accepted: 128 hex characters, or 88 base64 characters. Each comparison is
 * constant-time; accepting two encodings of the SAME digest widens nothing
 * — a forger still needs the key.
 */
export const BITMOVIN_SIGNATURE_HEADER = "bitmovin-signature";

const HMAC_SHA512_BYTES = 64;

export function computeWebhookSignature(
	rawBody: string,
	secret: string,
): string {
	return createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string,
): boolean {
	if (!signatureHeader) {
		return false;
	}
	const expected = createHmac("sha512", secret)
		.update(rawBody, "utf8")
		.digest();
	const provided = decodeDigest(signatureHeader.trim());
	return (
		provided !== null &&
		provided.length === HMAC_SHA512_BYTES &&
		timingSafeEqual(expected, provided)
	);
}

/**
 * Hex (either case) or standard base64 (with padding) of exactly 64 bytes;
 * anything else is null. Strict on purpose: `Buffer.from(x, "base64")`
 * skips characters it does not recognise, so a shape check comes first.
 */
function decodeDigest(raw: string): Buffer | null {
	if (/^[0-9a-fA-F]{128}$/.test(raw)) {
		return Buffer.from(raw, "hex");
	}
	if (/^[A-Za-z0-9+/]{86}==$/.test(raw)) {
		return Buffer.from(raw, "base64");
	}
	return null;
}
