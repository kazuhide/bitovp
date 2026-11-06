import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { renderWithQuery } from "@/test/render";
import { DashboardHome } from "./dashboard-home";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("./dashboard-usage", () => ({
	DashboardUsage: () => <div data-testid="usage" />,
}));
vi.mock("./dashboard-insights", () => ({ DashboardInsights: () => null }));
vi.mock("./dashboard-backfill", () => ({ DashboardBackfill: () => null }));

const account = { id: "account-1", label: "My account" };
let accounts: (typeof account)[];
let providers: string[];
let vodItems: { id: string }[];
let liveItems: { id: string }[];
let session: SessionDto;

function users(role: SessionDto["role"]): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		role,
	};
}

async function fetchData(url: string) {
	if (url === "/api/bitmovin-accounts") return accounts;
	if (url === "/api/credentials")
		return providers.map((provider, i) => ({
			id: `credential-${i}`,
			label: provider,
			provider,
			hasSecret: false,
		}));
	if (url === "/api/encoding-jobs?limit=1")
		return { items: vodItems, nextCursor: null };
	if (url === "/api/live-channels?limit=1")
		return { items: liveItems, nextCursor: null };
	if (url === "/api/auth/session") return session;
	if (url.startsWith("/api/dashboard/usage?")) return { days: [] };
	throw new Error(`Unexpected request: ${url}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	accounts = [];
	providers = [];
	vodItems = [];
	liveItems = [];
	session = users("ADMIN");
	apiFetch.mockImplementation(fetchData);
});

const guide = () =>
	screen.findByRole("region", { name: "Create your first encoding" });

describe("First-encoding dashboard guidance", () => {
	it("leads an empty admin workspace to account setup and hides unused usage controls", async () => {
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).getByRole("list").children).toHaveLength(3);
		expect(
			within(panel).getByRole("link", { name: "Add Bitmovin account" }),
		).toHaveAttribute("href", "/settings/bitmovin");
		expect(
			within(panel).getByRole("link", { name: "Register output destination" }),
		).toHaveAttribute("href", "/settings/credentials");
		expect(screen.queryByRole("link", { name: "Create VOD job" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Panels" })).toBeNull();
		expect(screen.queryByLabelText("From (UTC)")).toBeNull();
		expect(apiFetch).toHaveBeenCalledWith("/api/encoding-jobs?limit=1", {
			signal: expect.any(AbortSignal),
		});
		expect(apiFetch).toHaveBeenCalledWith("/api/live-channels?limit=1", {
			signal: expect.any(AbortSignal),
		});
		expect(
			apiFetch.mock.calls.filter(([url]) => url === "/api/bitmovin-accounts"),
		).toHaveLength(1);
	});

	it("advances from the registered account to output setup while retaining provider usage", async () => {
		accounts = [account];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).getAllByText("Registered")).toHaveLength(1);
		expect(
			within(panel).queryByRole("link", { name: "Add Bitmovin account" }),
		).toBeNull();
		expect(
			within(panel).getByRole("link", { name: "Register output destination" }),
		).toHaveAttribute("href", "/settings/credentials");
		expect(await screen.findByTestId("usage")).toBeVisible();
		expect(screen.getByLabelText("From (UTC)")).toBeVisible();
	});

	it.each([
		"SRT_PASSPHRASE",
		"DRM_CENC",
		"AWS_S3_ROLE_BASED",
	])("does not count input-only or unrelated %s credentials as output setup", async (provider) => {
		accounts = [account];
		providers = [provider];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).getAllByText("Registered")).toHaveLength(1);
		expect(
			within(panel).queryByRole("link", { name: "Create VOD job" }),
		).toBeNull();
	});

	it.each([
		"GCS_HMAC",
		"AWS_S3",
	])("offers both wizards for a registered %s output without claiming a connection test", async (provider) => {
		accounts = [account];
		providers = [provider];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).getAllByText("Registered")).toHaveLength(2);
		expect(
			within(panel).getByRole("link", { name: "Create VOD job" }),
		).toHaveAttribute("href", "/vod/new");
		expect(
			within(panel).getByRole("link", { name: "Create Live channel" }),
		).toHaveAttribute("href", "/live/new");
	});

	it.each([
		"AKAMAI_MSL",
		"LIVE_MEDIA_INGEST",
	])("offers Live with a %s-only output and explains VOD setup", async (provider) => {
		accounts = [account];
		providers = [provider];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(
			within(panel).queryByRole("link", { name: "Create VOD job" }),
		).toBeNull();
		expect(
			within(panel).getByRole("link", { name: "Create Live channel" }),
		).toHaveAttribute("href", "/live/new");
		expect(
			within(panel).getByText(/Register a VOD output destination/),
		).toBeVisible();
	});

	it.each([
		"vod",
		"live",
	])("hides the guide when any %s work exists, even outside the selected period", async (kind) => {
		if (kind === "vod") vodItems = [{ id: "previous-job" }];
		else liveItems = [{ id: "previous-channel" }];
		accounts = [account];
		renderWithQuery(<DashboardHome />);
		await screen.findByTestId("usage");
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/live-channels?limit=1",
				expect.anything(),
			),
		);
		expect(
			screen.queryByRole("region", { name: "Create your first encoding" }),
		).toBeNull();
		expect(
			apiFetch.mock.calls.some(([url]) => url === "/api/credentials"),
		).toBe(false);
	});

	it("does not invent missing setup while history is still loading", async () => {
		apiFetch.mockImplementation((url: string) =>
			url === "/api/encoding-jobs?limit=1"
				? new Promise(() => {})
				: fetchData(url),
		);
		renderWithQuery(<DashboardHome />);
		expect(await screen.findByText("Checking your workspace…")).toBeVisible();
		expect(
			screen.queryByRole("link", { name: "Add Bitmovin account" }),
		).toBeNull();
	});

	it("uses the existing account retry once when the account list fails", async () => {
		let failed = true;
		apiFetch.mockImplementation((url: string) =>
			url === "/api/bitmovin-accounts" && failed
				? Promise.reject(new Error("account list unavailable"))
				: fetchData(url),
		);
		renderWithQuery(<DashboardHome />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"account list unavailable",
		);
		expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
		expect(
			screen.queryByRole("option", { name: "No Bitmovin account configured" }),
		).toBeNull();
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await guide()).toBeVisible();
	});

	it("stops initial guidance when one history query proves existing work and the other fails", async () => {
		vodItems = [{ id: "old-job" }];
		apiFetch.mockImplementation((url: string) =>
			url === "/api/live-channels?limit=1"
				? Promise.reject(new Error("history unavailable"))
				: fetchData(url),
		);
		const rendered = renderWithQuery(<DashboardHome />);
		await waitFor(() =>
			expect(
				rendered.client.getQueryState(["live-channels", "getting-started"])
					?.status,
			).toBe("error"),
		);
		expect(
			screen.queryByText("Could not check your setup progress."),
		).toBeNull();
		expect(
			screen.queryByRole("region", { name: "Create your first encoding" }),
		).toBeNull();
	});

	it("refreshes shared setup progress and hides the guide after the first job is created", async () => {
		accounts = [account];
		const rendered = renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(
			within(panel).queryByRole("link", { name: "Create VOD job" }),
		).toBeNull();
		providers = ["GCS_SERVICE_ACCOUNT"];
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: ["credentials"] });
		});
		expect(
			await within(panel).findByRole("link", { name: "Create VOD job" }),
		).toBeVisible();
		vodItems = [{ id: "new-job" }];
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: ["encoding-jobs"] });
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("region", { name: "Create your first encoding" }),
			).toBeNull(),
		);
	});

	it("does not keep showing cached setup as verified after a credentials refresh fails", async () => {
		accounts = [account];
		providers = ["GCS_HMAC"];
		const rendered = renderWithQuery(<DashboardHome />);
		expect(
			await within(await guide()).findByRole("link", {
				name: "Create VOD job",
			}),
		).toBeVisible();
		apiFetch.mockImplementation((url: string) =>
			url === "/api/credentials"
				? Promise.reject(new Error("refresh unavailable"))
				: fetchData(url),
		);
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: ["credentials"] });
		});
		expect(
			await screen.findByText("Could not check your setup progress."),
		).toBeVisible();
		expect(screen.queryByRole("link", { name: "Create VOD job" })).toBeNull();
	});

	it.each([
		"/api/encoding-jobs?limit=1",
		"/api/live-channels?limit=1",
		"/api/credentials",
	])("shows a retry, not missing configuration, when %s fails", async (failedUrl) => {
		let failed = true;
		apiFetch.mockImplementation((url: string) =>
			url === failedUrl && failed
				? Promise.reject(new Error("unavailable"))
				: fetchData(url),
		);
		renderWithQuery(<DashboardHome />);
		const error = await screen.findByText(
			"Could not check your setup progress.",
		);
		expect(
			screen.queryByRole("link", { name: "Add Bitmovin account" }),
		).toBeNull();
		failed = false;
		fireEvent.click(
			within(error.closest("section") as HTMLElement).getByRole("button", {
				name: "Retry",
			}),
		);
		expect(await guide()).toBeVisible();
	});

	it("keeps registration links hidden for an OPERATOR and asks an administrator", async () => {
		session = users("OPERATOR");
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).queryByRole("link")).toBeNull();
		expect(
			within(panel).getAllByText("Ask an administrator to register this."),
		).toHaveLength(2);
	});

	it("lets an OPERATOR create jobs once shared settings are registered", async () => {
		session = users("OPERATOR");
		accounts = [account];
		providers = ["GCS_HMAC"];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(
			within(panel).getByRole("link", { name: "Create VOD job" }),
		).toBeVisible();
		expect(
			within(panel).queryByRole("link", { name: "Manage output destinations" }),
		).toBeNull();
	});

	it.each([
		false,
		true,
	])("gives a VIEWER useful guidance without creation links (impersonating=%s)", async (impersonating) => {
		session = {
			...users(impersonating ? "ADMIN" : "VIEWER"),
			isImpersonating: impersonating,
		};
		accounts = [account];
		providers = ["GCS_HMAC"];
		renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).queryByRole("link")).toBeNull();
		expect(
			within(panel).getByText(
				"Ask an operator or administrator to create the first job or channel.",
			),
		).toBeVisible();
	});

	it("does not offer actions before permissions resolve or after a cached ADMIN refresh fails", async () => {
		apiFetch.mockImplementation((url: string) =>
			url === "/api/auth/session" ? new Promise(() => {}) : fetchData(url),
		);
		const rendered = renderWithQuery(<DashboardHome />);
		const panel = await guide();
		expect(within(panel).queryByRole("link")).toBeNull();
		await act(async () => {
			rendered.client.setQueryData(SESSION_QUERY_KEY, users("ADMIN"));
		});
		expect(
			await within(panel).findByRole("link", { name: "Add Bitmovin account" }),
		).toBeVisible();
		apiFetch.mockImplementation((url: string) =>
			url === "/api/auth/session"
				? Promise.reject(new Error("refresh failed"))
				: fetchData(url),
		);
		await act(async () => {
			await rendered.client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
		});
		await waitFor(() => expect(within(panel).queryByRole("link")).toBeNull());
		expect(
			within(panel).getByText("Could not check your permissions."),
		).toBeVisible();
	});

	it.each([
		"password",
		"none",
	] as const)("preserves setup actions for single-owner %s mode", async (mode) => {
		session = {
			mode,
			configured: true,
			authenticated: true,
			loginKind: mode === "none" ? "disabled" : "password-form",
		};
		renderWithQuery(<DashboardHome />);
		expect(
			await within(await guide()).findByRole("link", {
				name: "Add Bitmovin account",
			}),
		).toBeVisible();
	});

	it("localizes the first-use path in Japanese", async () => {
		renderWithQuery(<DashboardHome />, "ja");
		const panel = await screen.findByRole("region", {
			name: "最初のエンコードを始めましょう",
		});
		expect(
			within(panel).getByRole("link", { name: "Bitmovin アカウントを登録" }),
		).toHaveAttribute("href", "/settings/bitmovin");
	});
});
