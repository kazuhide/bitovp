import "server-only";

/**
 * Base64 helpers for wire fields Bitmovin documents as base64 (the standby-pool
 * `encodingTemplate`). Node's Buffer is the encoder; decoding is deliberately
 * FAIL-SOFT — a payload that is not valid base64/UTF-8 returns undefined so a
 * detail view can say "template unavailable" rather than render mojibake or
 * 500 on a value we did not write.
 */

export function toBase64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Decode cap. The zod input cap bounds what WE accept, but a pool created
 * outside this app can carry any size, and the round-trip below decodes AND
 * re-encodes synchronously — measured ~50 ms / ~266 MB RSS at 48 MB of
 * base64 (review catch N6). Beyond this the detail view says "template
 * unavailable" rather than blocking the event loop.
 */
const MAX_BASE64_LENGTH = 1_000_000;

export function fromBase64(b64: string): string | undefined {
	if (b64.length > MAX_BASE64_LENGTH) {
		return undefined;
	}
	// Tolerate transport whitespace and base64url before the strict round-trip
	// below, so a legitimate template is not reported "unavailable" for a
	// cosmetic encoding difference.
	const normalized = b64
		.replace(/\s+/g, "")
		.replaceAll("-", "+")
		.replaceAll("_", "/");
	const decoded = Buffer.from(normalized, "base64");
	// Buffer.from ignores invalid characters instead of throwing — round-trip to
	// prove the input really was canonical base64 for this payload.
	if (
		decoded.toString("base64").replace(/=+$/, "") !==
		normalized.replace(/=+$/, "")
	) {
		return undefined;
	}
	const text = decoded.toString("utf8");
	// U+FFFD in the output means the bytes were not UTF-8 text.
	return text.includes("�") ? undefined : text;
}
