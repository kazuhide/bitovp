import { screen, waitFor, within } from "@testing-library/react";
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
	"/settings/tokens",
	"/settings/users",
	"/settings/reset",
	"/settings/organizations",
	"/settings/access-audit",
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

	it("groups the access tasks under 組織・アクセス and never renders the roadmap card", async () => {
		session({ mode: "password" });
		wrap(<SettingsAreas />, "ja");
		expect(await screen.findByText("組織・アクセス")).toBeInTheDocument();
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

describe("SettingsAreas — category panels", () => {
	it("groups each destination once with a concise purpose and keeps personal controls first", async () => {
		session({ mode: "users", role: "ADMIN" });
		wrap(<SettingsAreas />, "ja");
		await screen.findByText("ユーザー");
		const groups: [string, string[]][] = [
			[
				"接続・エンコード",
				[
					"/settings/bitmovin",
					"/settings/credentials",
					"/settings/infrastructure",
					"/settings/live",
				],
			],
			["再生・品質", ["/settings/player", "/settings/features"]],
			[
				"自動化・連携",
				[
					"/settings/watch-folders",
					"/settings/notifications",
					"/settings/webhooks",
				],
			],
			[
				"組織・アクセス",
				[
					"/settings/organizations",
					"/settings/branding",
					"/settings/users",
					"/settings/tokens",
					"/settings/access-audit",
				],
			],
			["詳細・診断", ["/settings/api-coverage"]],
		];
		for (const [name, hrefs] of groups) {
			const panel = screen.getByRole("region", { name });
			const links = within(panel).getAllByRole("link");
			expect(links.map((link) => link.getAttribute("href"))).toEqual(hrefs);
			for (const link of links) {
				expect(link.querySelector("h3")).toBeInTheDocument();
				if (link.getAttribute("href") !== COVERAGE_HREF) {
					expect(link.querySelector("p")?.textContent?.trim()).toBeTruthy();
				}
			}
		}
		const preferences = screen.getByRole("region", { name: "自分の表示設定" });
		expect(within(preferences).getAllByRole("combobox")).toHaveLength(2);
		expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
			"自分の表示設定",
		);
		expect(new Set(areaHrefs()).size).toBe(areaHrefs().length);
		expect(areaHrefs()).not.toContain("/settings/vmaf");
		expect(
			screen
				.getByRole("link", { name: /データのリセット/ })
				.closest("section[aria-labelledby] "),
		).toBeNull();
	});

	it.each([
		"VIEWER",
		"OPERATOR",
	])("keeps readable QC and organization appearance accessible for %s", async (role) => {
		session({ mode: "users", role });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		expect(
			within(
				screen.getByRole("region", { name: "Playback and quality" }),
			).getByRole("link", { name: /Quality control/ }),
		).toHaveAttribute("href", "/settings/features");
		const access = screen.getByRole("region", {
			name: "Organization and access",
		});
		expect(
			within(access)
				.getAllByRole("link")
				.map((a) => a.getAttribute("href")),
		).toEqual(["/settings/branding"]);
	});

	it("hides users-mode tasks for a single owner while retaining organization appearance and tokens", async () => {
		session({ mode: "password" });
		const { client } = wrap(<SettingsAreas />);
		await waitFor(() =>
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"success",
			),
		);
		const access = screen.getByRole("region", {
			name: "Organization and access",
		});
		expect(
			within(access)
				.getAllByRole("link")
				.map((a) => a.getAttribute("href")),
		).toEqual(["/settings/branding", "/settings/tokens"]);
	});
});
