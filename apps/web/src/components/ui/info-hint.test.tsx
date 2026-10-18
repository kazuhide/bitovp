import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { Field } from "./field";
import { InfoHint } from "./info-hint";

/**
 * (UX-03) / UX-06 §5: the help body must be the
 * TRIGGER'S ACCESSIBLE DESCRIPTION, reached by hover, keyboard focus AND
 * click/tap — and "a `role=tooltip` node exists in the DOM" is not a passing
 * assertion. That is exactly what the first version of this file checked,
 * over a component that never associated the two elements: a screen reader
 * on the button heard "more information" and nothing else, and a touch user
 * had no path at all.
 *
 * Every assertion below therefore resolves `aria-describedby` or reads the
 * computed accessible description, and reachability is a BEFORE/AFTER pair
 * on the `hidden` attribute — the component's only visibility mechanism —
 * so "reachable by hover" is measured rather than inferred from a class name.
 */
describe("InfoHint — the help text is the trigger's accessible description", () => {
	it("associates trigger and tooltip: aria-describedby resolves to the body, and the description reads it", () => {
		render(
			<InfoHint text="hello world" label="Edge offset — more information" />,
		);
		const trigger = screen.getByRole("button", {
			name: "Edge offset — more information",
		});
		const id = trigger.getAttribute("aria-describedby");
		expect(id, "the trigger names no description").toBeTruthy();
		const tooltip = document.getElementById(id as string);
		expect(tooltip?.getAttribute("role")).toBe("tooltip");
		expect(tooltip?.textContent).toBe("hello world");
		// The accessibility tree, not the DOM: the body is read on focus whether
		// or not the tooltip is showing — a directly referenced node counts even
		// while `hidden`.
		expect(trigger).toHaveAccessibleDescription("hello world");
	});

	it("gives every instance its own tooltip id, each resolving to its own body", () => {
		render(
			<>
				<InfoHint text="first" label="A" />
				<InfoHint text="second" label="B" />
			</>,
		);
		const a = screen.getByRole("button", { name: "A" });
		const b = screen.getByRole("button", { name: "B" });
		const idA = a.getAttribute("aria-describedby") as string;
		const idB = b.getAttribute("aria-describedby") as string;
		expect(idA).toBeTruthy();
		expect(idA).not.toBe(idB);
		expect(document.getElementById(idA)?.textContent).toBe("first");
		expect(document.getElementById(idB)?.textContent).toBe("second");
		expect(a).toHaveAccessibleDescription("first");
		expect(b).toHaveAccessibleDescription("second");
	});

	it("is hidden until reached, and reachable by HOVER", async () => {
		render(<InfoHint text="hover me" label="A" />);
		const tooltip = () => screen.getByRole("tooltip", { hidden: true });
		expect(tooltip()).not.toBeVisible();
		await userEvent.hover(screen.getByRole("button", { name: "A" }));
		expect(tooltip()).toBeVisible();
		await userEvent.unhover(screen.getByRole("button", { name: "A" }));
		await waitFor(() => expect(tooltip()).not.toBeVisible());
	});

	it("is reachable by KEYBOARD FOCUS, and Escape dismisses it WITHOUT moving focus (WCAG 1.4.13)", async () => {
		render(<InfoHint text="focus me" label="A" />);
		const tooltip = () => screen.getByRole("tooltip", { hidden: true });
		expect(tooltip()).not.toBeVisible();
		await userEvent.tab();
		const trigger = screen.getByRole("button", { name: "A" });
		expect(trigger).toHaveFocus();
		expect(tooltip()).toBeVisible();
		await userEvent.keyboard("{Escape}");
		expect(tooltip()).not.toBeVisible();
		expect(trigger).toHaveFocus();
	});

	it("is reachable by CLICK/TAP — the path with neither hover nor focus — and a second click dismisses it", () => {
		render(<InfoHint text="tap me" label="A" />);
		const tooltip = () => screen.getByRole("tooltip", { hidden: true });
		const trigger = screen.getByRole("button", { name: "A" });
		// `fireEvent.click` alone: a tap on a device that emulates neither hover
		// nor focus (mobile Safari focuses no button on tap).
		fireEvent.click(trigger);
		expect(tooltip()).toBeVisible();
		fireEvent.click(trigger);
		expect(tooltip()).not.toBeVisible();
	});

	it("an ordinary browser click pins the tooltip even when hover/focus made it visible before click", async () => {
		const user = userEvent.setup();
		render(<InfoHint text="pin me" label="A" />);
		const tooltip = () => screen.getByRole("tooltip", { hidden: true });
		const trigger = screen.getByRole("button", { name: "A" });

		// userEvent models the real pointer/focus events that precede click. The
		// old toggle inspected aggregate visibility, so this first click CLOSED
		// the help that hover/focus had just opened instead of pinning it.
		await user.click(trigger);
		expect(tooltip()).toBeVisible();
		await user.unhover(trigger);
		expect(tooltip()).toBeVisible();

		await user.click(trigger);
		expect(tooltip()).not.toBeVisible();
	});

	it("a pinned tooltip closes on an outside click, so a tap elsewhere puts it away", async () => {
		render(
			<div>
				<InfoHint text="pinned" label="A" />
				<p>elsewhere</p>
			</div>,
		);
		const tooltip = () => screen.getByRole("tooltip", { hidden: true });
		fireEvent.click(screen.getByRole("button", { name: "A" }));
		expect(tooltip()).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireEvent.pointerDown(screen.getByText("elsewhere"));
		expect(tooltip()).not.toBeVisible();
	});

	it("owns its click — an ancestor's handler never sees it (the mark lives inside <summary>)", () => {
		const seen: string[] = [];
		render(
			// A real interactive ancestor, as help-overlay-propagation.test does:
			// `<summary>` IS interactive, and a bare click inside one toggles the
			// section the help was meant to explain.
			<button type="button" onClick={() => seen.push("ancestor")}>
				<InfoHint text="text" label="A" />
			</button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "A" }));
		expect(seen).toEqual([]);
	});

	it("names the trigger for its subject via labelFor, in both catalogues", () => {
		render(<InfoHint text="x" labelFor="Edge offset" />);
		expect(
			screen.getByRole("button", { name: "Edge offset — more information" }),
		).toBeInTheDocument();
	});

	it("names the trigger for its subject in Japanese too", () => {
		render(<InfoHint text="x" labelFor="出力モニタリング" />, "ja");
		expect(
			screen.getByRole("button", { name: "「出力モニタリング」の説明" }),
		).toBeInTheDocument();
	});

	it("falls back to a default accessible name", () => {
		render(<InfoHint text="x" />);
		expect(
			screen.getByRole("button", { name: "More information" }),
		).toBeInTheDocument();
	});
});

describe("Field with tooltip", () => {
	it("renders the label, and an ⓘ whose accessible description is the help text", () => {
		render(
			<Field label="X" htmlFor="x" tooltip="hello world">
				<input id="x" />
			</Field>,
		);
		expect(screen.getByText("X")).toBeInTheDocument();
		// The ⓘ trigger derives its accessible name from the field label, and
		// its DESCRIPTION from the tooltip — the pair a screen reader hears.
		const trigger = screen.getByRole("button", {
			name: "X — more information",
		});
		expect(trigger).toHaveAccessibleDescription("hello world");
	});

	it("omits the tooltip affordance entirely when no tooltip is given", () => {
		render(
			<Field label="Y" htmlFor="y" hint="just a hint">
				<input id="y" />
			</Field>,
		);
		expect(
			screen.queryByRole("tooltip", { hidden: true }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("just a hint")).toBeInTheDocument();
	});
});
