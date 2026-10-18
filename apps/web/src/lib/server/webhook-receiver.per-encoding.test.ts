import {
	computeWebhookSignature,
	deriveWebhookKey,
	hashWebhookToken,
	newWebhookToken,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { receiveSignedWebhook, resolveWebhookToken } from "./webhook-receiver";

afterEach(() => vi.unstubAllEnvs());

describe("per-encoding heartbeat receiver", () => {
	it.each([
		false,
		true,
	])("retains every 2-second delivery with a stable event ID (repeated sample: %s)", async (repeatSample) => {
		const token = newWebhookToken();
		const master = "cadence-test-master";
		vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", master);
		const create = vi.fn().mockResolvedValue({});
		const ctx = {
			prisma: {
				webhookRegistration: {
					findFirst: vi
						.fn()
						.mockImplementation(async ({ where }) =>
							where.providerWebhookId ? null : { id: "pending-intent" },
						),
				},
				webhookEvent: { create },
			},
			cipher: {},
		} as unknown as ServerContext;
		const start = Date.parse("2026-09-21T00:00:00Z");
		for (let i = 0; i < 31; i++) {
			const receivedAt = new Date(start + i * 2_000);
			const body = JSON.stringify({
				eventType: "LIVE_ENCODING_HEARTBEAT",
				id: "stable-provider-event-id",
				webhookId: "11111111-1111-4111-8111-111111111111",
				encoding: { id: "22222222-2222-4222-8222-222222222222" },
				value: {
					timestamp: new Date(repeatSample ? start : receivedAt).toISOString(),
				},
			});
			const response = await receiveSignedWebhook(
				new Request("http://test", {
					method: "POST",
					body,
					headers: {
						"bitmovin-signature": computeWebhookSignature(
							body,
							deriveWebhookKey(master, token),
						),
					},
				}),
				{ scope: "hb", token },
				{ ctx: () => ctx, now: () => receivedAt },
			);
			expect(response.status).toBe(200);
		}
		expect(create).toHaveBeenCalledTimes(31);
		const rows = create.mock.calls.map(([arg]) => arg.data);
		expect(rows.map((row) => row.receivedAt.getTime())).toEqual(
			Array.from({ length: 31 }, (_, i) => start + i * 2_000),
		);
		for (const row of rows) {
			expect(row.externalEventId).toBeUndefined();
			expect(row.processedAt).toEqual(row.receivedAt);
		}
	});
	it("resolves a persisted intent before the create response, quarantines its signed receipt and isolates j scope", async () => {
		const token = newWebhookToken();
		const master = "test-only-master";
		vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", master);
		const create = vi.fn().mockResolvedValue({});
		const lookup = vi
			.fn()
			.mockImplementation(async ({ where }) =>
				where.scope === "hb" &&
				where.tokenHash === hashWebhookToken(token) &&
				!where.providerWebhookId
					? { id: "pending-intent" }
					: null,
			);
		const ctx = {
			prisma: {
				webhookRegistration: { findFirst: lookup },
				webhookEvent: { create },
			},
			cipher: {},
		} as unknown as ServerContext;
		const body = JSON.stringify({
			eventType: "LIVE_ENCODING_HEARTBEAT",
			webhookId: "11111111-1111-4111-8111-111111111111",
			encoding: { id: "22222222-2222-4222-8222-222222222222" },
			customData: { bitOvp: { runId: "untrusted" } },
			value: { streamKey: "SECRET_CANARY" },
		});
		const request = (signature: string) =>
			new Request("http://test", {
				method: "POST",
				body,
				headers: { "bitmovin-signature": signature },
			});
		const params = { scope: "hb", token };
		expect(
			(await receiveSignedWebhook(request("wrong"), params, { ctx: () => ctx }))
				.status,
		).toBe(401);
		expect(create).not.toHaveBeenCalled();
		const result = await receiveSignedWebhook(
			request(computeWebhookSignature(body, deriveWebhookKey(master, token))),
			params,
			{ ctx: () => ctx },
		);
		expect(result.status).toBe(200);
		const saved = create.mock.calls[0]?.[0].data;
		expect(saved).toMatchObject({
			signatureValid: true,
			eventType: "LIVE_ENCODING_HEARTBEAT",
			processedAt: expect.any(Date),
		});
		expect(saved.liveChannelRunId).toBeUndefined();
		expect(saved.externalEventId).toBeUndefined();
		expect(JSON.stringify(saved)).not.toContain("SECRET_CANARY");
		expect(await resolveWebhookToken(ctx, "j", token)).toBeNull();
	});
});
