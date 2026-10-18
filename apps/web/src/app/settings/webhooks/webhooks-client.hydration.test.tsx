import { INGRESS_RESOLVE_INTERVAL_MS } from "@bitovp/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n/context";
import { WebhooksClient } from "./webhooks-client";

vi.mock("@/lib/api", () => ({
	apiFetch: async (url: string) => {
		if (url === "/api/auth/session") {
			return { mode: "users", authenticated: true, role: "VIEWER" };
		}
		if (url === "/api/bitmovin-accounts") return [];
		return { items: [] };
	},
}));

afterEach(() => vi.restoreAllMocks());

it.each([
	"locale",
	"staleness",
])("hydrates ingress when server and browser %s differ", async (difference) => {
	const checkedAt = Date.parse("2026-09-15T00:00:00Z");
	const now = vi.spyOn(Date, "now").mockReturnValue(checkedAt);
	const localDate = vi
		.spyOn(Date.prototype, "toLocaleString")
		.mockReturnValue("server date");
	const clients: QueryClient[] = [];
	function tree() {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		clients.push(client);
		return (
			<LocaleProvider locale="en">
				<QueryClientProvider client={client}>
					<WebhooksClient
						ingress={{
							mode: "static",
							baseUrl: "https://ovp.example.com",
							source: "env",
							observedAt: new Date(checkedAt).toISOString(),
							checkedAt: new Date(checkedAt).toISOString(),
							reason: null,
						}}
						receiverEndpoint={null}
						secretSource="generated"
					/>
				</QueryClientProvider>
			</LocaleProvider>
		);
	}
	const container = document.createElement("div");
	container.innerHTML = renderToString(tree());
	document.body.append(container);
	if (difference === "locale") localDate.mockReturnValue("browser date");
	else now.mockReturnValue(checkedAt + 2 * INGRESS_RESOLVE_INTERVAL_MS + 1);
	const onRecoverableError = vi.fn();
	let root: ReturnType<typeof hydrateRoot> | undefined;
	try {
		await act(async () => {
			root = hydrateRoot(container, tree(), { onRecoverableError });
		});
		expect(onRecoverableError).not.toHaveBeenCalled();
		expect(container.textContent).toContain(
			difference === "locale"
				? "browser date"
				: "the background service may be down",
		);
	} finally {
		await act(async () => root?.unmount());
		container.remove();
		for (const client of clients) client.clear();
	}
});
