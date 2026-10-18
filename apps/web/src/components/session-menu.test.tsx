import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { SessionMenu } from "./session-menu";

const assign = vi.fn();
Object.defineProperty(window, "location", {
	configurable: true,
	value: { assign },
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("SessionMenu", () => {
	it("signs out and returns to /login", async () => {
		apiFetch.mockImplementation((input: string) =>
			input === "/api/auth/session"
				? Promise.resolve({
						mode: "password",
						configured: true,
						authenticated: true,
						loginKind: "password-form",
					})
				: Promise.resolve({ ok: true }),
		);
		wrap(<SessionMenu />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Sign out" }),
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith("/api/auth/logout", {
				method: "POST",
			});
		});
		await waitFor(() => {
			expect(assign).toHaveBeenCalledWith("/login");
		});
	});

	it("badges an AUTH_MODE=none install as open instead of offering sign-out", async () => {
		apiFetch.mockResolvedValue({
			mode: "none",
			configured: true,
			authenticated: true,
			loginKind: "disabled",
		});
		wrap(<SessionMenu />);
		// : the badge says the install is open without naming the
		// environment variable — that string is for the deployer's docs.
		expect(
			await screen.findByText(/this install is open to anyone/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Sign out" }),
		).not.toBeInTheDocument();
	});

	it("shows displayName + role in users mode, from the resolved DTO (review-286 M6)", async () => {
		apiFetch.mockImplementation((input: string) =>
			input === "/api/auth/session"
				? Promise.resolve({
						mode: "users",
						configured: true,
						authenticated: true,
						loginKind: "password-form",
						displayName: "Alice",
						role: "OPERATOR",
					})
				: Promise.resolve({ ok: true }),
		);
		wrap(<SessionMenu />);
		// "{name} · {role}" — the identity line reads from the DB-resolved
		// session, not a cookie claim.
		expect(await screen.findByText("Alice · OPERATOR")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Sign out" }),
		).toBeInTheDocument();
	});

	it("drops a cached ADMIN identity when the shared session refresh fails", async () => {
		apiFetch.mockResolvedValue({
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			displayName: "Alice",
			role: "ADMIN",
		});
		const { client } = wrap(<SessionMenu />);
		expect(await screen.findByText("Alice · ADMIN")).toBeInTheDocument();

		// TanStack retains the last successful data when a background refetch
		// errors. Session readers must key trust to status, not data presence.
		apiFetch.mockRejectedValue(new Error("network down"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		expect(screen.queryByText("Alice · ADMIN")).not.toBeInTheDocument();
		const logout = screen.getByRole("button", { name: "Sign out" });
		await userEvent.click(logout);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith("/api/auth/logout", {
				method: "POST",
			});
		});
	});

	it("offers the DB-independent sign-out recovery when the first session read fails", async () => {
		apiFetch.mockImplementation((input: string) =>
			input === "/api/auth/session"
				? Promise.reject(new Error("database down"))
				: Promise.resolve({ ok: true }),
		);
		wrap(<SessionMenu />);
		const logout = await screen.findByRole("button", { name: "Sign out" });
		await userEvent.click(logout);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith("/api/auth/logout", {
				method: "POST",
			});
		});
		await waitFor(() => {
			expect(assign).toHaveBeenCalledWith("/login");
		});
	});

	it("renders nothing for an unauthenticated caller", async () => {
		apiFetch.mockResolvedValue({
			mode: "password",
			configured: true,
			authenticated: false,
			loginKind: "password-form",
		});
		const { container } = wrap(<SessionMenu />);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalled();
		});
		expect(container).toBeEmptyDOMElement();
	});
});
