import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";
import { AppShell } from "./app-shell";
import { NAV_SECTIONS } from "./nav-items";

let pathname = "/vod/jobs";
vi.mock("next/navigation", () => ({
	usePathname: () => pathname,
}));

// The nav filters by the session's role (audit 5c3d97ca MEDIUM-5) and fails
// CLOSED while the answer is pending, so the "same destinations" arms below
// — which compare BOTH shells against the whole IA — need a resolved session.
// A PASSWORD-mode session is the single-owner install with no role model:
// every destination renders. The role matrix lives in nav-list.test.tsx and
// the direct-URL gate in page-access-gate.test.tsx.
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: () =>
		Promise.resolve({
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		}),
}));

beforeEach(() => {
	pathname = "/vod/jobs";
});

function renderShell(qcVmaf = true) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>
			<AppShell>
				<h1>the page</h1>
			</AppShell>
		</FeatureFlagsProvider>,
	);
}

/** The classes a shell element actually carries, as a list rather than a blob. */
function classesOf(element: Element): string[] {
	return element.className.split(/\s+/).filter(Boolean);
}

function desktopColumn(): HTMLElement {
	const aside = document.querySelector("aside");
	if (!aside) {
		throw new Error("no desktop sidebar in the tree");
	}
	return aside as HTMLElement;
}

/**
 * Every destination inside a shell's `NavList`, in document order.
 *
 * `hidden: true` because an OPEN sheet is a modal: Radix marks the rest of the
 * document `aria-hidden`, which is right — and which takes the desktop column
 * out of the accessibility tree the default query walks.
 */
function navHrefs(root: HTMLElement): string[] {
	const nav = within(root).getByRole("navigation", { hidden: true });
	return [...nav.querySelectorAll("a[href]")].map(
		(link) => link.getAttribute("href") ?? "",
	);
}

/**
 * The shell is TWO navigations, and CSS decides which one a viewport gets.
 *
 * Until 2026-08-29 there was one: a `w-60` column rendered at every width, so a
 * 375px phone gave the working area 135px (codex re-audit of main@eb7c983,
 * MODERATE-2). The fix is a pair of classes — `hidden md:flex` on the column and
 * `md:hidden` on the compact bar — and a pair of classes is exactly the sort of
 * thing that survives a refactor in only one of the two places, so both are
 * pinned here by name.
 *
 * jsdom applies no stylesheet, so BOTH shells are in the DOM during these tests.
 * That is why the queries below scope to the `<aside>` and to the dialog rather
 * than reaching for `screen`: a bare `getByRole("link")` would be ambiguous the
 * moment the sheet opens, and a test that only passed because one shell happened
 * to be missing would not be testing this at all.
 */
describe("AppShell responsive shells", () => {
	it("offers a keyboard shortcut past navigation to the current page", () => {
		renderShell();
		const skip = screen.getByRole("link", { name: "Skip to content" });
		expect(skip).toHaveAttribute("href", "#page-content");
		expect(screen.getByRole("main")).toHaveAttribute("id", "page-content");
		expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
	});

	it("hides the 240px column below md and keeps it, unchanged, at md and up", () => {
		renderShell();
		const classes = classesOf(desktopColumn());
		// The whole point: not rendered at all on a narrow viewport…
		expect(classes).toContain("hidden");
		// …and at md the `flex` the column had before this change is restored,
		// alongside the width and stickiness that were never in question.
		expect(classes).toContain("md:flex");
		expect(classes).toContain("w-60");
		expect(classes).toContain("sticky");
		// A plain `flex` would defeat `hidden` at every width.
		expect(classes).not.toContain("flex");
	});

	it("renders the compact bar only below md, as the banner landmark", () => {
		renderShell();
		const bar = screen.getByRole("banner");
		expect(classesOf(bar)).toContain("md:hidden");
		// It is the counterpart of the column's `hidden`: exactly one of the two
		// is present at any width.
		expect(classesOf(bar)).not.toContain("hidden");
	});

	it("gives the main area its screen back below md without moving it at md", () => {
		renderShell();
		const classes = classesOf(screen.getByRole("main"));
		expect(classes).toContain("px-4");
		expect(classes).toContain("md:px-8");
		expect(classes).not.toContain("px-8");
	});

	it.each([
		true,
		false,
	])("offers the sheet the SAME destinations as the column, from one list (qcVmaf=%s)", async (qcVmaf) => {
		// Both flag states (review-344 M1): at the default flag a hand-forked
		// list in the sheet happens to equal the declared set, so only the
		// flag-off arm can tell a fork from the shared component.
		renderShell(qcVmaf);
		// The OPERATOR storage entry renders once the password-mode session has
		// resolved; read both shells only after the column shows it.
		await within(desktopColumn()).findByRole("link", {
			name: "Storage",
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Open the navigation menu" }),
		);
		const fromColumn = navHrefs(desktopColumn());
		const fromSheet = navHrefs(screen.getByRole("dialog"));
		// Derived from the IA, never hand-listed — a nav item added to
		// NAV_SECTIONS must appear in both shells or this fails on both arms.
		const declared = NAV_SECTIONS.flatMap((section) =>
			section.items.map((item) => item.href),
		).filter((href) => qcVmaf || href !== "/qc");
		expect(fromColumn).toEqual(declared);
		expect(fromSheet).toEqual(declared);
	});

	it("marks the active route in the SHEET exactly as the column does (review-344 M1)", async () => {
		// The sheet renders NavList, so aria-current comes with it; a forked list
		// would either drop it or compute it twice. Asserted inside the dialog,
		// against the same route the column marks.
		pathname = "/live";
		renderShell();
		await userEvent.click(
			screen.getByRole("button", { name: "Open the navigation menu" }),
		);
		const sheet = screen.getByRole("dialog");
		const current = within(sheet)
			.getAllByRole("link")
			.filter((a) => a.getAttribute("aria-current") === "page");
		expect(current.map((a) => a.getAttribute("href"))).toEqual(["/live"]);
		const column = desktopColumn();
		// The open dialog aria-hides the rest of the page (Radix), so the
		// column's links are only reachable with `hidden: true` here.
		const columnCurrent = within(column)
			.getAllByRole("link", { hidden: true })
			.filter((a) => a.getAttribute("aria-current") === "page")
			.map((a) => a.getAttribute("href"));
		expect(columnCurrent).toEqual(["/live"]);
	});

	it("marks only the most specific destination current on a nested Settings route", async () => {
		pathname = "/settings/api-coverage";
		renderShell();
		await userEvent.click(
			screen.getByRole("button", { name: "Open the navigation menu" }),
		);
		const sheet = screen.getByRole("dialog");
		const currentHrefs = (root: HTMLElement, hidden = false) =>
			within(root)
				.getAllByRole("link", { hidden })
				.filter((link) => link.getAttribute("aria-current") === "page")
				.map((link) => link.getAttribute("href"));
		expect(currentHrefs(sheet)).toEqual(["/settings"]);
		expect(currentHrefs(desktopColumn(), true)).toEqual(["/settings"]);
	});

	it("carries the QC/VMAF flag filter into the sheet too (ledger #131)", async () => {
		renderShell(false);
		await userEvent.click(
			screen.getByRole("button", { name: "Open the navigation menu" }),
		);
		const sheet = screen.getByRole("dialog");
		// A forked list in the sheet would ship the flag-gated entry to every
		// deployment — the exact regression #131 exists to prevent.
		expect(navHrefs(sheet)).not.toContain("/qc");
		expect(navHrefs(sheet)).toContain("/vod/jobs");
		expect(navHrefs(desktopColumn())).not.toContain("/qc");
	});

	it("still renders neither navigation on the standalone screens", () => {
		for (const standalone of ["/login", "/setup", "/change-password"]) {
			pathname = standalone;
			const view = renderShell();
			expect(document.querySelector("aside"), standalone).toBeNull();
			expect(screen.queryByRole("banner"), standalone).toBeNull();
			view.unmount();
		}
	});
});
