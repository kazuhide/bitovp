import { describe, expect, it, vi } from "vitest";

/**
 * rev407 #2: the two secret comparisons must go through node's
 * `timingSafeEqual`, and only with equal-length inputs — `===` or
 * `Buffer#equals` short-circuits on the first differing byte, and the length
 * pre-check is what keeps `timingSafeEqual` from throwing. Every input/output
 * pair is identical under a plain comparison, so a spy on the built-in is
 * the only instrument that sees the mechanism itself.
 */
const { timingSafeEqual } = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	timingSafeEqual.mockImplementation(actual.timingSafeEqual);
	return { ...actual, timingSafeEqual };
});

import { createHmac } from "node:crypto";
import { newWebhookToken, webhookTokenEquals } from "./keys";
import { verifyWebhookSignature } from "./signature";

describe("constant-time comparisons go through node's timingSafeEqual", () => {
	it("verifyWebhookSignature compares the two 64-byte digests with exactly one timingSafeEqual call", () => {
		timingSafeEqual.mockClear();
		const secret = "webhook-secret";
		const body = '{"type":"ENCODING_FINISHED","id":"abc"}';
		const hex = createHmac("sha512", secret).update(body).digest("hex");
		expect(verifyWebhookSignature(body, hex, secret)).toBe(true);
		expect(timingSafeEqual).toHaveBeenCalledTimes(1);
		const [expected, provided] = timingSafeEqual.mock.calls[0] as [
			Buffer,
			Buffer,
		];
		expect(Buffer.isBuffer(expected)).toBe(true);
		expect(Buffer.isBuffer(provided)).toBe(true);
		expect(expected.length).toBe(64);
		expect(provided.length).toBe(64);

		// A digest of the wrong length never reaches the comparison (it would
		// throw there); the shape check refuses first.
		timingSafeEqual.mockClear();
		expect(verifyWebhookSignature(body, hex.slice(0, 64), secret)).toBe(false);
		expect(timingSafeEqual).not.toHaveBeenCalled();
	});

	it("webhookTokenEquals compares the two 22-byte tokens with exactly one timingSafeEqual call", () => {
		timingSafeEqual.mockClear();
		const token = newWebhookToken();
		expect(webhookTokenEquals(token, token)).toBe(true);
		expect(timingSafeEqual).toHaveBeenCalledTimes(1);
		const [left, right] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
		expect(left.length).toBe(22);
		expect(right.length).toBe(22);

		timingSafeEqual.mockClear();
		expect(webhookTokenEquals(token, token.slice(0, 21))).toBe(false);
		expect(timingSafeEqual).not.toHaveBeenCalled();
	});
});
