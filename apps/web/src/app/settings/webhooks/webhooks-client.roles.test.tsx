import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { type IngressWire, WebhooksClient } from "./webhooks-client";

function stub(role: "VIEWER" | "ADMIN"): void {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
				role,
			};
		}
		if (url === "/api/bitmovin-accounts") return [];
		if (url.startsWith("/api/webhook-events") || url === "/api/audit-logs") {
			return { items: [], nextCursor: null };
		}
		return {};
	});
}

const RECEIVER =
	"https://ovp.example.com/api/webhooks/bitmovin/acct/AAAAAAAAAAAAAAAAAAAAAA";

function ingress(overrides: Partial<IngressWire> = {}): IngressWire {
	return {
		mode: "quick-tunnel",
		baseUrl: "https://ovp.example.com",
		source: "cloudflared-quicktunnel",
		observedAt: new Date(Date.now() - 600_000).toISOString(),
		checkedAt: new Date(Date.now() - 10_000).toISOString(),
		reason: null,
		...overrides,
	};
}

function renderPanel(
	props: Partial<Parameters<typeof WebhooksClient>[0]> = {},
) {
	return renderWithQuery(
		<WebhooksClient
			ingress={ingress()}
			receiverEndpoint={RECEIVER}
			secretSource="generated"
			{...props}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("WebhooksClient ingress card (WP-G G-1)", () => {
	it("shows the persisted ingress, the signed receiver URL and the generated-key badge", async () => {
		stub("ADMIN");
		renderPanel();
		expect(await screen.findByText("Public ingress")).toBeVisible();
		expect(screen.getByText("https://ovp.example.com")).toBeVisible();
		expect(screen.getByText(/quick tunnel \(cloudflared\)/)).toBeVisible();
		expect(screen.getByText(RECEIVER)).toBeVisible();
		expect(
			screen.getByText("signature verification on (generated key)"),
		).toBeVisible();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("identifies ingress as a page-load snapshot and provides a document refresh", async () => {
		stub("VIEWER");
		renderPanel();
		const card = await screen.findByRole("region", { name: "Public ingress" });
		expect(within(card).getByText(/when the page loaded/)).toBeVisible();
		expect(within(card).getByRole("link", { name: "Refresh" })).toHaveAttribute(
			"href",
			"/settings/webhooks",
		);
	});

	it("says so when the worker has never reported an ingress, and when the resolved value is none", async () => {
		stub("ADMIN");
		const { unmount } = renderPanel({ ingress: null, receiverEndpoint: null });
		expect(
			await screen.findByText(/public ingress has not been reported yet/),
		).toBeVisible();
		unmount();
		renderPanel({
			ingress: ingress({
				baseUrl: null,
				source: null,
				observedAt: null,
				reason: "cloudflared has not reported a quick-tunnel hostname yet",
			}),
			receiverEndpoint: null,
		});
		expect(
			await screen.findByText(
				/No public ingress — Bitmovin cannot reach this install\. cloudflared has not reported/,
			),
		).toBeVisible();
	});

	it("flags a stale snapshot (worker down) and an unavailable signature key", async () => {
		stub("ADMIN");
		renderPanel({
			ingress: ingress({
				checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
			}),
			secretSource: "unavailable",
		});
		expect(
			await screen.findByText(/the background service may be down/),
		).toBeVisible();
		expect(
			screen.getByText("signature key unavailable (MASTER_KEY)"),
		).toBeVisible();
	});
});

describe("WebhooksClient mixed-role panels", () => {
	it("keeps delivery history for VIEWER but neither renders nor fetches the ADMIN audit panel", async () => {
		stub("VIEWER");
		renderPanel();
		expect(await screen.findByText(/Recent deliveries/)).toBeVisible();
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/webhook-events"),
		);
		expect(screen.queryByText("Bitmovin API audit log")).toBeNull();
		expect(apiFetch.mock.calls.some(([url]) => url === "/api/audit-logs")).toBe(
			false,
		);
	});

	it("renders and fetches the audit panel for ADMIN", async () => {
		stub("ADMIN");
		renderPanel();
		expect(await screen.findByText("Bitmovin API audit log")).toBeVisible();
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/audit-logs"),
		);
	});
});
