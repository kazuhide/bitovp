import { deriveScopedToken } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { receiveSignedWebhook } from "./webhook-receiver";

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * The signed receiver's limiter, in its own file so the module-level bucket
 * is fresh — `webhook-receiver.test.ts` stays under the budget on purpose.
 * Same contract as the legacy route's: keyed by `clientKey`, which ignores
 * an untrusted `x-forwarded-for`, so varying the header mints no new bucket.
 *
 * A malformed token is a 404 before any database work, so the whole budget
 * is spent on the cheapest refusal: 404 means "admitted", 429 "over budget".
 */
const ctx = () =>
	({
		prisma: { webhookEvent: { create: vi.fn() } },
		cipher: {},
	}) as unknown as ServerContext;

describe("signed receiver — rate limiting", () => {
	it("cannot be bypassed by varying x-forwarded-for; the 121st request is 429 even for a cheap 404", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 121; i += 1) {
			const res = await receiveSignedWebhook(
				new Request("http://test/api/webhooks/bitmovin/acct/x", {
					method: "POST",
					body: "{}",
					headers: { "x-forwarded-for": `198.51.100.${i % 256}` },
				}),
				{ scope: "acct", token: "short" },
				{ ctx },
			);
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 120).every((s) => s === 404)).toBe(true);
		expect(statuses[120]).toBe(429);
	});

	it("the hb bucket (1,200/min) is granted ONLY to the master's derived hb token; a well-formed unknown hb token pays the general bucket (rev414 R3)", async () => {
		// The general bucket is already exhausted by the arm above. The env
		// master keeps resolution off the database.
		vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", "ratelimit-master");
		const probe = await receiveSignedWebhook(
			new Request("http://test/api/webhooks/bitmovin/hb/x", {
				method: "POST",
				body: "{}",
			}),
			{ scope: "hb", token: "A".repeat(22) },
			{ ctx },
		);
		// Not the derived token → metered like any probe → the exhausted
		// general bucket answers 429 before the body or the token is touched.
		expect(probe.status).toBe(429);

		const hbToken = deriveScopedToken("ratelimit-master", "hb");
		let unsigned = 0;
		for (let i = 0; i < 1_200; i += 1) {
			const res = await receiveSignedWebhook(
				new Request("http://test/api/webhooks/bitmovin/hb/x", {
					method: "POST",
					body: "{}",
				}),
				{ scope: "hb", token: hbToken },
				{ ctx },
			);
			// The derived token resolves; the unsigned body is a 401, never a 429.
			if (res.status === 401) unsigned += 1;
		}
		expect(unsigned).toBe(1_200);
		const over = await receiveSignedWebhook(
			new Request("http://test/api/webhooks/bitmovin/hb/x", {
				method: "POST",
				body: "{}",
			}),
			{ scope: "hb", token: hbToken },
			{ ctx },
		);
		expect(over.status).toBe(429);
	});
});
