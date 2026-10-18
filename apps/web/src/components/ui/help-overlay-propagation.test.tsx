import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collapsible } from "@/app/vod/new/wizard-fields";
import { renderLocalized as render } from "@/test/render";
import { HelpOverlay } from "./help-overlay";

afterEach(() => vi.restoreAllMocks());

/**
 * WHAT THIS FILE CAN AND CANNOT PIN, measured rather than assumed.
 *
 * The trigger calls BOTH `preventDefault` and `stopPropagation`, and only
 * the second is testable here:
 *
 *   remove stopPropagation → 1 test fails (the ancestor-handler case below)
 *   remove preventDefault  → 35 tests pass — SURVIVES
 *
 * That is not a hole to plug, it is jsdom: `preventDefault` exists to stop the
 * NATIVE toggle of a `<details>` when the trigger sits inside its `<summary>`,
 * and jsdom implements no `<details>` toggling at all, so no unit test in this
 * runner can distinguish it — and the browser check that was supposed to
 * cover it only ran the arm WITH the guard, where "the section stayed open" is
 * equally explained by "a button in a summary never closes it" (review-129
 * F2). The missing arm has now been run against the built image:
 *
 *   with preventDefault    → panel shown, open section stays open, closed stays closed
 *   without preventDefault → IDENTICAL, both directions
 *
 * So the line has no measured job. It stays because a control that navigates
 * nowhere should have no default action, not because of the <details> story
 * its first comment told.
 *
 * One more thing this cost, recorded because it nearly produced a wrong
 * contradiction of the reviewer: my first run of the missing arm reported "the
 * panel does not open without the guard". That was the PROBE — it looked for
 * the panel inside the <details>, and the panel had just been portalled to
 * document.body. The instrument measured the old DOM shape.
 */
describe("HelpOverlay's trigger owns its event (ledger #129)", () => {
	it("does not reach an ancestor's click handler", async () => {
		// The reason: inside a <summary>, a bare click also toggles the
		// <details> — the section collapses under the panel it just opened.
		const onAncestorClick = vi.fn();
		render(
			// A real interactive ancestor rather than a <div> with a handler:
			// `<summary>` IS interactive, so a button models it more honestly
			// than a static element — and biome refuses the static one, which
			// is the same objection that moved this logic onto the trigger in
			// the first place.
			<button type="button" onClick={onAncestorClick}>
				<HelpOverlay label="help">text</HelpOverlay>
			</button>,
		);
		await userEvent.click(screen.getByRole("button", { name: "help" }));
		expect(screen.getByText("text")).toBeInTheDocument();
		expect(onAncestorClick).not.toHaveBeenCalled();
	});

	it("still opens and closes on its own", async () => {
		render(<HelpOverlay label="help">text</HelpOverlay>);
		const b = screen.getByRole("button", { name: "help" });
		await userEvent.click(b);
		expect(screen.getByText("text")).toBeInTheDocument();
		await userEvent.click(b);
		expect(screen.queryByText("text")).toBeNull();
	});

	it("is reachable and operable by KEYBOARD alone", async () => {
		// Tab to it, Enter to open, Escape to close — the path a keyboard user
		// takes, and the one a stopPropagation change could plausibly break.
		render(<HelpOverlay label="help">text</HelpOverlay>);
		await userEvent.tab();
		expect(screen.getByRole("button", { name: "help" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByText("text")).toBeInTheDocument();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByText("text")).toBeNull();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "help" })).toHaveFocus(),
		);
	});
});

describe("the panel escapes its container and stays anchored (review-129 G2/G3/G4/G5)", () => {
	/**
	 * Every one of these defended a fix that had cost a review round and was
	 * held in place only by a comment. Each mutation below passed all 2,749
	 * tests before these existed.
	 */
	function openPanel() {
		render(
			<details open>
				<summary className="select-none">
					section
					<HelpOverlay labelFor="section">prose</HelpOverlay>
				</summary>
				body
			</details>,
		);
		return screen.getByRole("button", { name: /section/ });
	}

	it("G2 — renders the panel OUTSIDE the summary, in document.body", async () => {
		// The whole of F1: a <summary> exempts only form controls from its
		// activation behaviour, so a panel inside it folds the section when the
		// operator clicks the prose. Replacing `createPortal` with a bare span
		// reinstates that exactly, and survived the suite until this line.
		await userEvent.click(openPanel());
		const panel = screen.getByRole("note");
		expect(panel.parentElement?.parentElement).toBe(document.body);
		expect(document.querySelector("summary")?.contains(panel)).toBe(false);
	});

	it("G3 — a mousedown INSIDE the panel does not close it", async () => {
		// The portal made the containment clause necessary: the panel is no
		// longer a descendant of the root, so asking the root alone closes the
		// panel on its own content — clicking a word, or drag-selecting the
		// prose, which is the very thing F4 restored.
		await userEvent.click(openPanel());
		const panel = screen.getByRole("note");
		fireEvent.mouseDown(panel);
		expect(screen.getByRole("note")).toBeInTheDocument();
	});

	it("G5 — focus moves into the panel, so the ✕ is not behind the whole page", async () => {
		// Portalling put the panel last in document order. Without this the ✕
		// sits behind every remaining control on the page.
		await userEvent.click(openPanel());
		await waitFor(() => {
			expect(screen.getByRole("note")).toHaveFocus();
		});
	});
});

describe("Collapsible renders the mark itself (review-129 G1)", () => {
	/**
	 * The call-site guard in `input-files-editor.test.tsx` asserts what is
	 * WRITTEN; this asserts what is RENDERED. Neither alone covers the
	 * component in the middle — with only the first, making `Collapsible` draw
	 * `help` as an always-on `<p>` again (the owner's entire ask, reverted)
	 * passed 2,749 tests.
	 */
	it("puts help behind a ? in the summary, not on the page", async () => {
		render(
			<Collapsible summary="セクション" help="説明文です">
				body
			</Collapsible>,
		);
		expect(screen.queryByText("説明文です")).toBeNull();
		const summary = document.querySelector("summary");
		// Language-independent: `renderLocalized` defaults to EN, so a Japanese
		// selector here found nothing and reported "no help trigger" about a
		// trigger that was there. The mark is the only button in the summary.
		const trigger = summary?.querySelector("button");
		expect(trigger, "no help trigger inside the summary").toBeTruthy();
		expect(
			trigger?.getAttribute("aria-label"),
			"the trigger does not name its section",
		).toContain("セクション");
		await userEvent.click(trigger as HTMLElement);
		expect(screen.getByText("説明文です")).toBeInTheDocument();
	});

	it("names the trigger for its section, not with the bare section name", () => {
		render(
			<Collapsible summary="セクション" help="説明文です">
				body
			</Collapsible>,
			"ja",
		);
		const trigger = document.querySelector("summary button");
		// The section name alone tells a screen-reader user nothing about what
		// the button does — this is the interpolated form `Field` uses.
		expect(trigger?.getAttribute("aria-label")).toBe("「セクション」の説明");
	});
});
