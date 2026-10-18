import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import type { Locale } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { DESKTOP_MEDIA_QUERY, MobileNav } from "./mobile-nav";

let pathname = "/vod/jobs";
vi.mock("next/navigation", () => ({
	usePathname: () => pathname,
}));

vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: () => new Promise(() => {}),
}));

beforeEach(() => {
	pathname = "/vod/jobs";
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const OPEN_MENU = "Open the navigation menu";

function renderNav(locale: Locale = "en") {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf: true }}>
			<MobileNav />
		</FeatureFlagsProvider>,
		locale,
	);
}

/**
 * The trigger, captured as a NODE.
 *
 * Re-querying it by role after the sheet opens returns nothing: an open Radix
 * dialog is modal, so it marks everything outside the portal `aria-hidden`, and
 * the bar is outside the portal. The element itself is the same node throughout,
 * so hold on to it rather than teaching every assertion about `hidden: true`.
 */
function trigger(): HTMLElement {
	return screen.getByRole("button", { name: OPEN_MENU });
}

/**
 * The below-`md` navigation.
 *
 * Everything asserted here is a claim about WIRING, not about Radix: Radix
 * supplies the dismissal, the focus trap and the focus return, and the failure
 * this file guards is the trigger being rebuilt as a plain button, or the panel
 * being left mounted over the page the operator just navigated to. Each test
 * therefore fails if the primitive is swapped out or the effect is dropped, and
 * none of them re-tests Radix's own internals.
 */
describe("MobileNav", () => {
	it("names its trigger and reports the panel that trigger controls", async () => {
		renderNav();
		const button = trigger();
		// Closed: the label is the only thing a screen reader has to go on, and
		// the state is announced before anything is opened.
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("dialog")).toBeNull();

		await userEvent.click(button);

		const panel = screen.getByRole("dialog");
		expect(button).toHaveAttribute("aria-expanded", "true");
		// Not a hardcoded id: the assertion is that the two are WIRED, which is
		// what a hand-rolled button would break while still carrying an
		// aria-controls string.
		expect(button.getAttribute("aria-controls")).toBe(panel.id);
		expect(panel.id).not.toBe("");
		expect(panel).toHaveAccessibleName("Navigation");
	});

	it("closes when the route changes", async () => {
		const view = renderNav();
		await userEvent.click(trigger());
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		// The link inside the sheet does not unmount the shell, so without the
		// pathname effect the operator lands on the new page underneath a panel
		// they then have to dismiss by hand.
		pathname = "/live";
		view.rerender(
			<FeatureFlagsProvider flags={{ qcVmaf: true }}>
				<MobileNav />
			</FeatureFlagsProvider>,
		);

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes on Escape and hands focus back to the trigger", async () => {
		renderNav();
		const button = trigger();
		await userEvent.click(button);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await userEvent.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// Verified rather than assumed: a keyboard user who dismisses the sheet
		// must not be dropped at the top of the document.
		await waitFor(() => expect(button).toHaveFocus());
	});

	it("closes from the panel's own close button", async () => {
		renderNav();
		await userEvent.click(trigger());
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Close",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes when the viewport widens past md while the sheet is open", async () => {
		// The panel is portalled to <body>, OUTSIDE the bar's `md:hidden`, so
		// widening the window would otherwise leave it covering the desktop
		// sidebar it exists to replace. jsdom implements no matchMedia at all
		// (measured), which is why the component feature-detects it and why this
		// arm has to supply one.
		const listeners = new Set<(event: MediaQueryListEvent) => void>();
		const queries: string[] = [];
		vi.stubGlobal("matchMedia", (query: string) => {
			queries.push(query);
			return {
				matches: false,
				media: query,
				addEventListener: (_: string, cb: unknown) => {
					listeners.add(cb as (event: MediaQueryListEvent) => void);
				},
				removeEventListener: (_: string, cb: unknown) => {
					listeners.delete(cb as (event: MediaQueryListEvent) => void);
				},
			};
		});

		renderNav();
		await userEvent.click(trigger());
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(queries).toContain(DESKTOP_MEDIA_QUERY);

		act(() => {
			for (const listener of listeners) {
				listener({ matches: true } as MediaQueryListEvent);
			}
		});

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	/**
	 * HARDCODED Japanese, for the reason sidebar.test.tsx spells out: an
	 * expectation computed with the same `translate(messagesFor(locale), …)`
	 * call the component makes moves in lockstep with any mutation to the
	 * catalogue lookup and stays green. A literal cannot.
	 */
	it("labels the trigger and heads the panel in Japanese under ja", async () => {
		renderNav("ja");
		const jaTrigger = screen.getByRole("button", {
			name: "ナビゲーションメニューを開く",
		});
		expect(screen.queryByRole("button", { name: OPEN_MENU })).toBeNull();

		await userEvent.click(jaTrigger);

		expect(screen.getByRole("dialog")).toHaveAccessibleName("ナビゲーション");
		expect(screen.queryByText("Navigation")).toBeNull();
	});
});
