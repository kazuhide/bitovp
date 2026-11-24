import { onlineManager } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PageAccessGate } from "@/components/page-access-gate";
import { renderWithQuery } from "@/test/render";
import { Organizations } from "./organizations/organizations";
import SettingsPage from "./page";

vi.mock("@/lib/server/build-info", () => ({
	getWebBuildInfo: () => ({ version: "1" }),
}));
vi.mock("@/lib/i18n/metadata", () => ({
	localizedTitle: () => () => ({ title: "Settings" }),
}));
vi.mock("./settings-areas", () => ({ SettingsAreas: () => null }));

const fake = vi.hoisted(() => ({
	api: vi.fn(),
	session: vi.fn(),
	memory: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<typeof import("@/lib/api")>()),
	apiFetch: fake.api,
}));

const endpoint = "/api/platform/redis-memory";
const owner = {
	mode: "users",
	authenticated: true,
	configured: true,
	role: "VIEWER",
	platformOwner: true,
	isImpersonating: false,
};
beforeEach(() => {
	vi.resetAllMocks();
	fake.session.mockResolvedValue(owner);
	fake.memory.mockResolvedValue({
		usedBytes: 1024 * 1024,
		limitBytes: 4 * 1024 * 1024,
	});
	fake.api.mockImplementation(async (path: string) =>
		path === endpoint
			? fake.memory()
			: path === "/api/auth/session"
				? fake.session()
				: { organizations: [] },
	);
});
it("shows used and configured Redis memory, refreshes, and discards a stale reading on failure", async () => {
	showSettings();
	expect(
		await screen.findByText("Used 1.0 MB · Limit 4.0 MB"),
	).toBeVisible();
	fake.memory.mockRejectedValue(new Error("sensitive endpoint"));
	await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
	expect(await screen.findByText("Queue memory usage is unavailable.")).toBeVisible();
	expect(screen.queryByText(/1\.0 MB|sensitive endpoint/)).toBeNull();
});
it("shows an unset Redis limit distinctly in Japanese", async () => {
	fake.memory.mockResolvedValue({ usedBytes: 1024 * 1024, limitBytes: null });
	showSettings("ja");
	expect(
		await screen.findByText("使用中 1.0 MB・上限未設定"),
	).toBeVisible();
});
it("renders a truncated HTTP 200 JSON body as unavailable", async () => {
	const { apiFetch } =
		await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	fake.memory.mockImplementation(async () => {
		const request = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response('{"usedBytes":1', { status: 200 }));
		try {
			return await apiFetch(endpoint);
		} finally {
			request.mockRestore();
		}
	});
	showSettings();
	expect(await screen.findByText("Queue memory usage is unavailable.")).toBeVisible();
});
it.each([
	{},
	{ usedBytes: -2, limitBytes: null },
	{ usedBytes: 1, limitBytes: 0 },
])("rejects an incomplete or invalid successful reading (%j)", async (value) => {
	fake.memory.mockResolvedValue(value);
	showSettings();
	expect(await screen.findByText("Queue memory usage is unavailable.")).toBeVisible();
});
it.each([
	{ platformOwner: false },
	{ isImpersonating: true },
	{ mustChangePassword: true },
])("hides the instance reading and never requests it for %j", async (overrides) => {
	fake.session.mockResolvedValue({ ...owner, ...overrides });
	const { client } = showSettings();
	await vi.waitFor(() =>
		expect(client.getQueryState(["auth", "session"])?.status).toBe("success"),
	);
	expect(
		screen.queryByRole("heading", { name: "Job queue memory" }),
	).toBeNull();
	expect(fake.api.mock.calls.some(([url]) => url === endpoint)).toBe(false);
});

function showSettings(locale: "en" | "ja" = "en") {
	return renderWithQuery(
		<PageAccessGate pathname="/settings">
			<SettingsPage />
		</PageAccessGate>,
		locale,
	);
}
it.each([
	"VIEWER",
	"OPERATOR",
])("keeps the Settings reading reachable for a platform owner with %s membership", async (role) => {
	fake.session.mockResolvedValue({ ...owner, role });
	showSettings();
	expect(
		await screen.findByText("Used 1.0 MB · Limit 4.0 MB"),
	).toBeVisible();
});
it("keeps the reading on the organization recovery page for an owner without an active membership", async () => {
	fake.session.mockResolvedValue({
		...owner,
		role: "ADMIN",
		organizationUnavailable: true,
	});
	renderWithQuery(
		<PageAccessGate pathname="/settings/organizations">
			<Organizations />
		</PageAccessGate>,
	);
	expect(
		await screen.findByText("Used 1.0 MB · Limit 4.0 MB"),
	).toBeVisible();
});
it("replaces an old reading when refreshed offline", async () => {
	showSettings();
	await screen.findByText("Used 1.0 MB · Limit 4.0 MB");
	try {
		act(() => onlineManager.setOnline(false));
		fake.memory.mockRejectedValue(new TypeError("Failed to fetch"));
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(
			await screen.findByText("Queue memory usage is unavailable."),
		).toBeVisible();
		expect(screen.queryByText(/1\.0 MB/)).toBeNull();
	} finally {
		act(() => onlineManager.setOnline(true));
	}
});
