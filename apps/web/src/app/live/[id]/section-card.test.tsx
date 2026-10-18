import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { messagesFor, translate } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { helpKind, SectionCard } from "./section-card";
import { LIVE_LAYERS, LIVE_SECTION_HELP_KEYS } from "./section-layout";

/**
 * . CORRECTION IN PLACE, because the first version of this file
 * proved nothing: I wrote it against "the 15s poll re-asserts `open` and slams
 * the card shut", and the naive `open={defaultOpen}` implementation passed it
 * — React only writes a DOM attribute whose PROP CHANGED, so an unchanged
 * `open` never touches the operator's toggle. The story was wrong; the pin was
 * dead.
 *
 * The REAL hazard is a `defaultOpen` that CHANGES: the page opens whichever
 * card answers the derived next action, and that action moves as the channel
 * transitions (unconnected ingest → on air). Under `open={defaultOpen}` the
 * card the operator is reading closes itself the moment the action moves on.
 * Local state + `onToggle` makes the operator's choice win, and the first test
 * below is written to FAIL against the naive version (verified by reverting).
 */
describe("SectionCard (ledger #103)", () => {
	it("reports actual native open state for bounded child polling, including programmatic open", async () => {
		const changed = vi.fn();
		const view = renderWithQuery(
			<SectionCard id="receipt-card" title="Receipts" onOpenChange={changed}>
				<p>body</p>
			</SectionCard>,
		);
		expect(changed).toHaveBeenLastCalledWith(false);
		await userEvent.click(screen.getByText("Receipts"));
		await waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
		await userEvent.click(screen.getByText("Receipts"));
		await waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
		view.rerender(
			<SectionCard
				id="receipt-card"
				title="Receipts"
				defaultOpen
				onOpenChange={changed}
			>
				<p>body</p>
			</SectionCard>,
		);
		await waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
	});
	it("keeps nested lane details as a focusable fourth-level heading", () => {
		renderWithQuery(
			<SectionCard id="sec-heartbeat" title="Input details" level={4}>
				<p>body</p>
			</SectionCard>,
		);
		const heading = screen.getByRole("heading", {
			name: "Input details",
			level: 4,
		});
		expect(heading).toHaveAttribute("id", "sec-heartbeat-h");
		expect(heading).toHaveAttribute("tabindex", "-1");
	});
	it("does NOT close under the operator when the derived action moves on", () => {
		// The scenario: ingest is unconnected, so the page opens the feeders
		// card; the operator is reading it when ingest connects and the next
		// action becomes ON_AIR — i.e. this card's `defaultOpen` flips true →
		// false. Under `open={defaultOpen}` React writes the change straight
		// to the DOM and the card shuts mid-read.
		const view = renderWithQuery(
			<SectionCard id="sec-x" title="Feeders" summary="0 running" defaultOpen>
				<p>body</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-x") as HTMLDetailsElement;
		expect(card.open).toBe(true);

		view.rerender(
			<SectionCard id="sec-x" title="Feeders" summary="1 running">
				<p>body</p>
			</SectionCard>,
		);
		const after = document.getElementById("sec-x") as HTMLDetailsElement;
		expect(
			after.open,
			"the card must not close itself when the action moves elsewhere",
		).toBe(true);
		expect(after.querySelector("summary")?.textContent).toContain("1 running");
	});

	it("OPENS when it becomes the answer after mount — an alert arriving later", () => {
		// review-234's measured downgrade: the cards mount when the channel
		// query resolves, while alerts are still loading, so a card that
		// becomes urgent afterwards stayed collapsed under a panel saying
		// "review it before anything else". Mount-frozen state cannot fix (1)
		// without causing this; the one-directional effect fixes both.
		const view = renderWithQuery(
			<SectionCard id="sec-a" title="Alerts" summary="0 open">
				<p>body</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-a") as HTMLDetailsElement;
		expect(card.open).toBe(false);

		view.rerender(
			<SectionCard id="sec-a" title="Alerts" summary="1 open" defaultOpen>
				<p>body</p>
			</SectionCard>,
		);
		expect(
			(document.getElementById("sec-a") as HTMLDetailsElement).open,
			"a card that becomes the answer must open",
		).toBe(true);
	});

	it("honours defaultOpen without becoming permanently open", () => {
		renderWithQuery(
			<SectionCard id="sec-y" title="Alerts" defaultOpen>
				<p>body</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-y") as HTMLDetailsElement;
		expect(card.open).toBe(true);
		// And the operator can still close it — a card that reopened itself
		// would be the same defect in the other direction.
		card.open = false;
		fireEvent(card, new Event("toggle", { bubbles: false }));
		expect(card.open).toBe(false);
	});

	it("renders the summary while CLOSED — the whole point of drilling down by choice", () => {
		renderWithQuery(
			<SectionCard id="sec-z" title="Schedule" summary="next START 10:00">
				<p>hidden detail</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-z") as HTMLDetailsElement;
		expect(card.open).toBe(false);
		expect(screen.getByText("next START 10:00")).toBeInTheDocument();
	});
});

/* Title-level help explains operational concepts independently of field-level hints and remains accessible. */
describe("SectionCard title-level help (audit 5c3d97ca §8.5)", () => {
	it("a one-sentence help is an InfoHint named for the title, whose accessible description IS the help", async () => {
		renderWithQuery(
			<SectionCard
				id="sec-h1"
				title="Output monitoring"
				help="One sentence of help."
			>
				<p>body</p>
			</SectionCard>,
		);
		const trigger = screen.getByRole("button", {
			name: "Output monitoring — more information",
		});
		expect(trigger).toHaveAccessibleDescription("One sentence of help.");
		// Beside the heading, inside the summary — visible open or closed.
		expect(document.querySelector("summary")?.contains(trigger)).toBe(true);
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		await userEvent.hover(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"One sentence of help.",
		);
		expect(trigger).toHaveAccessibleDescription("One sentence of help.");
		expect((document.getElementById("sec-h1") as HTMLDetailsElement).open).toBe(
			false,
		);
	});

	it("the Japanese trigger name quotes the title (「…」の説明)", () => {
		renderWithQuery(
			<SectionCard
				id="sec-h1j"
				title="出力モニタリング"
				help="一文の説明です。"
			>
				<p>body</p>
			</SectionCard>,
			"ja",
		);
		expect(
			screen.getByRole("button", { name: "「出力モニタリング」の説明" }),
		).toHaveAccessibleDescription("一文の説明です。");
	});

	it("a multi-sentence help is a HelpOverlay: click opens it, Escape closes it AND returns focus to the trigger, and the open section stays open", async () => {
		renderWithQuery(
			<SectionCard
				id="sec-h2"
				title="Schedule actions"
				help="First sentence. Second sentence."
				defaultOpen
			>
				<p>body</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-h2") as HTMLDetailsElement;
		expect(card.open).toBe(true);
		const trigger = screen.getByRole("button", {
			name: "Schedule actions — more information",
		});
		expect(screen.queryByRole("note")).toBeNull();
		await userEvent.click(trigger);
		expect(screen.getByRole("note")).toHaveTextContent(
			"First sentence. Second sentence.",
		);
		expect(card.open, "opening help must not fold the section").toBe(true);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("note")).toBeNull();
		expect(trigger, "Escape must hand focus back to the trigger").toHaveFocus();
		expect(card.open).toBe(true);
	});

	it("the overlay opens from the keyboard (Enter) and a CLOSED section stays closed", async () => {
		renderWithQuery(
			<SectionCard
				id="sec-h3"
				title="Slate reservations"
				help="First sentence. Second sentence."
			>
				<p>body</p>
			</SectionCard>,
		);
		const card = document.getElementById("sec-h3") as HTMLDetailsElement;
		expect(card.open).toBe(false);
		const trigger = screen.getByRole("button", {
			name: "Slate reservations — more information",
		});
		trigger.focus();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("note")).toHaveTextContent("Second sentence.");
		expect(card.open, "opening help must not unfold the section").toBe(false);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("note")).toBeNull();
		expect(trigger).toHaveFocus();
		expect(card.open).toBe(false);
	});

	it("renders no help mark at all without a help prop", () => {
		renderWithQuery(
			<SectionCard id="sec-h4" title="Plain">
				<p>body</p>
			</SectionCard>,
		);
		expect(document.querySelector("summary button")).toBeNull();
	});

	it("helpKind: one sentence is short; two sentences, or one past 100 code points, are long", () => {
		expect(helpKind("一文の説明です。")).toBe("short");
		expect(helpKind("One sentence of help.")).toBe("short");
		expect(helpKind("label")).toBe("short");
		expect(helpKind("一文目。二文目。")).toBe("long");
		expect(helpKind("First. Second.")).toBe("long");
		expect(helpKind("Is it? Yes!")).toBe("long");
		expect(helpKind(`${"あ".repeat(99)}。`)).toBe("long");
	});

	it("every section help key resolves in BOTH catalogues and carries the four mandatory contents (§14.6)", () => {
		const en = messagesFor("en");
		const ja = messagesFor("ja");
		const keys = [
			...Object.values(LIVE_SECTION_HELP_KEYS),
			...LIVE_LAYERS.flatMap((layer) => (layer.helpKey ? [layer.helpKey] : [])),
		];
		expect(keys.length).toBeGreaterThanOrEqual(10);
		for (const key of keys) {
			expect(translate(en, key).trim(), key).not.toBe("");
			expect(translate(ja, key).trim(), key).not.toBe("");
		}
		// 1. Input state and output monitoring are different observations.
		expect(translate(ja, "liveHelp.heartbeat")).toContain("出力モニタリング");
		expect(translate(en, "liveHelp.heartbeat")).toContain("Output monitoring");
		// 2. A slate insertion is not an input switch / static image overlay /
		//    input-loss slate.
		for (const term of ["input switch", "static image overlay", "input-loss"]) {
			expect(translate(ja, "liveHelp.slate")).toContain(term);
			expect(translate(en, "liveHelp.slate")).toContain(term);
		}
		// 3. Auto-restart explains its trigger and the interruption.
		expect(translate(ja, "ui.everyTimeoutHasAnApiMinimumOf")).toContain(
			"配信が中断",
		);
		expect(translate(en, "ui.everyTimeoutHasAnApiMinimumOf")).toContain(
			"interrupted",
		);
		// 4. Auto-stop may stop before the planned end, and billing runs on.
		for (const key of [
			"liveHelp.runtimeCap",
			"ui.independentOfAutoRestartARestartDoes",
		] as const) {
			expect(translate(ja, key)).toContain("予定している番組終了より前");
			expect(translate(ja, key)).toContain("課金");
			expect(translate(en, key)).toContain("before the planned end");
			expect(translate(en, key)).toContain("billing");
		}
	});
});
