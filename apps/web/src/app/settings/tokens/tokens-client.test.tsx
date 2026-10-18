import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 *  PR2 — the tokens panel. Pins: the minted SECRET renders once
 * (selectable) and dismisses; revoked rows lose the revoke button; the mint
 * POST carries name + expiresDays.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { TokensClient } from "./tokens-client";

const SECRET = `bo_${"s".repeat(43)}`;

function route(url: string, init?: RequestInit): unknown {
	if (url === "/api/api-tokens" && init?.method === "POST") {
		return {
			id: "tok-1",
			name: "ci-runner",
			prefix: "ssssssss",
			secret: SECRET,
		};
	}
	if (url === "/api/api-tokens") {
		return [
			{
				id: "tok-live",
				name: "live-one",
				prefix: "aaaa1111",
				role: "OPERATOR",
				createdAt: "2026-08-13T00:00:00.000Z",
				expiresAt: null,
				revokedAt: null,
				lastUsedAt: null,
			},
			{
				id: "tok-live-2",
				name: "second-live",
				prefix: "cccc3333",
				role: "OPERATOR",
				createdAt: "2026-08-13T00:00:00.000Z",
				expiresAt: "2027-01-01T00:00:00.000Z",
				revokedAt: null,
				lastUsedAt: null,
			},
			{
				id: "tok-dead",
				name: "dead-one",
				prefix: "bbbb2222",
				role: "OPERATOR",
				createdAt: "2026-08-13T00:00:00.000Z",
				expiresAt: null,
				revokedAt: "2026-08-13T01:00:00.000Z",
				lastUsedAt: null,
			},
		];
	}
	return {};
}

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation((url: string, init?: RequestInit) =>
		Promise.resolve(route(url, init)),
	);
});

describe("TokensClient", () => {
	it("mints and shows the secret ONCE, selectable, dismissable", async () => {
		renderWithQuery(<TokensClient />);
		await screen.findByText("live-one");
		await userEvent.type(screen.getByLabelText("Name"), "ci-runner");
		await userEvent.click(screen.getByRole("button", { name: "Mint token" }));
		const secretBlock = await screen.findByText(SECRET);
		expect(secretBlock.className).toContain("select-all");
		const post = apiFetch.mock.calls.find(
			(call) => (call[1] as RequestInit | undefined)?.method === "POST",
		);
		expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
			name: "ci-runner",
		});
		await userEvent.click(
			screen.getByRole("button", { name: "I stored it — dismiss" }),
		);
		expect(screen.queryByText(SECRET)).toBeNull();
	});

	it("revoked rows show the badge and LOSE the revoke button", async () => {
		renderWithQuery(<TokensClient />);
		await screen.findByText("dead-one");
		expect(screen.getByText("Revoked")).toBeInTheDocument();
		// Two live rows → exactly two revoke buttons; the dead row has none.
		expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
	});

	it("revoke needs TWO clicks and DELETEs the row it was clicked in (review-189 I3+N5)", async () => {
		renderWithQuery(<TokensClient />);
		await screen.findByText("second-live");
		// Row-scoped click on the SECOND live row: the old test clicked the
		// only button, so mutating the handler to tokens.data[0].id survived
		// (review-189 M7). within(row) + a second active row kills that.
		const row = screen.getByText("second-live").closest("li");
		if (!row) {
			throw new Error("row not rendered");
		}
		await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));
		// First click: NOTHING deleted yet — no un-revoke exists.
		expect(
			apiFetch.mock.calls.find(
				(call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
			),
		).toBeUndefined();
		await userEvent.click(
			within(row).getByRole("button", { name: "Revoke permanently?" }),
		);
		await waitFor(() => {
			const del = apiFetch.mock.calls.find(
				(call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
			);
			expect(del?.[0]).toBe("/api/api-tokens/tok-live-2");
		});
	});

	it("a failed revoke is LOUD — the kill-switch must not fail silently (review-189 I2)", async () => {
		apiFetch.mockImplementation((url: string, init?: RequestInit) => {
			if (init?.method === "DELETE") {
				return Promise.reject(new Error("boom 500"));
			}
			return Promise.resolve(route(url, init));
		});
		renderWithQuery(<TokensClient />);
		await screen.findByText("live-one");
		const row = screen.getByText("live-one").closest("li");
		if (!row) {
			throw new Error("row not rendered");
		}
		await userEvent.click(within(row).getByRole("button", { name: "Revoke" }));
		await userEvent.click(
			within(row).getByRole("button", { name: "Revoke permanently?" }),
		);
		expect(await screen.findByText(/boom 500/)).toBeInTheDocument();
	});

	it("created/expiry render as localized dates (review-189 I4/N4 — §4's five columns)", async () => {
		renderWithQuery(<TokensClient />);
		await screen.findByText("second-live");
		expect(screen.getAllByText(/created:/).length).toBe(3);
		const row = screen.getByText("second-live").closest("li");
		expect(row?.textContent).toContain("expires:");
		// Localized, not the raw ISO string.
		expect(row?.textContent).not.toContain("2027-01-01T00:00:00.000Z");
	});

	it("dismiss purges the secret from the MUTATION CACHE too (review-189b I4)", async () => {
		const { client } = renderWithQuery(<TokensClient />);
		await screen.findByText("live-one");
		await userEvent.type(screen.getByLabelText("Name"), "ci-runner");
		await userEvent.click(screen.getByRole("button", { name: "Mint token" }));
		await screen.findByText(SECRET);
		await userEvent.click(
			screen.getByRole("button", { name: "I stored it — dismiss" }),
		);
		expect(screen.queryByText(SECRET)).toBeNull();
		expect(
			JSON.stringify(
				client
					.getMutationCache()
					.getAll()
					.map((m) => m.state),
			),
		).not.toContain(SECRET);
	});
});
