import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { SettingsAreas } from "./settings-areas";

afterEach(() => {
	vi.clearAllMocks();
});

function session(over: Record<string, unknown>) {
	apiFetch.mockResolvedValue({
		mode: "password",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		...over,
	});
}

const ADMIN_AREA_HREFS = [
	"/settings/vmaf",
	"/settings/tokens",
	"/settings/users",
	"/settings/reset",
] as const;

const COVERAGE_HREF = "/settings/api-coverage";

function areaHrefs(): string[] {
	return [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(
		(link) => link.getAttribute("href") ?? "",
	);
}

/**
 * The landing must use the SAME page floors as the nav and direct-URL gate.
 * Written-out hrefs keep this test independent from `PAGE_ACCESS_RULES`.
 */
describe("SettingsAreas — role-aware ADMIN cards", () => {
	it("shows every ADMIN-floor card to a users-mode ADMIN", async () => {
		session({ mode: "users", role: "ADMIN" });
		wrap(<SettingsAreas />);
		await waitFor(() => expect(screen.getByText("Users")).toBeInTheDocument());
		expect(areaHrefs()).toEqual(expect.arrayContaining([...ADMIN_AREA_HREFS]));
		expect(areaHrefs()).toContain(COVERAGE_HREF);
		expect(areaHrefs()).not.toContain("/verification");
	});

	it.each([
		"OPERATOR",
		"VIEWER",
	])("hides every ADMIN-floor card from a users-mode %s", async (role) => {
		session({ mode: "users", role });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		// A floor card proves the list rendered rather than disappearing.
		expect(screen.getByText("Credentials")).toBeInTheDocument();
		expect(areaHrefs()).toContain(COVERAGE_HREF);
		expect(areaHrefs()).not.toEqual(
			expect.arrayContaining([...ADMIN_AREA_HREFS]),
		);
		for (const href of ADMIN_AREA_HREFS) {
			expect(areaHrefs(), href).not.toContain(href);
		}
	});

	it("hides every ADMIN-floor card while the session is loading", () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		wrap(<SettingsAreas />);
		expect(screen.getByText("Credentials")).toBeInTheDocument();
		for (const href of ADMIN_AREA_HREFS) {
			expect(areaHrefs(), href).not.toContain(href);
		}
	});

	it("keeps every ADMIN-floor card hidden when the session refresh fails", async () => {
		apiFetch.mockRejectedValue(new Error("network down"));
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		for (const href of ADMIN_AREA_HREFS) {
			expect(areaHrefs(), href).not.toContain(href);
		}
	});

	it.each([
		["password", "password-form"],
		["none", "disabled"],
	] as const)("preserves the existing single-owner cards in %s mode but keeps Users hidden", async (mode, loginKind) => {
		session({ mode, loginKind });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		expect(screen.getByText("Credentials")).toBeInTheDocument();
		expect(areaHrefs()).toEqual(
			expect.arrayContaining(["/settings/tokens", "/settings/reset"]),
		);
		expect(areaHrefs()).toContain(COVERAGE_HREF);
		expect(areaHrefs()).not.toContain("/settings/users");
	});
});

/**
 * the landing shows only usable tasks,
 * grouped by audience. The historical API census is read-only for VIEWER+;
 * release-verification runs and roadmap cards remain absent.
 */
describe("SettingsAreas — audience sections (row #278)", () => {
	it("offers direct settings links and personal controls without a Basic layer", async () => {
		session({ mode: "password" });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		expect(screen.queryByRole("link", { name: /Basic settings/ })).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "Language" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Appearance" }),
		).toBeInTheDocument();
		for (const href of [
			"/settings/bitmovin",
			"/settings/player",
			"/settings/features",
			"/settings/notifications",
		])
			expect(areaHrefs()).toContain(href);
	});
	it("hides the diagnostics section from a users-mode VIEWER", async () => {
		session({ mode: "users", role: "VIEWER" });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		expect(screen.getByText("Credentials")).toBeInTheDocument();
		expect(screen.queryByText("Operations")).toBeNull();
		expect(screen.queryByText("Authentication and access")).toBeNull();
		expect(screen.queryByText("Supported encoding features")).toBeNull();
		expect(screen.queryByRole("link", { name: /Verification/ })).toBeNull();
		expect(screen.getByRole("link", { name: /API coverage/ })).toHaveAttribute(
			"href",
			COVERAGE_HREF,
		);
	});

	it("does not show internal diagnostics to a users-mode ADMIN", async () => {
		session({ mode: "users", role: "ADMIN" });
		wrap(<SettingsAreas />);
		expect(await screen.findByText("Users")).toBeInTheDocument();
		expect(screen.queryByText("Operations")).toBeNull();
		expect(
			screen.queryByRole("link", { name: /Supported encoding features/ }),
		).toBeNull();
		expect(screen.queryByRole("link", { name: /Verification/ })).toBeNull();
	});

	it("does not show internal diagnostics to the single owner of a password install", async () => {
		session({ mode: "password" });
		wrap(<SettingsAreas />);
		expect(await screen.findByText("Credentials")).toBeInTheDocument();
		expect(screen.queryByText("Operations")).toBeNull();
		expect(screen.queryByRole("link", { name: /Verification/ })).toBeNull();
	});

	it("groups the access tasks under 認証とアクセス and never renders the roadmap card", async () => {
		session({ mode: "password" });
		wrap(<SettingsAreas />, "ja");
		expect(await screen.findByText("認証とアクセス")).toBeInTheDocument();
		expect(
			await screen.findByRole("link", { name: /API トークン/ }),
		).toHaveAttribute("href", "/settings/tokens");
		/* Roadmap-only cards and internal phase labels must not appear in the rendered settings. */
		expect(screen.queryByText("P5")).toBeNull();
		expect(document.body.textContent).not.toMatch(
			/AUTH_MODE|README|OIDC|今後対応/,
		);
		expect(
			screen.getByRole("link", { name: /API カバレッジ/ }),
		).toHaveAttribute("href", COVERAGE_HREF);
		expect(
			screen.queryByText(/最新ソース集計.*過去のパラメータ調査は別欄/),
		).not.toBeInTheDocument();
	});
});
