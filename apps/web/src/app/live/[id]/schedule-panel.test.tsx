import { feederError } from "@bitovp/core";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { RuntimeCapPanel } from "./runtime-cap-panel";
import { SchedulePanel } from "./schedule-panel";

/**
 *  PR2 — the schedule panel: upcoming/history split, the slate
 * form appearing ONLY for SLATE_IN with its READY-only picker, cancel
 * hitting the DELETE route, and the ja render (the i18n rule: a new panel
 * ships translated, not catalogued-later).
 */

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c3";
const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000a3";

const ROWS = [
	{
		id: "up-1",
		action: "START",
		fireAt: "2099-01-01T09:00:00.000Z",
		status: "ARMED",
		insertableContentId: null,
		slateDurationSeconds: null,
		firedAt: null,
		note: null,
		error: null,
		createdAt: "2026-08-13T00:00:00.000Z",
	},
	{
		id: "hist-1",
		action: "STOP",
		fireAt: "2026-08-01T10:00:00.000Z",
		status: "MISSED",
		insertableContentId: null,
		slateDurationSeconds: null,
		firedAt: null,
		note: "overdue by 17m — grace is 10m",
		error: null,
		createdAt: "2026-08-01T00:00:00.000Z",
	},
];

function mockRoutes(over: { content?: unknown[] } = {}) {
	apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
		if (path.endsWith("/schedules") && !init?.method) {
			return ROWS;
		}
		if (path.includes("/insertable-content")) {
			return { items: over.content ?? [] };
		}
		if (init?.method === "DELETE") {
			return { id: "up-1", status: "CANCELED" };
		}
		if (init?.method === "PATCH") {
			return { id: CHANNEL_ID, maxRunMinutes: 90 };
		}
		return ROWS;
	});
}

function renderPanel(locale: "en" | "ja" = "en") {
	return renderWithQuery(
		<SchedulePanel
			channelId={CHANNEL_ID}
			status="STOPPED"
			bitmovinAccountId={ACCOUNT_ID}
		/>,
		locale,
	);
}

/**
 * the arm form and the fired history are DISCLOSED now — the panel
 * opens with the programme timeline and the upcoming rows, because "what fires
 * next" is the everyday question and arming one is not.
 * Every test below that reaches a form field or a fired row therefore says so
 * first; a test that stopped needing this call would be a test whose subject
 * had drifted back above the fold.
 */
const openArm = (locale: "en" | "ja" = "en") =>
	userEvent.click(
		screen.getByRole("button", {
			name: locale === "ja" ? "予約を追加" : "Schedule an action",
		}),
	);
const openHistory = (locale: "en" | "ja" = "en") =>
	userEvent.click(
		screen.getByRole("button", {
			name:
				locale === "ja"
					? "実行済み・取り消し済みを表示"
					: "Show past and cancelled rows",
		}),
	);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("SchedulePanel", () => {
	it("tells the operator an ARMED slate is waiting on ingest — RUNNING channel, no connected input (ledger #95)", async () => {
		apiFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/schedules")) {
				return [
					{
						id: "slate-1",
						action: "SLATE_IN",
						fireAt: "2026-08-13T09:00:00.000Z",
						status: "ARMED",
						insertableContentId: "c-1",
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-13T00:00:00.000Z",
					},
				];
			}
			return { items: [] };
		});
		renderWithQuery(
			<SchedulePanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
				ingestConnected={false}
			/>,
		);
		expect(
			await screen.findByText(/waiting for a CONNECTED input/),
		).toBeInTheDocument();

		// Same rows, connected input: the banner has nothing to say.
		cleanup();
		renderWithQuery(
			<SchedulePanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
				ingestConnected={true}
			/>,
		);
		// Wait for the rows to land (the en label for SLATE_IN), then the
		// banner must have nothing to say.
		await screen.findAllByText(/slate/i);
		expect(screen.queryByText(/waiting for a CONNECTED input/)).toBeNull();
	});

	it("a LOST cancel race gives localized recovery and refetches the true state", async () => {
		// The sweep claims the row in the same instant the operator clicks
		// Cancel — the exact race the DELETE route exists for. Before this
		// pin, NOTHING changed on screen and the row read ARMED for up to
		// 15s while the encoding provisioned and billed (#48's lesson).
		let schedulesFetches = 0;
		apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
			if (init?.method === "DELETE") {
				throw new ApiError(
					409,
					"Only ARMED schedules can be cancelled (status: FIRED)",
					{ code: "SCHEDULE_NOT_CANCELLABLE", status: "FIRED" },
				);
			}
			if (path.endsWith("/schedules") && !init?.method) {
				schedulesFetches += 1;
				return ROWS;
			}
			if (path.includes("/insertable-content")) {
				return { items: [] };
			}
			return ROWS;
		});
		renderPanel("ja");
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "キャンセル" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"このスケジュールアクションはすでに FIRED のためキャンセルできません。スケジュールを更新して最新の状態を確認してください。",
		);
		expect(alert).not.toHaveTextContent("Only ARMED");
		// And the list was refetched so the TRUE state replaces stale ARMED.
		expect(schedulesFetches).toBeGreaterThan(1);
	});

	it("a #125 schedule (STOP row alone) still draws the timeline — Up equals On-air, never the false unordered alert (review-260 125-A1)", async () => {
		// #125 stopped deriving START rows, so a plain scheduled create's
		// earliest row is its STOP at programEndAt. Anchoring stream-up to
		// min(rows) alone put Up AFTER On-air and tripped the ordering guard:
		// the operator was accused of a mistake the product made. The anchor
		// now takes min(rows, programStartAt). The legacy fixture above (a
		// persisted START row from a pre-#125 channel) keeps its distinct
		// stream-up mark through the same min.
		apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
			if (path.endsWith("/schedules") && !init?.method) {
				return [
					{
						id: "stop-1",
						action: "STOP",
						fireAt: "2099-01-01T21:00:00.000Z",
						status: "ARMED",
						insertableContentId: null,
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-18T00:00:00.000Z",
					},
				];
			}
			if (path.includes("/insertable-content")) {
				return { items: [] };
			}
			return [];
		});
		renderWithQuery(
			<SchedulePanel
				channelId={CHANNEL_ID}
				status="RUNNING"
				bitmovinAccountId={ACCOUNT_ID}
				programStartAt="2099-01-01T19:00:00.000Z"
				programEndAt="2099-01-01T21:00:00.000Z"
			/>,
			"en",
		);
		await screen.findByText("ARMED");
		expect(screen.queryByText(/out of order/i)).not.toBeInTheDocument();
	});

	it("splits rows into upcoming (ARMED) and history, with note text visible", async () => {
		mockRoutes();
		renderPanel();
		// The MISSED row renders under History with its sweep note — the
		// operator sees WHY it never fired, not just a red badge. (findBy:
		// "Start channel (START)" exists statically as an <option>, so it cannot
		// gate on the query having resolved.)
		// the WORD is the badge, the raw code rides beside
		// it as a secondary — both must render.
		expect(await screen.findByText("Reserved")).toBeInTheDocument();
		expect(screen.getByText("ARMED")).toBeInTheDocument();
		await openHistory();
		expect(await screen.findByText("Not run")).toBeInTheDocument();
		expect(screen.getByText("MISSED")).toBeInTheDocument();
		expect(
			screen.getByText("overdue by 17m — grace is 10m"),
		).toBeInTheDocument();
	});

	it("cancel fires the DELETE route for the row", async () => {
		mockRoutes();
		renderPanel();
		await screen.findByText("ARMED");
		const cancelButton = screen.getByRole("button", {
			name: "Cancel",
		});
		await userEvent.click(cancelButton);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/live-channels/${CHANNEL_ID}/schedules/up-1`,
				{ method: "DELETE" },
			);
		});
	});

	it("the slate form appears ONLY for SLATE_IN and its picker lists READY content only", async () => {
		mockRoutes({
			content: [
				{
					id: "00000000-0000-4000-8000-0000000000f1",
					name: "Slate A",
					status: "READY",
				},
				{
					id: "00000000-0000-4000-8000-0000000000f2",
					name: "Still downloading",
					status: "DOWNLOADING",
				},
			],
		});
		renderPanel();
		await openArm();
		// Gate on the FORM, not on its START option: since  put the
		// upcoming list first, "Start encoder (START)" is also an armed row's
		// label, so the old text query now matches two nodes.
		await screen.findByLabelText("Action");
		expect(screen.queryByLabelText("Insertable content")).toBeNull();
		await userEvent.selectOptions(screen.getByLabelText("Action"), "SLATE_IN");
		const picker = await screen.findByLabelText("Insertable content");
		expect(await screen.findByText("Slate A")).toBeInTheDocument();
		expect(screen.queryByText("Still downloading")).toBeNull();
		expect(picker).toBeInTheDocument();
		expect(screen.getByLabelText("Duration (seconds)")).toBeInTheDocument();
	});

	it("arming a slate posts the full payload", async () => {
		mockRoutes({
			content: [
				{
					id: "00000000-0000-4000-8000-0000000000f1",
					name: "Slate A",
					status: "READY",
				},
			],
		});
		renderPanel();
		await openArm();
		// Gate on the FORM, not on its START option: since  put the
		// upcoming list first, "Start encoder (START)" is also an armed row's
		// label, so the old text query now matches two nodes.
		await screen.findByLabelText("Action");
		await userEvent.selectOptions(screen.getByLabelText("Action"), "SLATE_IN");
		await screen.findByText("Slate A");
		await userEvent.selectOptions(
			screen.getByLabelText("Insertable content"),
			"00000000-0000-4000-8000-0000000000f1",
		);
		await userEvent.type(screen.getByLabelText("Duration (seconds)"), "300");
		await userEvent.type(screen.getByLabelText("Run at"), "2099-01-01T09:00");
		await userEvent.click(screen.getByRole("button", { name: "Arm schedule" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as RequestInit).body as string);
			expect(body).toMatchObject({
				action: "SLATE_IN",
				bitmovinAccountId: ACCOUNT_ID,
				insertableContentId: "00000000-0000-4000-8000-0000000000f1",
				slateDurationSeconds: 300,
			});
			expect(new Date(body.fireAt).getFullYear()).toBe(2099);
		});
	});

	it("a START arm carries the optional airAt — and only a START shows the field (ledger #160 PR2)", async () => {
		mockRoutes({});
		renderPanel();
		await openArm();
		// Gate on the FORM, not on its START option: since  put the
		// upcoming list first, "Start encoder (START)" is also an armed row's
		// label, so the old text query now matches two nodes.
		await screen.findByLabelText("Action");
		// START (the default) shows the air-time field…
		await userEvent.type(screen.getByLabelText("Run at"), "2099-01-01T09:00");
		await userEvent.type(
			screen.getByLabelText("Air time (deadline alert)"),
			"2099-01-01T10:00",
		);
		// The margin field appears once an air time is set:
		// the arm schema accepts it, so the form must too.
		await userEvent.type(
			screen.getByLabelText("Deadline margin (seconds)"),
			"600",
		);
		await userEvent.click(screen.getByRole("button", { name: "Arm schedule" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as RequestInit).body as string);
			expect(body.action).toBe("START");
			expect(new Date(body.airAt).getFullYear()).toBe(2099);
			expect(body.deadlineMarginSeconds).toBe(600);
		});
		// …and a STOP hides it (the deadline scan never reads STOP rows).
		await userEvent.selectOptions(screen.getByLabelText("Action"), "STOP");
		expect(
			screen.queryByLabelText("Air time (deadline alert)"),
		).not.toBeInTheDocument();
	});

	it("auto-lead arms WITHOUT a fire time and shows the resolution (ledger #160 PR3)", async () => {
		mockRoutes({});
		apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
			if ((init as RequestInit | undefined)?.method === "POST") {
				return {
					id: "row-1",
					// : the route returns the PERSISTED row spread with
					// `autoLead` (`schedules/route.ts`), so these two are always
					// on the wire. The double used to omit them, and the arm's
					// success handler now reads them for its announcement — a
					// test double whose default is thinner than the real
					// response manufactures a failure the app cannot have.
					action: "START",
					fireAt: new Date(Date.now() + 3_600_000).toISOString(),
					status: "ARMED",
					autoLead: {
						source: "P90",
						leadSeconds: 780,
						p90Seconds: 600,
						n: 20,
						fireAtMs: Date.now() + 3_600_000,
					},
				};
			}
			if (path.includes("/schedules")) {
				return [];
			}
			return { items: [] };
		});
		renderPanel();
		await openArm();
		// Gate on the FORM, not on its START option: since  put the
		// upcoming list first, "Start encoder (START)" is also an armed row's
		// label, so the old text query now matches two nodes.
		await screen.findByLabelText("Action");
		await userEvent.type(
			screen.getByLabelText("Air time (deadline alert)"),
			"2099-01-01T10:00",
		);
		await userEvent.click(
			screen.getByLabelText(/Auto-lead \(derive run time\)/i),
		);
		// No fire time typed — the server derives it.
		await userEvent.click(screen.getByRole("button", { name: "Arm schedule" }));
		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			);
			expect(call).toBeDefined();
			const body = JSON.parse((call?.[1] as RequestInit).body as string);
			expect(body.autoLeadTime).toBe(true);
			expect(body.fireAt).toBeUndefined();
		});
		const resolution = await screen.findByText(/Auto-lead calculation:/i);
		// the sample count and percentile in words, not
		// `n=20` / `P90` as a statistician's shorthand in customer copy.
		expect(resolution.textContent).toContain("based on 20 recorded start-ups");
		expect(resolution.textContent).toContain("600s");
		expect(resolution.textContent).toContain(
			"An earlier manual time takes precedence.",
		);
		expect(resolution.textContent).not.toContain("n=");
	});

	it("a 201 that omits the announced fields still reads as SUCCESS (review-366 S3)", async () => {
		/* Announcements must tolerate unavailable action or time fields without translating an undefined message key. */
		mockRoutes({});
		apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
			if ((init as RequestInit | undefined)?.method === "POST") {
				return { id: "row-1" };
			}
			if (path.includes("/schedules")) {
				return [];
			}
			return { items: [] };
		});
		renderPanel();
		await openArm();
		await userEvent.type(
			await screen.findByLabelText("Run at"),
			"2099-01-01T10:00",
		);
		await userEvent.click(screen.getByRole("button", { name: "Arm schedule" }));
		await waitFor(() => {
			expect(
				apiFetch.mock.calls.some(
					([, init]) => (init as RequestInit | undefined)?.method === "POST",
				),
			).toBe(true);
		});
		// The form CLEARED — the success path ran to the end.
		await waitFor(() => {
			expect(screen.getByLabelText("Run at")).toHaveValue("");
		});
		/* A failed reservation request must appear outside the form disclosure so operators can still find the error after it closes. */
		const armForm = document.querySelector(
			'[data-disclosure="schedule-arm"]',
		) as HTMLElement;
		expect(within(armForm).queryAllByRole("alert")).toHaveLength(0);
	});

	it("arming the past is refused CLIENT-side with a translated message", async () => {
		mockRoutes();
		renderPanel();
		await openArm();
		// Gate on the FORM, not on its START option: since  put the
		// upcoming list first, "Start encoder (START)" is also an armed row's
		// label, so the old text query now matches two nodes.
		await screen.findByLabelText("Action");
		await userEvent.type(screen.getByLabelText("Run at"), "2001-01-01T09:00");
		await userEvent.click(screen.getByRole("button", { name: "Arm schedule" }));
		expect(
			await screen.findByText("The run time must be in the future"),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "POST",
			),
		).toBeUndefined();
	});

	it("saves the maxRunMinutes cap via PATCH — now from RuntimeCapPanel (row #248)", async () => {
		// The control moved out of this panel: a cap is a billing guard-rail set
		// once, not an answer to "what fires next", so §5.7 puts it in Advanced.
		// The assertion is unchanged, which is the point of moving it here
		// rather than deleting it.
		mockRoutes();
		renderWithQuery(
			<RuntimeCapPanel
				channelId={CHANNEL_ID}
				status="STOPPED"
				maxRunMinutes={null}
				plan={null}
				bitmovinAccountId={ACCOUNT_ID}
				onChannelChanged={() => {}}
			/>,
		);
		await userEvent.type(screen.getByLabelText("Minutes"), "90");
		await userEvent.click(screen.getByRole("button", { name: "Save cap" }));
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				`/api/live-channels/${CHANNEL_ID}`,
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ maxRunMinutes: 90 }),
				}),
			);
		});
	});

	it("a FAILED schedules query is not an empty schedule", async () => {
		// `schedules.data ?? []` collapsed a rejected query into two empty
		// lists, so an operator checking an unattended channel read
		// "Nothing armed." / "Nothing fired yet." off a panel that had not
		// managed to ask. Both sections must say so, because both were lying.
		apiFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/schedules")) {
				throw new Error("503 from the schedules route");
			}
			return { items: [] };
		});
		const { container } = renderPanel();
		await waitFor(() =>
			expect(
				container.querySelectorAll("[data-schedule-unavailable]"),
			).toHaveLength(1),
		);
		await openHistory();
		await waitFor(() =>
			expect(
				container.querySelectorAll("[data-schedule-unavailable]"),
			).toHaveLength(2),
		);
		expect(screen.queryByText("Nothing armed.")).toBeNull();
		expect(screen.queryByText("Nothing has run yet.")).toBeNull();
		expect(screen.getAllByText(/could not be read/i)).toHaveLength(2);
	});

	it("the unavailable line is translated — ja renders it too", async () => {
		apiFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/schedules")) {
				throw new Error("503");
			}
			return { items: [] };
		});
		renderPanel("ja");
		expect(await screen.findAllByText(/取得できませんでした/)).toHaveLength(1);
		await openHistory("ja");
		expect(await screen.findAllByText(/取得できませんでした/)).toHaveLength(2);
		expect(
			screen.queryByText("登録済みのスケジュールアクションはありません。"),
		).toBeNull();
		expect(screen.queryByText("まだ実行されたものはありません。")).toBeNull();
	});

	/* A fired reservation badge reflects the actual outcome, including provider rejection; dispatch alone is not success. */
	const firedRow = (over: Record<string, unknown>) => ({
		id: "fired-1",
		action: "SLATE_IN",
		fireAt: "2026-08-01T10:00:00.000Z",
		status: "FIRED",
		insertableContentId: "c-1",
		slateDurationSeconds: 30,
		firedAt: "2026-08-01T10:00:00.000Z",
		note: null,
		error: null,
		createdAt: "2026-08-01T00:00:00.000Z",
		...over,
	});

	const renderFired = async (
		over: Record<string, unknown>,
		locale: "en" | "ja" = "en",
	) => {
		apiFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/schedules")) {
				return [firedRow(over)];
			}
			return { items: [] };
		});
		const view = renderPanel(locale);
		// A FIRED row is history, and history is a disclosure .
		await openHistory(locale);
		return view;
	};

	/**
	 *  — a FEEDER_SWITCH row separates "scheduled" from "ready": its
	 * source is staged ahead of the fire time and only a READY session
	 * switches. The panel says which of the three states an armed switch is
	 * in, and shows the measured seam once one committed — both catalogues.
	 */
	const switchRow = (over: Record<string, unknown>) => ({
		id: `sw-${String(over.id ?? "1")}`,
		action: "FEEDER_SWITCH",
		fireAt: "2099-01-01T10:00:00.000Z",
		status: "ARMED",
		insertableContentId: null,
		slateDurationSeconds: null,
		firedAt: null,
		note: null,
		error: null,
		stagedAt: null,
		readyAt: null,
		switchSeamMs: null,
		createdAt: "2026-08-29T00:00:00.000Z",
		...over,
	});

	const renderSwitches = async (
		rows: Record<string, unknown>[],
		locale: "en" | "ja",
	) => {
		apiFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/schedules")) {
				return rows;
			}
			return { items: [] };
		});
		return renderPanel(locale);
	};

	it("an armed switch says scheduled, staging or ready — in English", async () => {
		await renderSwitches(
			[
				switchRow({ id: "scheduled" }),
				switchRow({ id: "staging", stagedAt: "2099-01-01T09:56:00.000Z" }),
				switchRow({
					id: "ready",
					stagedAt: "2099-01-01T09:56:00.000Z",
					readyAt: "2099-01-01T09:57:00.000Z",
				}),
			],
			"en",
		);
		expect(
			await screen.findByText("scheduled — not staged yet"),
		).toBeInTheDocument();
		expect(screen.getByText("staging the source")).toBeInTheDocument();
		const ready = screen.getByText("ready to switch");
		expect(ready.getAttribute("data-switch-phase")).toBe("READY");
	});

	it("an armed switch says scheduled, staging or ready — in Japanese", async () => {
		await renderSwitches(
			[
				switchRow({ id: "scheduled" }),
				switchRow({ id: "staging", stagedAt: "2099-01-01T09:56:00.000Z" }),
				switchRow({
					id: "ready",
					stagedAt: "2099-01-01T09:56:00.000Z",
					readyAt: "2099-01-01T09:57:00.000Z",
				}),
			],
			"ja",
		);
		expect(await screen.findByText("予定 — 未準備")).toBeInTheDocument();
		expect(screen.getByText("ソースを準備中")).toBeInTheDocument();
		expect(screen.getByText("切替準備完了")).toBeInTheDocument();
	});

	it("a RE-STAGED session reads staging again — the chip follows the session, never the row's write-once record (rev367 S-2)", async () => {
		await renderSwitches(
			[
				switchRow({
					id: "restaged",
					stagedAt: "2099-01-01T09:56:00.000Z",
					// The record says ready — the takeover that re-staged the
					// session did not touch it, which is the lie this arm pins.
					readyAt: "2099-01-01T09:57:00.000Z",
					stagedSession: {
						id: "fs-1",
						status: "DOWNLOADING",
						commitAt: "2099-01-01T10:00:00.000Z",
						readyAt: null,
						committedAt: null,
					},
				}),
			],
			"en",
		);
		expect(await screen.findByText("staging the source")).toBeInTheDocument();
		expect(screen.queryByText("ready to switch")).toBeNull();
	});

	it("a staged session that ENDED — or is gone — says the switch will not happen, in both catalogues", async () => {
		const rows = [
			switchRow({
				id: "failed",
				stagedAt: "2099-01-01T09:56:00.000Z",
				stagedSession: {
					id: "fs-1",
					status: "ERROR",
					commitAt: "2099-01-01T10:00:00.000Z",
					readyAt: null,
					committedAt: null,
				},
			}),
			switchRow({
				id: "gone",
				stagedAt: "2099-01-01T09:56:00.000Z",
				readyAt: "2099-01-01T09:57:00.000Z",
				stagedSession: null,
			}),
		];
		await renderSwitches(rows, "en");
		expect(
			await screen.findAllByText("stage failed — will not switch"),
		).toHaveLength(2);
		cleanup();
		await renderSwitches(rows, "ja");
		expect(
			await screen.findAllByText("準備失敗 — 切替されません"),
		).toHaveLength(2);
	});

	it("a committed switch shows its measured seam beside the delivery verdict, and a refused one its note", async () => {
		await renderSwitches(
			[
				switchRow({
					id: "committed",
					status: "FIRED",
					fireAt: "2026-08-01T10:00:00.000Z",
					firedAt: "2026-08-01T10:00:00.000Z",
					outcome: "DELIVERED",
					outcomeNote: "feeder session f1 is pushing to the channel ingest",
					outcomeEvidenceVersion: 1,
					outcomeEvidenceKind: "PROVIDER_RUNNING",
					outcomeEvidenceAt: "2026-08-01T10:00:00.000Z",
					stagedAt: "2026-08-01T09:56:00.000Z",
					readyAt: "2026-08-01T09:57:00.000Z",
					switchSeamMs: 480,
				}),
				switchRow({
					id: "refused",
					status: "MISSED",
					fireAt: "2026-08-01T09:00:00.000Z",
					note: "not staged — the staged session has not finished downloading and probing its source",
					outcome: "FAILED",
				}),
			],
			"en",
		);
		await openHistory("en");
		expect(await screen.findByText("seam 480 ms")).toBeInTheDocument();
		expect(
			screen.getByText(/not staged — the staged session/),
		).toBeInTheDocument();
	});

	it("a FIRED row whose provider entry FAILED is RED, with the provider's own note", async () => {
		await renderFired({
			outcome: "FAILED",
			outcomeNote: "the provider's scheduled insertion ent-9 reached ERROR",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("red");
		expect(badge.className).not.toContain("emerald");
		expect(
			screen.getByText("Requested but did NOT deliver"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"the provider's scheduled insertion ent-9 reached ERROR",
			),
		).toBeInTheDocument();
	});

	// : a slate ingest-mismatch refusal is stored STRUCTURED on the
	// schedule row's `error`. The panel must render the LOCALIZED sentence, not
	// raw JSON — this pins the schedule-panel wiring to `feederErrorMessage`.
	it("localizes a structured slate-mismatch error on the row, in JA", async () => {
		await renderFired(
			{
				outcome: "FAILED",
				error: feederError("slateMismatch", {
					differences: "resolution 1920×1080 → 1280×720",
				}),
			},
			"ja",
		);
		await screen.findByText("FIRED");
		// The Japanese safety sentence, with the diff appended verbatim.
		expect(
			screen.getByText(/挿入時（オンエア時）に失敗します/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/resolution 1920×1080 → 1280×720/),
		).toBeInTheDocument();
		// Raw JSON must not leak onto the timeline.
		expect(screen.queryByText(/slateMismatch/)).not.toBeInTheDocument();
	});

	it("a FIRED row the provider CONFIRMED is green", async () => {
		await renderFired({
			outcome: "DELIVERED",
			outcomeNote: "confirmed (SCHEDULED)",
			outcomeEvidenceVersion: 1,
			outcomeEvidenceKind: "PROVIDER_RUNNING",
			outcomeEvidenceAt: "2026-08-01T10:00:00.000Z",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("emerald");
		expect(screen.getByText("Delivered")).toBeInTheDocument();
	});

	it("a feed only PROCESS_PUSHING is amber, never green — pushing is not delivery (audit HIGH-4)", async () => {
		await renderFired({
			action: "FEEDER_START",
			outcome: "PROCESS_PUSHING",
			outcomeNote: "started pushing (provider not yet confirmed)",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("emerald");
		expect(
			screen.getByText("Pushing — provider has not confirmed the ingest yet"),
		).toBeInTheDocument();
	});

	it("a feed the provider confirmed INGEST_CONNECTED is green — the feeder's terminal-positive (audit HIGH-4)", async () => {
		await renderFired({
			action: "FEEDER_START",
			outcome: "INGEST_CONNECTED",
			outcomeNote: "the provider's live encoder reports the ingest connected",
			outcomeEvidenceVersion: 1,
			outcomeEvidenceKind: "HEARTBEAT_INGEST_CONNECTED",
			outcomeEvidenceAt: "2026-08-01T10:00:00.000Z",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("emerald");
		expect(
			screen.getByText("Ingest connected — the provider is receiving the feed"),
		).toBeInTheDocument();
	});

	it("a SLATE_ARMED row is amber, never green — armed is not aired (audit HIGH-5)", async () => {
		await renderFired({
			action: "SLATE_IN",
			outcome: "SLATE_ARMED",
			outcomeNote: "the provider confirmed insertion ent-9 (SCHEDULED)",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("emerald");
		expect(
			screen.getByText(
				"Slate armed — provider accepted it; airing not confirmed",
			),
		).toBeInTheDocument();
	});

	it("a FIRED row with no confirmed outcome is AMBER, never green — and an ABSENT outcome falls the same way", async () => {
		await renderFired({ outcome: "PENDING" });
		const pending = await screen.findByText("Requested");
		expect(pending.className).toContain("amber");
		expect(pending.className).not.toContain("emerald");
		expect(
			screen.getByText("Requested — outcome not confirmed yet"),
		).toBeInTheDocument();
		cleanup();

		// A server that predates the column sends no `outcome` at all.
		await renderFired({});
		const absent = await screen.findByText("Requested");
		expect(absent.className).toContain("amber");
		expect(absent.className).not.toContain("emerald");
	});

	it("a scheduled START that DELIVERED is green, like every other action (review-350 HIGH-2)", async () => {
		/**
		 * The tone rule is per-OUTCOME, not per-action — but plain START is the
		 * commonest scheduled action and was the one with no outcome writer, so
		 * this arm existed only in the amber state. It is here to pin the pair:
		 * a start whose provision reached RUNNING is green…
		 */
		await renderFired({
			action: "START",
			outcome: "DELIVERED",
			outcomeNote: "the channel reached RUNNING",
			outcomeEvidenceVersion: 1,
			outcomeEvidenceKind: "PROVIDER_RUNNING",
			outcomeEvidenceAt: "2026-08-01T10:00:00.000Z",
		});
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("emerald");
		expect(screen.getByText("Delivered")).toBeInTheDocument();
	});

	it("keeps legacy positive outcomes amber and labels them unverified in both locales", async () => {
		await renderFired({ action: "START", outcome: "DELIVERED" });
		// UX-02/03: the localized operator label owns the tone; FIRED is a raw
		// secondary code and intentionally remains neutral.
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("emerald");
		expect(
			screen.getByText("Legacy data — delivery not verified"),
		).toBeInTheDocument();
		cleanup();
		await renderFired(
			{ action: "FEEDER_START", outcome: "INGEST_CONNECTED" },
			"ja",
		);
		expect(
			await screen.findByText("従来データ — 配信確認なし"),
		).toBeInTheDocument();
	});

	it("a scheduled START still in flight is amber — honest only because a writer is coming", async () => {
		// …and PENDING is amber, which is the true reading for the window
		// between the sweep firing the row and the provision job answering for
		// it. Before the writer existed, this state was PERMANENT.
		await renderFired({ action: "START", outcome: "PENDING" });
		const badge = await screen.findByText("Requested");
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("emerald");
	});

	/**
	 *  — a row refused because it was armed for a DIFFERENT airing.
	 *
	 * The badge is amber, not red: the guard WORKING is not a fault, and
	 * painting it red would send an operator hunting one. It is also not the
	 * raw enum name — `SKIPPED_STALE_GENERATION` is neither short nor
	 * self-explaining, so this is the one status with a catalogued label.
	 */
	it("a row refused for a stale generation renders its label, amber, in BOTH locales", async () => {
		renderFired({ status: "SKIPPED_STALE_GENERATION", outcome: "PENDING" });
		const badge = await screen.findByText(
			"Skipped — armed for an earlier airing",
		);
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("red");
		expect(badge.className).not.toContain("emerald");
		// The FIRED-only outcome sentence must NOT appear: nothing was fired.
		expect(
			screen.queryByText("Requested — outcome not confirmed yet"),
		).not.toBeInTheDocument();
		cleanup();
		renderFired(
			{ status: "SKIPPED_STALE_GENERATION", outcome: "PENDING" },
			"ja",
		);
		expect(
			await screen.findByText("見送り — 別の回向けの予約でした"),
		).toBeInTheDocument();
	});

	it("renders the outcome sentences in Japanese too", async () => {
		await renderFired(
			{
				outcome: "FAILED",
				outcomeNote: "the provider's scheduled insertion reached ERROR",
			},
			"ja",
		);
		expect(
			await screen.findByText("実行を要求しましたが実行されませんでした"),
		).toBeInTheDocument();
		cleanup();
		await renderFired({ outcome: "UNKNOWN" }, "ja");
		expect(
			await screen.findByText("実行要求済み — 結果を確認できませんでした"),
		).toBeInTheDocument();
	});

	it("renders Japanese — the whole panel goes through the catalogue", async () => {
		mockRoutes();
		renderPanel("ja");
		expect(
			screen.getByRole("button", { name: "予約を追加" }),
		).toBeInTheDocument();
		await openArm("ja");
		await openHistory("ja");
		// Two nodes: the armed row's label and the form's option (see above).
		expect(
			(await screen.findAllByText("チャンネルを開始 (START)")).length,
		).toBeGreaterThan(0);
		expect(screen.getByText("予定")).toBeInTheDocument();
		expect(screen.getByText("履歴")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "スケジュールを登録" }),
		).toBeInTheDocument();
		// : both disclosure triggers are catalogued too — a new control
		// that ships English is the i18n failure this sweep exists to catch.
		expect(
			screen.getByRole("button", { name: "実行済み・取り消し済みを隠す" }),
		).toBeInTheDocument();
	});
});
