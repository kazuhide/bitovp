import { MAX_RUN_CAP_MARGIN_MINUTES } from "@bitovp/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LOCALES, messagesFor, translate } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn(async () => []);
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: () => apiFetch(),
}));

import { ProgramTimeline } from "@/app/live/program-timeline";
import {
	EMPTY_SCHEDULE_DRAFT,
	ScheduleSection,
	scheduleFromDraft,
} from "./schedule-section";

/**
 *  — the creation-time slot. `scheduleFromDraft` is the single
 * derivation the section, the review summary and the submit body all share,
 * so it gets the direct table tests; the section render proves the inputs
 * actually reach it and the timeline redraws from them.
 */

const DRAFT = {
	...EMPTY_SCHEDULE_DRAFT,
	enabled: true,
	streamUpLocal: "2026-09-01T20:45",
	programStartLocal: "2026-09-01T21:00",
	programEndLocal: "2026-09-01T22:00",
};

describe("scheduleFromDraft", () => {
	// : the file-fed (programFeedKind) tests left WITH the wizard
	// option — pseudo-feeds are created on the feeders screen now. The create
	// route still accepts programFeed and the #96 engine still runs persisted
	// chains; only this wizard entry stopped producing them.

	it("disabled ⇒ ok with NO schedule — the unscheduled contract intact", () => {
		expect(scheduleFromDraft(EMPTY_SCHEDULE_DRAFT)).toEqual({
			ok: true,
			schedule: null,
		});
	});

	it("derives ISO times from the operator's local inputs", () => {
		const v = scheduleFromDraft(DRAFT);
		expect(v.ok).toBe(true);
		if (!v.ok || !v.schedule) {
			throw new Error("unreachable");
		}
		// Local wall-clock in, instants out: the ISO strings must round-trip
		// to the same instants the local inputs named.
		expect(new Date(v.schedule.streamUpAt).getTime()).toBe(
			new Date("2026-09-01T20:45").getTime(),
		);
		expect(new Date(v.schedule.programEndAt).getTime()).toBe(
			new Date("2026-09-01T22:00").getTime(),
		);
		expect(v.schedule.slate).toBeUndefined();
	});

	it("names each ordering violation", () => {
		expect(
			scheduleFromDraft({ ...DRAFT, streamUpLocal: "2026-09-01T21:30" }),
		).toEqual({ ok: false, errorKey: "schedule.errUpAfterStart" });
		expect(
			scheduleFromDraft({ ...DRAFT, programEndLocal: "2026-09-01T21:00" }),
		).toEqual({ ok: false, errorKey: "schedule.errEndBeforeStart" });
		expect(scheduleFromDraft({ ...DRAFT, streamUpLocal: "" })).toEqual({
			ok: false,
			errorKey: "schedule.errIncomplete",
		});
	});

	it("a slate needs a source AND a window", () => {
		expect(scheduleFromDraft({ ...DRAFT, slateEnabled: true })).toEqual({
			ok: false,
			errorKey: "schedule.errNoSlateSource",
		});
		const src = {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bucket: "in",
			key: "slate.mp4",
		};
		expect(
			scheduleFromDraft({
				...DRAFT,
				slateEnabled: true,
				slateSource: src,
				streamUpLocal: DRAFT.programStartLocal,
			}),
		).toEqual({ ok: false, errorKey: "schedule.errZeroSlateWindow" });
		const ok = scheduleFromDraft({
			...DRAFT,
			slateEnabled: true,
			slateSource: src,
		});
		expect(ok.ok).toBe(true);
		if (ok.ok && ok.schedule) {
			expect(ok.schedule.slate?.source).toEqual(src);
		}
	});

	/**
	 * . The slot below is 75 minutes of run (stream-up 20:45 →
	 * end 22:00), so the arms sit either side of a 75-minute timeout. The
	 * comparison is deliberately clock-free — see the function's own comment:
	 * `programEndAt − streamUpAt >= streamTimeoutMinutes` implies the server's
	 * `programEndAt >= provisionAt + streamTimeoutMinutes`, because the server
	 * already requires stream-up to be in the future.
	 */
	it("refuses a slot the plan's streamTimeoutMinutes ends first, at the boundary and past it", () => {
		expect(
			scheduleFromDraft(DRAFT, { streamTimeoutMinutes: 75 }),
		).toMatchObject({
			ok: false,
			errorKey: "schedule.errStreamTimeoutShorterThanSlot",
			params: { minutes: 75, slot: 75 },
		});
		expect(scheduleFromDraft(DRAFT, { streamTimeoutMinutes: 6 }).ok).toBe(
			false,
		);
		// One minute of headroom is enough — the rule is about the slot, not
		// about taste.
		expect(scheduleFromDraft(DRAFT, { streamTimeoutMinutes: 76 }).ok).toBe(
			true,
		);
	});

	it("the CONDITIONAL knobs never refuse a slot, however small", () => {
		expect(
			scheduleFromDraft(DRAFT, {
				bytesReadTimeoutSeconds: 1,
				waitingForFirstConnectTimeoutMinutes: 1,
			}).ok,
		).toBe(true);
	});

	it("no auto-shutdown at all leaves the slot exactly as it was", () => {
		expect(scheduleFromDraft(DRAFT, null)).toEqual(scheduleFromDraft(DRAFT));
		expect(scheduleFromDraft(DRAFT, {})).toEqual(scheduleFromDraft(DRAFT));
	});
});

describe("ScheduleSection", () => {
	it("typing into the inputs reaches the draft, and the error names the violation", async () => {
		let draft = { ...DRAFT, programEndLocal: "" };
		const onPatch = vi.fn((partial: Partial<typeof draft>) => {
			draft = { ...draft, ...partial };
		});
		const view = renderWithQuery(
			<ScheduleSection draft={draft} onPatch={onPatch} />,
		);
		// Incomplete ⇒ the named error is visible.
		// jsdom renders the default (en) catalogue; the ja render sweep owns
		// the translated surface. What matters here is WHICH error.
		expect(screen.getByRole("alert").textContent).toContain(
			"All three slot times",
		);

		// selector: the #129 help triggers carry aria-labels that quote the
		// field label — scope to the input so the query stays unique.
		const end = screen.getByLabelText(
			/チャンネル停止予定時刻|planned channel stop/i,
			{
				selector: "input",
			},
		);
		await userEvent.type(end, "2026-09-01T22:00");
		expect(onPatch).toHaveBeenCalled();

		// Re-render with the completed draft: error gone, timeline drawn.
		view.rerender(<ScheduleSection draft={DRAFT} onPatch={onPatch} />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("figure")).toBeInTheDocument();
	});

	it("teaches the two incident facts in place: auto-start/ramp always, slate-needs-ingest when a slate is on (ledger #95)", () => {
		const view = renderWithQuery(
			<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />,
		);
		expect(screen.getByText(/billing begins/)).toBeInTheDocument();
		expect(screen.queryByText(/covers a CONNECTED input/)).toBeNull();

		view.rerender(
			<ScheduleSection
				draft={{
					...DRAFT,
					slateEnabled: true,
					slateSource: {
						credentialId: "00000000-0000-4000-8000-0000000000c1",
						bucket: "in",
						key: "slate.mp4",
					},
				}}
				onPatch={vi.fn()}
			/>,
		);
		expect(screen.getByText(/covers a CONNECTED input/)).toBeInTheDocument();
	});

	it("the program-feed segment is GONE — external ingest is the only path the wizard produces (ledger #128, retiring review-226 I6's render pin)", () => {
		renderWithQuery(
			<ScheduleSection
				draft={{ ...DRAFT, enabled: true }}
				onPatch={() => {}}
			/>,
		);
		// The radios, the source field and the chain explainer all left with
		// the option; a survivor here means the removal regressed.
		// WHAT THIS PIN DOES NOT REACH (review-260 measured by injection): a
		// re-added file field with no radio and different wording passes it —
		// the real backstop is that the seven catalogue keys are GONE, so a
		// faithful re-introduction must re-add them and move the i18n pins.
		expect(screen.queryByRole("radio")).not.toBeInTheDocument();
		expect(
			screen.queryByText(/ストレージ上のファイル|storage file/i),
		).not.toBeInTheDocument();
	});

	/**
	 * half one. The channel provisions AND STARTS
	 * BILLING at creation (`api/live-channels/route.ts` enqueues `provision`
	 * unconditionally; `deriveProgramSchedule` derives no START row since
	 * #125) — but `schedule.streamUpHint` still described the world before
	 * that, telling the operator the channel provisions AT stream-up, three
	 * lines above `rampHint` saying the opposite.
	 *
	 * The positive half runs through `translate(messagesFor(locale), …)` so it
	 * proves the rendered panel IS this catalogue key and not some other
	 * string. That alone is the lockstep-weak assertion `sidebar.test.tsx`
	 * warns about — reword the value and the expectation follows it — so the
	 * arm that actually pins the COPY is the pair of hardcoded literals below:
	 * the retired sentence must be gone, and the create-time fact must be
	 * present, in words this file states for itself.
	 */
	const RETIRED_DEFERRED_PROVISIONING: Record<string, string> = {
		en: "The channel provisions and goes live at this time",
		ja: "この時刻にプロビジョニングして配信可能になります",
	};
	// the clause names the CHANNEL, the operator's
	// object, not the provider's encoder — same fact, same position.
	const CREATE_TIME_BILLING: Record<string, string> = {
		en: "The channel starts — and billing begins — the moment you create it",
		ja: "作成した時点でチャンネルの起動準備が始まり、課金もそこから始まります",
	};

	for (const locale of LOCALES) {
		it(`the stream-up help says billing starts at CREATION, never that provisioning is deferred (${locale})`, async () => {
			const messages = messagesFor(locale);
			renderWithQuery(
				<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />,
				locale,
			);
			// #129 moved this prose behind a ? overlay, so it is not in the DOM
			// until the trigger is clicked — a test reading the closed form
			// would pass over any copy at all.
			await userEvent.click(
				screen.getByRole("button", {
					name: translate(messages, "uiX.moreInformationFor", {
						label: translate(messages, "schedule.streamUpAt"),
					}),
				}),
			);
			const panel = screen.getByRole("note").textContent ?? "";
			expect(panel).toContain(translate(messages, "schedule.streamUpHint"));
			expect(panel).toContain(CREATE_TIME_BILLING[locale]);
			expect(panel).not.toContain(RETIRED_DEFERRED_PROVISIONING[locale]);
		});

		/**
		 * Half two.  removed the file-fed program from this wizard
		 * on the owner's call and left NOTHING in its place, so the audit read
		 * the silence as a missing feature. The remedy is the signpost, not the
		 * option — and it must not resurrect what #128 removed, which is why
		 * the absence pin below stays in the file unchanged.
		 */
		it(`points a file-fed program at the pseudo-live screen instead of leaving it unexplained (${locale})`, () => {
			const messages = messagesFor(locale);
			renderWithQuery(
				<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />,
				locale,
			);
			expect(
				screen.getByRole("link", {
					name: translate(messages, "nav.pseudoLiveFeeds"),
				}),
			).toHaveAttribute("href", "/live/feeders");
			// : a new tab, so the unsaved wizard draft survives the click.
			expect(
				screen.getByRole("link", {
					name: translate(messages, "nav.pseudoLiveFeeds"),
				}),
			).toHaveAttribute("target", "_blank");
			expect(
				screen.getByText(translate(messages, "schedule.feederPointer"), {
					exact: false,
				}),
			).toBeInTheDocument();
		});
	}

	// Hardcoded, for the same reason `sidebar.test.tsx` writes its nav labels
	// out: a literal cannot move in lockstep with the catalogue.
	it("the pointer is really Japanese under ja, not the English original", () => {
		renderWithQuery(<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />, "ja");
		expect(
			screen.getByRole("link", { name: "疑似ライブ配信" }),
		).toHaveAttribute("href", "/live/feeders");
		expect(
			screen.getByText(/自分のバケットにあるクリップを番組として流す場合/),
		).toBeInTheDocument();
	});

	// The signpost addresses the operator who came looking for a file-fed
	// program, and that operator has no reason to tick "schedule a slot" first.
	it("renders the pointer whether or not a slot is scheduled", () => {
		const view = renderWithQuery(
			<ScheduleSection draft={EMPTY_SCHEDULE_DRAFT} onPatch={vi.fn()} />,
		);
		expect(
			screen.getByRole("link", { name: "Pseudo-Live Feeds" }),
		).toHaveAttribute("href", "/live/feeders");
		view.rerender(<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />);
		expect(
			screen.getByRole("link", { name: "Pseudo-Live Feeds" }),
		).toHaveAttribute("href", "/live/feeders");
	});

	/**
	 * The same defect one hint over. "WITHOUT a slot the channel provisions
	 * immediately" only says something if scheduling a slot changes it — and it
	 * does not, so the sentence taught the very thing `streamUpHint` had just
	 * stopped teaching, in the state an operator sees FIRST (the step opens
	 * with the checkbox off). Literal-pinned for the same reason as the help
	 * arms: a lockstep expectation follows a reworded value.
	 */
	const RETIRED_SLOT_DEFERS: Record<string, string> = {
		en: "Without a slot the channel provisions immediately",
		ja: "枠を設定しない場合、チャンネルは即時プロビジョニングされ",
	};

	for (const locale of LOCALES) {
		it(`the disabled-state hint does not imply a slot defers provisioning (${locale})`, () => {
			const messages = messagesFor(locale);
			renderWithQuery(
				<ScheduleSection draft={EMPTY_SCHEDULE_DRAFT} onPatch={vi.fn()} />,
				locale,
			);
			const hint = screen.getByText(
				translate(messages, "schedule.disabledHint"),
			);
			expect(hint).toBeInTheDocument();
			expect(hint.textContent ?? "").toContain(CREATE_TIME_BILLING[locale]);
			expect(document.body.textContent ?? "").not.toContain(
				RETIRED_SLOT_DEFERS[locale],
			);
		});
	}

	it("the disabled state explains itself instead of rendering dead inputs", () => {
		renderWithQuery(
			<ScheduleSection draft={EMPTY_SCHEDULE_DRAFT} onPatch={vi.fn()} />,
		);
		expect(
			screen.queryByLabelText(/入力送出予定時刻|planned input feed time/i),
		).toBeNull();
	});

	/* Scheduled input delivery must not imply delayed channel provisioning or delayed charges. */
	it.each([
		"en",
		"ja",
	] as const)("always shows the provisioning note (%s), enabled or not, and names the planned times", (locale) => {
		const note =
			locale === "ja"
				? "チャンネルは作成後すぐに起動準備を開始します（入力送出予定時刻まで待機しません）。"
				: "The channel begins starting up as soon as it is created (it does not wait for the planned input feed time).";
		const view = renderWithQuery(
			<ScheduleSection draft={EMPTY_SCHEDULE_DRAFT} onPatch={vi.fn()} />,
			locale,
		);
		expect(screen.getByText(note)).toBeInTheDocument();
		view.rerender(<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />);
		expect(screen.getByText(note)).toBeInTheDocument();
		const labels =
			locale === "ja"
				? ["入力送出予定時刻", "番組開始予定時刻", "チャンネル停止予定時刻"]
				: [
						"Planned input feed time",
						"Planned program start",
						"Planned channel stop",
					];
		for (const label of labels) {
			expect(
				screen.getByLabelText(label, { selector: "input" }),
				label,
			).toBeInTheDocument();
		}
		expect(
			screen.getByLabelText(
				locale === "ja"
					? "番組開始までスレートを挿入"
					: "Insert a slate until the program starts",
			),
		).toBeInTheDocument();
	});
});

describe("ProgramTimeline", () => {
	const UP = new Date("2026-09-01T20:45:00Z");
	const START = new Date("2026-09-01T21:00:00Z");
	const END = new Date("2026-09-01T22:00:00Z");

	it("draws the slate segment and the program to proportion", () => {
		const { container } = renderWithQuery(
			<ProgramTimeline
				streamUpAt={UP}
				programStartAt={START}
				programEndAt={END}
				slate={true}
			/>,
		);
		const slate = container.querySelector('[data-segment="slate"]');
		const program = container.querySelector('[data-segment="program"]');
		// 15 min of 75 = 20% pre-air, 80% program.
		expect(Number.parseFloat((slate as HTMLElement).style.width)).toBe(20);
		expect(Number.parseFloat((program as HTMLElement).style.left)).toBe(20);
	});

	it("overlays row markers with their status", () => {
		const { container } = renderWithQuery(
			<ProgramTimeline
				streamUpAt={UP}
				programStartAt={START}
				programEndAt={END}
				slate={true}
				rows={[
					{
						action: "START",
						status: "FIRED",
						fireAt: "2026-09-01T20:45:00Z",
					},
					{
						action: "STOP",
						status: "ARMED",
						fireAt: "2026-09-01T22:00:00Z",
					},
				]}
			/>,
		);
		expect(
			container.querySelector('[data-marker="START"][data-status="FIRED"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-marker="STOP"][data-status="ARMED"]'),
		).not.toBeNull();
	});

	it("refuses to draw an unordered slot, out loud", () => {
		renderWithQuery(
			<ProgramTimeline
				streamUpAt={END}
				programStartAt={START}
				programEndAt={UP}
				slate={false}
			/>,
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});
});

/**
 *  — the auto-shutdown message ON SCREEN, in both catalogues.
 * Parity tests prove the two catalogues share a key set; only a render proves
 * the section reaches the key at all, with its interpolations filled.
 */
describe("ScheduleSection — auto-shutdown vs the slot", () => {
	const SHORT_TIMEOUT = { streamTimeoutMinutes: 6 };

	/**
	 * the warning names the VALUE, the slot and
	 * the consequence (stops before the planned end) — never the raw property
	 * `streamTimeoutMinutes=`, which the first version of this pin required.
	 */
	it("names the value, the slot length and the early stop — not the raw property (en)", () => {
		renderWithQuery(
			<ScheduleSection
				draft={DRAFT}
				onPatch={vi.fn()}
				autoShutdown={SHORT_TIMEOUT}
			/>,
		);
		const alert = screen.getByRole("alert").textContent ?? "";
		expect(alert).toContain("6 minutes");
		expect(alert).toContain("75-minute slot");
		expect(alert).toContain("before the planned end");
		expect(alert).not.toContain("streamTimeoutMinutes");
	});

	it("names the value, the slot length and the early stop — not the raw property (ja)", () => {
		renderWithQuery(
			<ScheduleSection
				draft={DRAFT}
				onPatch={vi.fn()}
				autoShutdown={SHORT_TIMEOUT}
			/>,
			"ja",
		);
		const alert = screen.getByRole("alert").textContent ?? "";
		expect(alert).toContain("6 分");
		expect(alert).toContain("75 分");
		expect(alert).toContain("予定終了前に停止します");
		expect(alert).not.toContain("streamTimeoutMinutes");
		// Translated, not the English sentence copied across.
		expect(alert).toContain("自動停止");
	});

	it("names the CONDITIONAL knobs as a note instead of refusing (en and ja)", () => {
		const conditional = {
			bytesReadTimeoutSeconds: 3600,
			waitingForFirstConnectTimeoutMinutes: 10,
		};
		const view = renderWithQuery(
			<ScheduleSection
				draft={DRAFT}
				onPatch={vi.fn()}
				autoShutdown={conditional}
			/>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText(/bytesReadTimeoutSeconds=3600/)).toHaveTextContent(
			"waitingForFirstConnectTimeoutMinutes=10",
		);

		view.unmount();
		renderWithQuery(
			<ScheduleSection
				draft={DRAFT}
				onPatch={vi.fn()}
				autoShutdown={conditional}
			/>,
			"ja",
		);
		expect(screen.getByText(/bytesReadTimeoutSeconds=3600/)).toHaveTextContent(
			"自動停止",
		);
	});

	it("says nothing at all when no auto-shutdown is configured", () => {
		renderWithQuery(<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText(/bytesReadTimeoutSeconds/)).toBeNull();
	});

	/**
	 * The runaway-cap preview quotes a number the SERVER will compute
	 * (`deriveProgramSchedule`: span + `MAX_RUN_CAP_MARGIN_MINUTES`). The
	 * expectation is built from the imported constant, not from a literal 30,
	 * so moving the margin in core moves this expectation with it — and a
	 * preview that retyped the number would then disagree with it. The slot is
	 * 20:45 → 22:00, i.e. 75 minutes.
	 */
	it("previews the cap from the SERVER's margin constant, not a retyped 30", () => {
		renderWithQuery(<ScheduleSection draft={DRAFT} onPatch={vi.fn()} />);
		expect(
			screen.getByText(
				`Runaway cap: the channel will hard-stop after ${75 + MAX_RUN_CAP_MARGIN_MINUTES} min even if the scheduled stop cannot fire.`,
			),
		).toBeInTheDocument();
	});
});
