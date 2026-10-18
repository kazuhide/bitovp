import { describe, expect, it } from "vitest";
import { newWebhookToken, webhookReceiverPath } from "./keys";
import {
	hashWebhookToken,
	heartbeatRegistrationKey,
	heartbeatWebhookIdleMs,
	heartbeatWebhookIntervalS,
	isWebhookRegistrationKind,
	nextRegistrationAttemptAt,
	REGISTRATION_BACKOFF_MAX_MS,
	tokenFromReceiverUrl,
	WEBHOOK_REGISTRATION_KINDS,
	webhookKeyId,
	webhookUrlMatchesBase,
} from "./registration";

describe("webhook registration contract (WP-G G-2)", () => {
	it("names exactly the four per-encoding kinds", () => {
		expect([...WEBHOOK_REGISTRATION_KINDS]).toEqual([
			"finished",
			"error",
			"transferError",
			"liveManifestReady",
		]);
		expect(isWebhookRegistrationKind("liveInputStreamChanged")).toBe(false);
		expect(isWebhookRegistrationKind("finished")).toBe(true);
	});

	it("hashWebhookToken is stable, hex, and never the token", () => {
		const token = newWebhookToken();
		const hash = hashWebhookToken(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).toBe(hashWebhookToken(token));
		expect(hash).not.toContain(token);
	});

	it("webhookKeyId fingerprints the master: same master same id, different master different id", () => {
		expect(webhookKeyId("a")).toBe(webhookKeyId("a"));
		expect(webhookKeyId("a")).toMatch(/^[0-9a-f]{16}$/);
		expect(webhookKeyId("a")).not.toBe(webhookKeyId("b"));
	});

	it("tokenFromReceiverUrl reads back the token of a j URL and nothing else", () => {
		const token = newWebhookToken();
		expect(
			tokenFromReceiverUrl(
				`https://ovp.example.com${webhookReceiverPath("j", token)}`,
			),
		).toBe(token);
		expect(
			tokenFromReceiverUrl(
				`https://ovp.example.com${webhookReceiverPath("acct", token)}`,
			),
		).toBeNull();
		expect(
			tokenFromReceiverUrl("https://ovp.example.com/api/webhooks/bitmovin"),
		).toBeNull();
	});

	it("webhookUrlMatchesBase compares origins only", () => {
		expect(
			webhookUrlMatchesBase(
				"https://a.trycloudflare.com/api/webhooks/bitmovin/j/x",
				"https://a.trycloudflare.com",
			),
		).toBe(true);
		expect(
			webhookUrlMatchesBase(
				"https://a.trycloudflare.com/api/webhooks/bitmovin/j/x",
				"https://b.trycloudflare.com",
			),
		).toBe(false);
		expect(webhookUrlMatchesBase("nope", "https://a.example")).toBe(false);
	});

	it("heartbeat settings: interval defaults to the provider's 20 s, floors at 1 s, 0/off switches the hook off, and blank/garbage fall back (WP-G G-3, C37)", () => {
		expect(heartbeatWebhookIntervalS(undefined)).toBe(20);
		expect(heartbeatWebhookIntervalS("")).toBe(20);
		expect(heartbeatWebhookIntervalS("abc")).toBe(20);
		// `0` / `off` is the OFF switch (rev414 O1); a fraction below 1 is garbage.
		expect(heartbeatWebhookIntervalS("0")).toBe(0);
		expect(heartbeatWebhookIntervalS("off")).toBe(0);
		expect(heartbeatWebhookIntervalS(" OFF ")).toBe(0);
		expect(heartbeatWebhookIntervalS("0.5")).toBe(20);
		expect(heartbeatWebhookIntervalS("1")).toBe(1);
		expect(heartbeatWebhookIntervalS("7.9")).toBe(7);
		expect(heartbeatWebhookIdleMs(undefined)).toBe(60 * 60_000);
		expect(heartbeatWebhookIdleMs("15")).toBe(15 * 60_000);
		expect(heartbeatWebhookIdleMs("-3")).toBe(60 * 60_000);
		expect(heartbeatRegistrationKey("acct-1")).toBe("account:acct-1");
	});

	it("backoff doubles from 30 s and caps at 10 min", () => {
		const now = new Date("2026-09-02T09:00:00.000Z");
		const delays = [0, 1, 2, 3, 10].map(
			(n) => nextRegistrationAttemptAt(n, now).getTime() - now.getTime(),
		);
		expect(delays).toEqual([
			30_000,
			60_000,
			120_000,
			240_000,
			REGISTRATION_BACKOFF_MAX_MS,
		]);
	});
});
