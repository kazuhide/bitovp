import type { UserRole } from "@bitovp/db";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import type { Locale } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { AppShell } from "./app-shell";

let pathname = "/settings/users";
vi.mock("next/navigation", () => ({
	usePathname: () => pathname,
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

beforeEach(() => {
	vi.clearAllMocks();
	pathname = "/settings/users";
	window.history.replaceState({}, "", "/");
});

function usersSession(
	role: UserRole,
	overrides: Partial<SessionDto> = {},
): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		displayName: "Alice",
		role,
		...overrides,
	};
}

const EN_BODY =
	"You do not have permission to view this screen. Ask an administrator for access.";
const JA_BODY =
	"この画面を表示する権限がありません。管理者にアクセス権を依頼してください。";
const EN_UNVERIFIED =
	"Your permissions could not be confirmed. Reload the page or try again.";
const EN_REAUTHENTICATE =
	"Your session has expired or was revoked. Sign in again to continue.";
const JA_REAUTHENTICATE =
	"セッションの有効期限が切れたか、無効になりました。続行するには、もう一度サインインしてください。";

/**
 * Rendered THROUGH the shell, not as a bare `PageAccessGate`: the gate only
 * covers a direct URL because `AppShell` mounts it around every page, and a
 * test that rendered the gate on its own would stay green after that mount
 * was removed.
 */
function renderAt(path: string, locale: Locale = "en") {
	pathname = path;
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf: true }}>
			<AppShell>
				<h1>the page</h1>
			</AppShell>
		</FeatureFlagsProvider>,
		locale,
	);
}

describe("PageAccessGate — a direct URL to a privileged page (audit 5c3d97ca MEDIUM-5 / AU-01)", () => {
	it("shows a VIEWER at /settings/users the permission screen naming the required and current roles (en)", async () => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderAt("/settings/users");
		expect(await screen.findByRole("alert")).toHaveTextContent(EN_BODY);
		expect(
			screen.getByRole("heading", { name: "Permission required" }),
		).toBeInTheDocument();
		const roles = screen.getByText("Required role: ADMIN · Your role: VIEWER");
		expect(roles).toBeInTheDocument();
		expect(roles).toHaveClass("text-zinc-400");
		expect(roles).not.toHaveClass("text-zinc-500");
		expect(
			screen.getByRole("link", { name: "Back to the dashboard" }),
		).toHaveAttribute("href", "/");
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("says the same in Japanese, roles included", async () => {
		apiFetch.mockResolvedValue(usersSession("OPERATOR"));
		renderAt("/settings/users", "ja");
		expect(await screen.findByRole("alert")).toHaveTextContent(JA_BODY);
		expect(
			screen.getByRole("heading", { name: "アクセス権限がありません" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("必要なロール: ADMIN ／ 現在のロール: OPERATOR"),
		).toBeInTheDocument();
		expect(screen.queryByText(EN_BODY)).not.toBeInTheDocument();
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it.each([
		"/verification",
		"/settings/api-coverage",
	])("does not treat retired internal route %s as an ADMIN product page", async (path) => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderAt(path);
		expect(await screen.findByText("the page")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each([
		"/settings/users",
		"/settings/tokens",
		"/settings/reset",
	])("covers the ADMIN-only settings child %s from the shell, not from the page", async (path) => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderAt(path);
		expect(await screen.findByRole("alert")).toHaveTextContent(EN_BODY);
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it.each([
		"/vod/new",
		"/live/new",
		"/storage",
	])("refuses a VIEWER before they enter the OPERATOR workflow at %s", async (path) => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderAt(path);
		expect(await screen.findByRole("alert")).toHaveTextContent(EN_BODY);
		expect(screen.getByText(/Required role: OPERATOR/)).toBeInTheDocument();
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("renders a floor page (/vod/jobs) at once, without waiting for the session", () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		renderAt("/vod/jobs");
		expect(screen.getByText("the page")).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("renders the Settings landing to a VIEWER — the landing reads at the floor", async () => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderAt("/settings");
		expect(await screen.findByText("the page")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("keeps a privileged page CLOSED while the session loads — the checking state, never the page and never a premature refusal", () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		renderAt("/settings/users");
		expect(
			screen.getByRole("status", { name: "Checking your permissions…" }),
		).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
		expect(screen.queryByText(EN_BODY)).not.toBeInTheDocument();
	});

	it("offers a retry when the session cannot be read, and a successful retry lets the page through", async () => {
		apiFetch
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValue(usersSession("ADMIN"));
		renderAt("/settings/users");
		expect(await screen.findByRole("alert")).toHaveTextContent(EN_UNVERIFIED);
		expect(screen.queryByText("the page")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(await screen.findByText("the page")).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});

	it("closes a privileged page when a background session refresh fails after a cached ADMIN answer", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN"));
		const { client } = renderAt("/settings/users");
		expect(await screen.findByText("the page")).toBeInTheDocument();

		apiFetch.mockRejectedValue(new Error("network down"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(EN_UNVERIFIED);
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("keeps a confirmed revocation sticky when the next session refresh fails", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN", { authenticated: false }));
		const { client } = renderAt("/vod/jobs");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			EN_REAUTHENTICATE,
		);
		expect(screen.queryByText("the page")).not.toBeInTheDocument();

		apiFetch.mockRejectedValue(new Error("network down"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(EN_REAUTHENTICATE);
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("sends a stale tab with authenticated:false to the local sign-in return path", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN", { authenticated: false }));
		renderAt("/settings/users");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			EN_REAUTHENTICATE,
		);
		expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
			"href",
			"/login?next=%2Fsettings%2Fusers",
		);
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("preserves query-driven page state across reauthentication", async () => {
		apiFetch.mockResolvedValue(
			usersSession("VIEWER", { authenticated: false }),
		);
		window.history.replaceState({}, "", "/qc/compare?jobs=A,B");
		renderAt("/qc/compare");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			EN_REAUTHENTICATE,
		);
		expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
			"href",
			"/login?next=%2Fqc%2Fcompare%3Fjobs%3DA%2CB",
		);
	});

	it.each([
		["users", usersSession("ADMIN", { authenticated: false })],
		[
			"password",
			{
				mode: "password",
				configured: true,
				authenticated: false,
				loginKind: "password-form",
			} satisfies SessionDto,
		],
	] as const)("does not expose a floor page after a successful unauthenticated %s-mode refresh", async (_mode, session) => {
		apiFetch.mockResolvedValue(session);
		renderAt("/vod/jobs");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			EN_REAUTHENTICATE,
		);
		expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
			"href",
			"/login?next=%2Fvod%2Fjobs",
		);
		expect(screen.queryByText("the page")).not.toBeInTheDocument();
	});

	it("offers the same explicit reauthentication action in Japanese", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN", { authenticated: false }));
		renderAt("/settings/users", "ja");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			JA_REAUTHENTICATE,
		);
		expect(
			screen.getByRole("link", { name: "もう一度サインイン" }),
		).toHaveAttribute("href", "/login?next=%2Fsettings%2Fusers");
		expect(screen.queryByText(EN_REAUTHENTICATE)).toBeNull();
	});

	it("renders a privileged settings page to a password-mode install as today — there is no role to refuse", async () => {
		apiFetch.mockResolvedValue({
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		} satisfies SessionDto);
		renderAt("/settings/users");
		expect(await screen.findByText("the page")).toBeInTheDocument();
	});

	it("keeps the page closed after a role change expires the old cookie, then accepts the new role only after reauthentication", async () => {
		// PATCH /api/users/:id advances sessionsValidFrom. The old cookie first
		// becomes unauthenticated; it cannot observe an in-place promotion.
		let answer: SessionDto = usersSession("VIEWER");
		apiFetch.mockImplementation(() => Promise.resolve(answer));
		const { client } = renderAt("/settings/users");
		expect(await screen.findByRole("alert")).toHaveTextContent(EN_BODY);

		answer = {
			mode: "users",
			configured: true,
			authenticated: false,
			loginKind: "password-form",
		};
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await waitFor(() => {
			expect(screen.getByRole("alert")).toHaveTextContent(EN_REAUTHENTICATE);
		});
		expect(screen.queryByText("the page")).not.toBeInTheDocument();

		answer = usersSession("ADMIN");
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		expect(await screen.findByText("the page")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("leaves the standalone screens outside the gate — /change-password renders while the session is still pending", () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		renderAt("/change-password");
		expect(screen.getByText("the page")).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
