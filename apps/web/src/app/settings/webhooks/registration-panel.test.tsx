import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 *  PR4 → WP-G G-2. Two lists: the PER-ENCODING registrations the
 * worker keeps (status / current-vs-previous ingress / last delivery, plus
 * "re-register now"), and the ACCOUNT-LEVEL hooks with OURS vs LEGACY vs
 * EXTERNAL badging, one-click unregister for our own rows and the two-step
 * confirm for EXTERNAL ones (review-187 I5: on a shared Bitmovin account one
 * silent click must not kill another environment's delivery). The
 * account-level "register the standard set" button is GONE.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { RegistrationPanel } from "./registration-panel";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const T = "2026-09-02T09:00:00.000Z";

function route(url: string, init?: RequestInit): unknown {
	if (url === "/api/auth/session") {
		return {
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			role: "ADMIN",
		};
	}
	if (url === "/api/bitmovin-accounts") {
		return [{ id: ACCOUNT, label: "prod-account" }];
	}
	if (url === "/api/webhook-registrations" && !init?.method) {
		return {
			currentBase: "https://a.trycloudflare.com",
			rows: [
				{
					id: "reg-1",
					encodingId: "enc-1",
					kind: "finished",
					status: "ACTIVE",
					url: "https://a.trycloudflare.com/api/webhooks/bitmovin/j/AAAAAAAAAAAAAAAAAAAAAA",
					urlMatchesIngress: true,
					note: null,
					attempts: 0,
					nextAttemptAt: null,
					registeredAt: T,
					lastDeliveryAt: T,
					subject: {
						kind: "job",
						id: "job-1",
						name: "Promo 30s",
						status: "RUNNING",
					},
				},
				{
					id: "reg-2",
					encodingId: "enc-2",
					kind: "error",
					status: "ACTIVE",
					url: "https://old.trycloudflare.com/api/webhooks/bitmovin/j/BBBBBBBBBBBBBBBBBBBBBB",
					urlMatchesIngress: false,
					note: null,
					attempts: 0,
					nextAttemptAt: null,
					registeredAt: T,
					lastDeliveryAt: null,
					subject: {
						kind: "run",
						id: "run-1",
						name: "News",
						channelId: "ch-1",
						seq: 3,
						status: "RUNNING",
					},
				},
				{
					id: "reg-3",
					encodingId: "enc-3",
					kind: "finished",
					status: "SKIPPED",
					url: null,
					urlMatchesIngress: false,
					note: "ingressUnavailable",
					attempts: 0,
					nextAttemptAt: null,
					registeredAt: null,
					lastDeliveryAt: null,
					subject: null,
				},
			],
		};
	}
	if (url === "/api/webhook-registrations/reconcile") {
		return { requestedAt: T, appliesWithinMs: 10_000 };
	}
	if (url.startsWith("/api/webhook-registration?") && !init?.method) {
		return {
			endpoint:
				"https://ovp.example.com/api/webhooks/bitmovin/acct/AAAAAAAAAAAAAAAAAAAAAA",
			rows: [
				{
					kind: "finished",
					id: "wh-ours",
					url: "https://ovp.example.com/api/webhooks/bitmovin/acct/AAAAAAAAAAAAAAAAAAAAAA",
					ours: true,
					legacy: false,
				},
				{
					kind: "finished",
					id: "wh-prod",
					url: "https://prod.example.com/api/webhooks/bitmovin",
					ours: false,
					legacy: false,
				},
				{
					kind: "error",
					id: "wh-legacy",
					url: "https://ovp.example.com/api/webhooks/bitmovin",
					ours: true,
					legacy: true,
				},
				// A SECOND external hook (rev413 R1): the two-step confirm must be
				// bound to the row that armed it, which one external row cannot show.
				{
					kind: "error",
					id: "wh-stage",
					url: "https://stage.example.com/api/webhooks/bitmovin",
					ours: false,
					legacy: false,
				},
			],
		};
	}
	return {};
}

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation((url: string, init?: RequestInit) =>
		Promise.resolve(route(url, init)),
	);
});

async function openAccount() {
	renderWithQuery(<RegistrationPanel />);
	await screen.findByText("prod-account");
	await userEvent.selectOptions(
		screen.getByLabelText("Bitmovin account"),
		ACCOUNT,
	);
	await screen.findByText("https://prod.example.com/api/webhooks/bitmovin");
}

function deletes() {
	return apiFetch.mock.calls.filter(
		(call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
	);
}

describe("RegistrationPanel — per-encoding registrations (WP-G G-2)", () => {
	it("lists each registration with its subject link, status, ingress match and last delivery", async () => {
		renderWithQuery(<RegistrationPanel />);
		const job = await screen.findByRole("link", { name: "Promo 30s" });
		expect(job).toHaveAttribute("href", "/vod/jobs/job-1");
		const run = screen.getByRole("link", { name: "News · run #3" });
		expect(run).toHaveAttribute("href", "/live/ch-1");
		const rows = screen.getAllByRole("row").slice(1);
		expect(rows).toHaveLength(3);
		expect(
			within(rows[0] as HTMLElement).getByText("current ingress"),
		).toBeInTheDocument();
		expect(
			within(rows[1] as HTMLElement).getByText("previous ingress"),
		).toBeInTheDocument();
		expect(
			within(rows[1] as HTMLElement).getByText("none yet"),
		).toBeInTheDocument();
		expect(
			within(rows[2] as HTMLElement).getByText("waiting"),
		).toBeInTheDocument();
		expect(
			within(rows[2] as HTMLElement).getByText("no public ingress — waiting"),
		).toBeInTheDocument();
		expect(
			within(rows[2] as HTMLElement).getByText("enc-3"),
		).toBeInTheDocument();
	});

	it("'Re-register now' POSTs the reconcile request and reports the worker's window", async () => {
		renderWithQuery(<RegistrationPanel />);
		await screen.findByRole("link", { name: "Promo 30s" });
		await userEvent.click(
			screen.getByRole("button", { name: "Re-register now" }),
		);
		expect(
			await screen.findByText(
				/Requested — waiting registrations are retried within 10 s/,
			),
		).toBeVisible();
		expect(apiFetch).toHaveBeenCalledWith(
			"/api/webhook-registrations/reconcile",
			{
				method: "POST",
			},
		);
	});

	it("the account-level 'register the standard set' button no longer exists", async () => {
		await openAccount();
		expect(screen.queryByRole("button", { name: /standard set/i })).toBeNull();
		expect(
			apiFetch.mock.calls.some(
				([url, init]) =>
					url === `/api/webhook-registration?bitmovinAccountId=${ACCOUNT}` &&
					(init as RequestInit | undefined)?.method === "POST",
			),
		).toBe(false);
	});
});

describe("RegistrationPanel — account-level hooks", () => {
	it("badges OURS vs EXTERNAL vs LEGACY per row", async () => {
		await openAccount();
		expect(screen.getByText("this app")).toBeInTheDocument();
		// Two external rows since rev413 R1 (wh-prod and wh-stage).
		expect(screen.getAllByText("external")).toHaveLength(2);
		expect(screen.getByText("this app (legacy, unsigned)")).toBeInTheDocument();
	});

	it("EXTERNAL unregister needs TWO clicks; the first only arms the confirm", async () => {
		await openAccount();
		const buttons = screen.getAllByRole("button", { name: "Unregister" });
		// Render order follows the wire: ours, external, legacy.
		await userEvent.click(buttons[1] as HTMLElement);
		expect(deletes()).toHaveLength(0);
		await userEvent.click(
			screen.getByRole("button", {
				name: /NOT this app's — click again to remove/,
			}),
		);
		await waitFor(() => {
			expect(deletes()).toHaveLength(1);
			expect(
				JSON.parse((deletes()[0]?.[1] as RequestInit).body as string),
			).toEqual({ kind: "finished", webhookId: "wh-prod" });
		});
	});

	it("the armed confirm belongs to ONE external row: arming A and clicking B once fires nothing and re-arms B (rev413 R1)", async () => {
		await openAccount();
		const buttons = screen.getAllByRole("button", { name: "Unregister" });
		// Wire order: ours, external (wh-prod), legacy, external (wh-stage).
		await userEvent.click(buttons[1] as HTMLElement); // arms wh-prod
		expect(deletes()).toHaveLength(0);
		const stageRow = screen
			.getByText("https://stage.example.com/api/webhooks/bitmovin")
			.closest("li") as HTMLElement;
		// One click on the OTHER external row must not remove it — a guard that
		// only asks "is anything armed?" would (review-187 I5, relation-swap).
		await userEvent.click(
			within(stageRow).getByRole("button", { name: "Unregister" }),
		);
		expect(deletes()).toHaveLength(0);
		expect(
			within(stageRow).getByRole("button", {
				name: /NOT this app's — click again to remove/,
			}),
		).toBeInTheDocument();
		// And exactly one row is armed now: wh-prod fell back to plain Unregister.
		expect(
			screen.getAllByRole("button", {
				name: /NOT this app's — click again to remove/,
			}),
		).toHaveLength(1);
	});

	it("OUR OWN row and a LEGACY row unregister in one click", async () => {
		await openAccount();
		const buttons = screen.getAllByRole("button", { name: "Unregister" });
		await userEvent.click(buttons[0] as HTMLElement);
		await userEvent.click(buttons[2] as HTMLElement);
		await waitFor(() => {
			expect(
				deletes().map((call) =>
					JSON.parse((call[1] as RequestInit).body as string),
				),
			).toEqual([
				{ kind: "finished", webhookId: "wh-ours" },
				{ kind: "error", webhookId: "wh-legacy" },
			]);
		});
	});

	it("keeps rows readable but hides write controls from VIEWER", async () => {
		apiFetch.mockImplementation((url: string, init?: RequestInit) =>
			Promise.resolve(
				url === "/api/auth/session"
					? {
							mode: "users",
							configured: true,
							authenticated: true,
							loginKind: "password-form",
							role: "VIEWER",
						}
					: route(url, init),
			),
		);
		await openAccount();
		expect(
			screen.getByText("https://prod.example.com/api/webhooks/bitmovin"),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("link", { name: "Promo 30s" }),
		).toBeVisible();
		expect(screen.queryByRole("button", { name: "Unregister" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Re-register now" }),
		).toBeNull();
	});
});

it("retries unavailable registration and account lists", async () => {
	apiFetch.mockImplementation((url: string, init?: RequestInit) =>
		url === "/api/auth/session"
			? Promise.resolve(route(url, init))
			: Promise.reject(new Error("offline")),
	);
	renderWithQuery(<RegistrationPanel />);
	await waitFor(() =>
		expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2),
	);
	apiFetch.mockImplementation((url: string, init?: RequestInit) =>
		Promise.resolve(route(url, init)),
	);
	for (const retry of screen.getAllByRole("button", { name: "Retry" }))
		await userEvent.click(retry);
	expect(await screen.findByText("prod-account")).toBeInTheDocument();
});
