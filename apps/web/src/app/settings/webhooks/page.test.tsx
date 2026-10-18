import { describe, expect, it, vi } from "vitest";

/**
 * rev407 #3 (kept through WP-G G-2b): the settings page is a server component
 * nothing renders in a browser test, so pin the ONLY thing it hands the
 * client — the props object — by calling the async page and reading the
 * element it returns. G-2b replaced the account-level `acct` URL with the
 * per-encoding receiver PATTERN (no token anyone could copy) and reads the
 * secret's SOURCE directly; no key-shaped value can reach the client.
 */
const { readCurrentIngress, resolveWebhookMasterSecret } = vi.hoisted(() => ({
	readCurrentIngress: vi.fn(),
	resolveWebhookMasterSecret: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma: {}, cipher: {} }),
}));
vi.mock("@/lib/server/ingress", () => ({ readCurrentIngress }));
vi.mock("@bitovp/db", () => ({ resolveWebhookMasterSecret }));
vi.mock("@bitovp/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/core")>()),
	loadEnv: () => ({ BITMOVIN_WEBHOOK_SECRET: undefined }),
}));
vi.mock("@/lib/i18n/metadata", () => ({
	localizedTitle: () => () => ({ title: "webhooks" }),
}));
vi.mock("./webhooks-client", () => ({ WebhooksClient: () => null }));

import WebhooksPage from "./page";
import { WebhooksClient } from "./webhooks-client";

const SNAPSHOT = {
	v: 1,
	mode: "static",
	current: {
		baseUrl: "https://ovp.example.com",
		source: "PUBLIC_BASE_URL",
		observedAt: "2026-09-02T09:00:00.000Z",
	},
	checkedAt: "2026-09-02T09:00:30.000Z",
};

describe("WebhooksPage — the props are the fence (rev407 #3, G-2b shape)", () => {
	it("hands the client exactly {ingress, receiverEndpoint, secretSource}: the per-encoding receiver PATTERN, the secret's source, never a key or a real token", async () => {
		readCurrentIngress.mockResolvedValue(SNAPSHOT);
		resolveWebhookMasterSecret.mockResolvedValue({
			secret: "never-read-here",
			source: "env",
		});
		const element = await WebhooksPage();
		expect(element.type).toBe(WebhooksClient);
		expect(Object.keys(element.props).sort()).toEqual([
			"ingress",
			"receiverEndpoint",
			"secretSource",
		]);
		expect(element.props).toEqual({
			ingress: {
				mode: "static",
				baseUrl: "https://ovp.example.com",
				source: "PUBLIC_BASE_URL",
				observedAt: "2026-09-02T09:00:00.000Z",
				checkedAt: "2026-09-02T09:00:30.000Z",
				reason: null,
			},
			receiverEndpoint:
				"https://ovp.example.com/api/webhooks/bitmovin/j/<token>",
			secretSource: "env",
		});
		expect(JSON.stringify(element.props)).not.toContain("never-read-here");
	});

	it("without an ingress the pattern is null and the secret's source still shows; a secret fault renders 'unavailable' instead of throwing", async () => {
		readCurrentIngress.mockResolvedValue(null);
		resolveWebhookMasterSecret.mockResolvedValue({
			secret: "never-read-here",
			source: "generated",
		});
		expect((await WebhooksPage()).props).toEqual({
			ingress: null,
			receiverEndpoint: null,
			secretSource: "generated",
		});

		resolveWebhookMasterSecret.mockRejectedValue(
			new Error("MASTER_KEY is not set"),
		);
		expect((await WebhooksPage()).props).toEqual({
			ingress: null,
			receiverEndpoint: null,
			secretSource: "unavailable",
		});
	});
});
