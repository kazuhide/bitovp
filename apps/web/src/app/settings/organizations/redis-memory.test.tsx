import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { Organizations } from "./organizations";

const fake = vi.hoisted(() => ({
	api: vi.fn(),
	session: vi.fn(),
	memory: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: fake.api,
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: fake.session }));
const endpoint = "/api/platform/redis-memory";
const owner = {
	mode: "users",
	authenticated: true,
	platformOwner: true,
	isImpersonating: false,
};
beforeEach(() => {
	vi.resetAllMocks();
	fake.session.mockReturnValue({ status: "success", data: owner });
	fake.memory.mockResolvedValue({
		usedBytes: 1024 * 1024,
		limitBytes: 4 * 1024 * 1024,
	});
	fake.api.mockImplementation(async (path: string) =>
		path === endpoint ? fake.memory() : { organizations: [] },
	);
});
it("shows used and configured Redis memory, refreshes, and discards a stale reading on failure", async () => {
	renderWithQuery(<Organizations />);
	expect(
		await screen.findByText("Used 1.0 MB · Redis limit 4.0 MB"),
	).toBeVisible();
	fake.memory.mockRejectedValue(new Error("sensitive endpoint"));
	await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
	expect(await screen.findByText("Redis memory is unavailable.")).toBeVisible();
	expect(screen.queryByText(/1\.0 MB|sensitive endpoint/)).toBeNull();
});
it("shows an unset Redis limit distinctly in Japanese", async () => {
	fake.memory.mockResolvedValue({ usedBytes: 1024 * 1024, limitBytes: null });
	renderWithQuery(<Organizations />, "ja");
	expect(
		await screen.findByText("使用中 1.0 MB・Redis 上限未設定"),
	).toBeVisible();
});
it.each([
	{ platformOwner: false },
	{ isImpersonating: true },
	{ mustChangePassword: true },
])("hides the instance reading and never requests it for %j", async (overrides) => {
	fake.session.mockReturnValue({
		status: "success",
		data: { ...owner, ...overrides },
	});
	renderWithQuery(<Organizations />);
	expect(
		screen.queryByRole("heading", { name: "Instance Redis memory" }),
	).toBeNull();
	expect(fake.api.mock.calls.some(([url]) => url === endpoint)).toBe(false);
});
