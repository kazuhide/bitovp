import type { UserRole } from "@bitovp/db";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY } from "@/lib/auth/use-session";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import type { Locale } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { AppShell } from "./app-shell";
import { NAV_SECTIONS } from "./nav-items";

let pathname = "/vod/jobs";
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
	pathname = "/vod/jobs";
});

function usersSession(role: UserRole): SessionDto {
	return {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		displayName: "Alice",
		role,
	};
}

const PASSWORD_SESSION: SessionDto = {
	mode: "password",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
};

const NONE_SESSION: SessionDto = {
	mode: "none",
	configured: true,
	authenticated: true,
	loginKind: "disabled",
};

/**
 * What each role sees, WRITTEN OUT. Deriving this from `NAV_SECTIONS` and
 * `canAccess` would move in lockstep with any mutation to either; a literal
 * cannot. The QC entry is flag-gated on top (the QC/VMAF feature flag the
 * component already filters on), so the arms that
 * run with the flag OFF drop `/qc` from the same lists.
 */
const FLOOR = [
	"/",
	"/vod/jobs",
	"/live",
	"/live/feeders",
	"/qc",
	"/library",
	"/presets",
	"/settings",
];
const OPERATOR_ONLY = ["/storage"];
const EXPECTED: Record<UserRole, string[]> = {
	VIEWER: FLOOR,
	OPERATOR: [
		"/",
		"/vod/jobs",
		"/live",
		"/live/feeders",
		"/qc",
		"/library",
		"/storage",
		"/presets",
		"/settings",
	],
	ADMIN: [
		"/",
		"/vod/jobs",
		"/live",
		"/live/feeders",
		"/qc",
		"/library",
		"/storage",
		"/presets",
		"/settings",
	],
};

function withFlag(hrefs: string[], qcVmaf: boolean): string[] {
	return hrefs.filter((href) => qcVmaf || href !== "/qc");
}

function renderShell(locale: Locale = "en", qcVmaf = true) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>
			<AppShell>
				<h1>the page</h1>
			</AppShell>
		</FeatureFlagsProvider>,
		locale,
	);
}

function desktopColumn(): HTMLElement {
	const aside = document.querySelector("aside");
	if (!aside) {
		throw new Error("no desktop sidebar in the tree");
	}
	return aside as HTMLElement;
}

/** Every destination inside a shell's `NavList`, in document order. */
function navHrefs(root: HTMLElement): string[] {
	const nav = within(root).getByRole("navigation", { hidden: true });
	return [...nav.querySelectorAll("a[href]")].map(
		(link) => link.getAttribute("href") ?? "",
	);
}

async function openSheet(): Promise<HTMLElement> {
	await userEvent.click(
		screen.getByRole("button", { name: "Open the navigation menu" }),
	);
	return screen.getByRole("dialog");
}

/**
 * Both shells' link sets, read AFTER the session has resolved: the identity
 * line the footer's SessionMenu renders from the same cache is the anchor,
 * so an assertion below never passes on the pre-resolution (fail-closed)
 * render by accident — for VIEWER and OPERATOR the two states look alike.
 */
async function bothShellsOnceResolved(anchor: string | RegExp) {
	await screen.findAllByText(anchor);
	const column = navHrefs(desktopColumn());
	const sheet = navHrefs(await openSheet());
	return { column, sheet };
}

/**
 * The role filter, asserted on BOTH shells
 * from one render: jsdom applies no stylesheet, so the desktop column and the
 * mobile sheet are both in the DOM, and each is read inside its own root.
 */
describe("NavList role filter", () => {
	it("uses one Templates destination in desktop and mobile navigation", async () => {
		pathname = "/presets";
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderShell("ja");
		await screen.findAllByText("Alice · VIEWER");
		await userEvent.click(
			screen.getByRole("button", { name: "ナビゲーションメニューを開く" }),
		);
		for (const root of [desktopColumn(), screen.getByRole("dialog")]) {
			const nav = within(root).getByRole("navigation", { hidden: true });
			expect(within(nav).getByText("テンプレート")).toHaveAttribute(
				"href",
				"/presets",
			);
			expect(nav.querySelectorAll('[href="/presets"]')).toHaveLength(1);
			expect(nav.querySelector('[href="/presets"]')).toHaveAttribute(
				"aria-current",
				"page",
			);
			expect(nav.querySelector('[href="/templates"]')).toBeNull();
			expect(within(nav).queryByText("プリセット")).toBeNull();
		}
	});

	it("storage is the only privileged navigation destination — a hand-written pin", () => {
		const privileged = NAV_SECTIONS.flatMap((section) => section.items)
			.filter((item) => item.minRole !== "VIEWER")
			.map((item) => item.href)
			.sort();
		expect(privileged).toEqual([...OPERATOR_ONLY].sort());
		for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
			expect(item.audience, item.href).toBe(
				item.href === "/settings" ? "operator" : "customer",
			);
		}
	});

	it.each(
		(["ADMIN", "OPERATOR", "VIEWER"] as const).flatMap((role) =>
			[true, false].map((qcVmaf) => [role, qcVmaf] as const),
		),
	)("%s sees the same role-filtered list in the column and in the sheet (qcVmaf=%s)", async (role, qcVmaf) => {
		apiFetch.mockResolvedValue(usersSession(role));
		renderShell("en", qcVmaf);
		const { column, sheet } = await bothShellsOnceResolved(`Alice · ${role}`);
		expect(column).toEqual(withFlag(EXPECTED[role], qcVmaf));
		expect(sheet).toEqual(withFlag(EXPECTED[role], qcVmaf));
	});

	it("hides the privileged links in BOTH shells while the session is still loading (fail closed, no flicker)", async () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		renderShell();
		const column = navHrefs(desktopColumn());
		const sheet = navHrefs(await openSheet());
		expect(column).toEqual(FLOOR);
		expect(sheet).toEqual(FLOOR);
	});

	it("keeps the privileged links hidden when the session cannot be read, and the floor links still render", async () => {
		apiFetch.mockRejectedValue(new Error("network down"));
		const { client } = renderShell();
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		const column = navHrefs(desktopColumn());
		const sheet = navHrefs(await openSheet());
		expect(column).toEqual(FLOOR);
		expect(sheet).toEqual(FLOOR);
	});

	it("drops cached ADMIN links when a background session refresh fails", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN"));
		const { client } = renderShell();
		await screen.findAllByText("Alice · ADMIN");
		expect(navHrefs(desktopColumn())).toEqual(EXPECTED.ADMIN);

		apiFetch.mockRejectedValue(new Error("network down"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await waitFor(() => {
			expect(client.getQueryState([...SESSION_QUERY_KEY])?.status).toBe(
				"error",
			);
		});
		expect(navHrefs(desktopColumn())).toEqual(FLOOR);
		const sheet = await openSheet();
		expect(navHrefs(sheet)).toEqual(FLOOR);
	});

	it("shows every destination to a password-mode install — no role model, today's behaviour", async () => {
		apiFetch.mockResolvedValue(PASSWORD_SESSION);
		renderShell();
		const { column, sheet } = await bothShellsOnceResolved("Sign out");
		expect(column).toEqual(EXPECTED.ADMIN);
		expect(sheet).toEqual(EXPECTED.ADMIN);
	});

	it("shows every destination to an AUTH_MODE=none install too", async () => {
		apiFetch.mockResolvedValue(NONE_SESSION);
		renderShell();
		const { column, sheet } = await bothShellsOnceResolved(/Auth is disabled/);
		expect(column).toEqual(EXPECTED.ADMIN);
		expect(sheet).toEqual(EXPECTED.ADMIN);
	});

	it("renders no heading over a section the role cannot enter", async () => {
		apiFetch.mockResolvedValue(usersSession("VIEWER"));
		renderShell();
		await screen.findAllByText("Alice · VIEWER");
		expect(
			within(desktopColumn()).queryByText("Diagnostics"),
		).not.toBeInTheDocument();
		// The other headings survive — a filter that dropped every heading
		// would also pass a bare absence check.
		expect(within(desktopColumn()).getByText("System")).toBeInTheDocument();
	});

	it("never exposes retired release or endpoint-census destinations to an ADMIN", async () => {
		apiFetch.mockResolvedValue(usersSession("ADMIN"));
		renderShell("ja");
		const column = desktopColumn();
		await within(column).findByText("システム");
		expect(within(column).queryByText("診断")).toBeNull();
		expect(navHrefs(column)).not.toContain("/verification");
		expect(navHrefs(column)).not.toContain("/settings/api-coverage");
	});

	it("closes both shells when a role change expires the old cookie, then uses the new role only after reauthentication", async () => {
		// PATCH /api/users/:id advances sessionsValidFrom. The old cookie does
		// NOT observe a new role in place: /api/auth/session first returns
		// authenticated:false, and only a newly issued cookie can resolve it.
		let answer: SessionDto = usersSession("ADMIN");
		apiFetch.mockImplementation(() => Promise.resolve(answer));
		const { client } = renderShell();
		await screen.findAllByText("Alice · ADMIN");
		expect(navHrefs(desktopColumn())).toEqual(EXPECTED.ADMIN);

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
			expect(navHrefs(desktopColumn())).toEqual(FLOOR);
		});

		answer = usersSession("VIEWER");
		await act(async () => {
			await client.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY] });
		});
		await screen.findAllByText("Alice · VIEWER");
		expect(navHrefs(desktopColumn())).toEqual(FLOOR);
		expect(navHrefs(await openSheet())).toEqual(FLOOR);
	});
});
