import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

/**
 *  §6 / review-32 m4 — the Users screen: the ADMIN-only page gate
 * (defence in depth over the API's own 403), the shown-once temporary
 * password, and the last-admin refusal surfacing.
 */

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { UsersClient } from "./users-client";

const ADMIN_SESSION = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	role: "ADMIN",
	platformOwner: true,
	organizationId: "00000000-0000-4000-8000-000000000001",
	email: "admin@example.com",
	displayName: "Admin",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("UsersClient", () => {
	it("organization ADMIN can edit membership but cannot create global users or reissue passwords", async () => {
		apiFetch.mockImplementation((path: string) =>
			path === "/api/auth/session"
				? Promise.resolve({ ...ADMIN_SESSION, platformOwner: false })
				: Promise.resolve({
						users: [
							{
								id: "other",
								email: "other@example.com",
								displayName: "Other",
								role: "VIEWER",
								active: true,
								mustChangePassword: false,
								lastLoginAt: null,
								createdAt: "2026-10-04T00:00:00.000Z",
							},
						],
					}),
		);
		renderWithQuery(<UsersClient />);
		await screen.findByText("other@example.com");
		const help = screen.getByRole("button", {
			name: "Users — more information",
		});
		expect(screen.queryByRole("note")).toBeNull();
		await userEvent.click(help);
		expect(screen.getByRole("note")).toHaveTextContent("VIEWER");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("note")).toBeNull();
		expect(screen.getByLabelText("Change role")).toBeVisible();
		expect(screen.queryByText("Create a user")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
	});
	it("owner view-as cannot render membership CRUD even when target role is ADMIN", async () => {
		apiFetch.mockImplementation((path: string) => {
			if (path === "/api/auth/session")
				return Promise.resolve({ ...ADMIN_SESSION, isImpersonating: true });
			throw Error("View-as cannot list users");
		});
		renderWithQuery(<UsersClient />);
		await screen.findByText(/This area is for administrators/);
		expect(apiFetch.mock.calls.some((call) => call[0] === "/api/users")).toBe(
			false,
		);
	});
	it("refuses to render the CRUD to a non-admin, and never fetches the user list", async () => {
		apiFetch.mockImplementation((path: string) => {
			if (path === "/api/auth/session") {
				return Promise.resolve({ ...ADMIN_SESSION, role: "VIEWER" });
			}
			throw new Error("VIEWER must not reach /api/users");
		});
		renderWithQuery(<UsersClient />);
		await waitFor(() =>
			expect(
				screen.getByText(/This area is for administrators/),
			).toBeInTheDocument(),
		);
		expect(screen.queryByText("Create a user")).toBeNull();
		expect(apiFetch.mock.calls.some((c) => c[0] === "/api/users")).toBe(false);
	});

	it("shows the temporary password ONCE and PURGES it from the mutation cache on dismiss (review-286 M6)", async () => {
		apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
			if (path === "/api/auth/session") return Promise.resolve(ADMIN_SESSION);
			if (path === "/api/users" && init?.method === "POST") {
				return Promise.resolve({
					user: { email: "new@example.com" },
					temporaryPassword: "TEMP-abc123",
				});
			}
			if (path === "/api/users") return Promise.resolve({ users: [] });
			throw new Error(`unexpected ${path}`);
		});
		const { client } = renderWithQuery(<UsersClient />);
		await waitFor(() =>
			expect(screen.getByText("Create a user")).toBeInTheDocument(),
		);
		await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
		await userEvent.type(screen.getByLabelText("Display name"), "New");
		await userEvent.click(screen.getByRole("button", { name: "Create user" }));
		await waitFor(() =>
			expect(screen.getByText("TEMP-abc123")).toBeInTheDocument(),
		);
		// Before dismiss the secret is in the mutation cache, so the DOM
		// removal alone is not enough — the test asserts the CACHE, not just
		// the <pre>. (The mutation OBSERVER's copy — not reachable from a
		// queryClient the way the cache Set is — is cleared by reset in
		// dismissSecret; review-286 measured that clear alone leaves it.)
		const secretInCache = () =>
			JSON.stringify(
				client
					.getMutationCache()
					.getAll()
					.map((m) => m.state.data),
			).includes("TEMP-abc123");
		expect(secretInCache()).toBe(true);
		await userEvent.click(
			screen.getByRole("button", { name: "I sent it — dismiss" }),
		);
		expect(screen.queryByText("TEMP-abc123")).toBeNull();
		expect(secretInCache()).toBe(false);
	});

	it("surfaces the last-admin refusal from the API error", async () => {
		apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
			if (path === "/api/auth/session") return Promise.resolve(ADMIN_SESSION);
			if (path === "/api/users" && init?.method !== "POST") {
				return Promise.resolve({
					users: [
						{
							id: "admin-1",
							email: "admin@example.com",
							displayName: "Admin",
							role: "ADMIN",
							platformOwner: true,
							organizationId: "00000000-0000-4000-8000-000000000001",
							active: true,
							mustChangePassword: false,
							lastLoginAt: null,
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					],
				});
			}
			if (path === "/api/users/admin-1" && init?.method === "PATCH") {
				throw new Error(
					"This is the last active ADMIN — promote another admin first",
				);
			}
			throw new Error(`unexpected ${path}`);
		});
		renderWithQuery(<UsersClient />);
		await waitFor(() =>
			expect(screen.getByText("admin@example.com")).toBeInTheDocument(),
		);
		await userEvent.selectOptions(
			screen.getByLabelText("Change role"),
			"VIEWER",
		);
		await waitFor(() =>
			expect(screen.getByText(/last active ADMIN/)).toBeInTheDocument(),
		);
	});

	it("routes the signed-in user to password change instead of offering a self-reset", async () => {
		apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
			if (path === "/api/auth/session") return Promise.resolve(ADMIN_SESSION);
			if (path === "/api/users" && init?.method !== "POST") {
				return Promise.resolve({
					users: [
						{
							id: "admin-1",
							email: "admin@example.com",
							displayName: "Admin",
							role: "ADMIN",
							platformOwner: true,
							organizationId: "00000000-0000-4000-8000-000000000001",
							active: true,
							mustChangePassword: false,
							lastLoginAt: null,
							createdAt: "2026-08-23T00:00:00.000Z",
						},
						{
							id: "operator-1",
							email: "operator@example.com",
							displayName: "Operator",
							role: "OPERATOR",
							active: true,
							mustChangePassword: false,
							lastLoginAt: null,
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					],
				});
			}
			throw new Error(`unexpected ${path}`);
		});
		renderWithQuery(<UsersClient />);
		const selfRow = (await screen.findByText("admin@example.com")).closest(
			"li",
		);
		const otherRow = screen.getByText("operator@example.com").closest("li");
		expect(selfRow).not.toBeNull();
		expect(otherRow).not.toBeNull();
		expect(
			within(selfRow as HTMLElement).queryByRole("button", {
				name: "Reset password",
			}),
		).toBeNull();
		expect(
			within(selfRow as HTMLElement).getByRole("link", {
				name: "Change my password",
			}),
		).toHaveAttribute("href", "/change-password");
		expect(
			within(otherRow as HTMLElement).getByRole("button", {
				name: "Reset password",
			}),
		).toBeInTheDocument();
	});
});
