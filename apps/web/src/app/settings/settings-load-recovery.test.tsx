import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { renderWithQuery } from "@/test/render";
import { FeaturesClient } from "./features/features-client";
import { TokensClient } from "./tokens/tokens-client";
import { UsersClient } from "./users/users-client";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
const session = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth/use-session", async () => {
	const { useQuery } = await import("@tanstack/react-query");
	const SESSION_QUERY_KEY = ["auth", "session"] as const;
	const fetchSession = () => session.fetch();
	return {
		SESSION_QUERY_KEY,
		fetchSession,
		useSession: () =>
			useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: fetchSession }),
	};
});
const ownerSession = {
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	organizationId: "00000000-0000-4000-8000-000000000001",
	role: "ADMIN",
	platformOwner: true,
	isImpersonating: false,
	email: "owner@example.com",
} satisfies SessionDto;
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
beforeEach(() => {
	apiFetch.mockReset();
	session.fetch.mockReset().mockResolvedValue(ownerSession);
});
it.each([
	["feature flags", FeaturesClient, { qcVmaf: true }],
	["API tokens", TokensClient, []],
	["users", UsersClient, { users: [] }],
] as const)("recovers the %s list from a failed read", async (_name, Component, data) => {
	apiFetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(data);
	renderWithQuery(<Component />);
	await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
	expect(apiFetch).toHaveBeenCalledTimes(2);
});
it("shows and retries a failed session instead of leaving Users blank", async () => {
	session.fetch
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(ownerSession);
	apiFetch.mockResolvedValue({ users: [] });
	renderWithQuery(<UsersClient />);
	await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
	expect(
		await screen.findByRole("button", { name: "Create user" }),
	).toBeInTheDocument();
	expect(session.fetch).toHaveBeenCalledTimes(2);
});
