import {
	computeWebhookSignature,
	deriveScopedToken,
	deriveWebhookKey,
	hashWebhookToken,
} from "@bitovp/core";
import { DEFAULT_ORGANIZATION_ID } from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, contextForOrganization, resolveWebhookOrganization } =
	vi.hoisted(() => ({
		create: vi.fn(),
		contextForOrganization: vi.fn(),
		resolveWebhookOrganization: vi.fn(),
	}));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<Record<string, unknown>>()),
	resolveWebhookOrganization,
}));
vi.mock("@/lib/server/context", () => ({
	contextForOrganization,
}));

import { POST } from "./route";

/**
 * The route is params plumbing over `lib/server/webhook-receiver.ts` (whose
 * matrix test owns the decisions). This pins the plumbing: the App Router's
 * awaited params reach the receiver as scope + token, the token hash resolves
 * its organization, and a historical account token uses the default scope.
 */
const MASTER = "route-test-master";
const body = JSON.stringify({ type: "ENCODING_ERROR", eventId: "evt-9" });

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue({ id: "row-1" });
	resolveWebhookOrganization.mockResolvedValue(null);
	contextForOrganization.mockReturnValue({
		prisma: { webhookEvent: { create } },
		cipher: {
			encrypt: async () => {
				throw new Error("not reached: env secret set");
			},
			decrypt: async () => {
				throw new Error("not reached: env secret set");
			},
		},
	});
	vi.stubEnv("BITMOVIN_WEBHOOK_SECRET", MASTER);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/webhooks/bitmovin/[scope]/[token]", () => {
	it("routes params to the receiver: a signed acct delivery persists", async () => {
		const token = deriveScopedToken(MASTER, "acct");
		const res = await POST(
			new Request(`http://test/api/webhooks/bitmovin/acct/${token}`, {
				method: "POST",
				body,
				headers: {
					"bitmovin-signature": computeWebhookSignature(
						body,
						deriveWebhookKey(MASTER, token),
					),
				},
			}),
			{ params: Promise.resolve({ scope: "acct", token }) },
		);
		expect(res.status).toBe(200);
		expect(resolveWebhookOrganization).toHaveBeenCalledWith(
			hashWebhookToken(token),
		);
		expect(contextForOrganization).toHaveBeenCalledWith(
			DEFAULT_ORGANIZATION_ID,
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "ENCODING_ERROR",
				externalEventId: "evt-9",
				signatureValid: true,
			}),
		});
	});

	it("an unknown token through the route is a 404 with nothing written", async () => {
		const res = await POST(
			new Request("http://test/api/webhooks/bitmovin/acct/x", {
				method: "POST",
				body,
			}),
			{ params: Promise.resolve({ scope: "acct", token: "A".repeat(22) }) },
		);
		expect(res.status).toBe(404);
		expect(resolveWebhookOrganization).toHaveBeenCalledWith(
			hashWebhookToken("A".repeat(22)),
		);
		expect(create).not.toHaveBeenCalled();
	});
});
