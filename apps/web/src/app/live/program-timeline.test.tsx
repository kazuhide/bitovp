import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "@/lib/format";
import { renderWithQuery } from "@/test/render";
import { ProgramTimeline, type TimelineRow } from "./program-timeline";

/**
 * Audit 602ec286 HIGH-8 — the timeline paints a FIRED row's OUTCOME, never a
 * blanket FIRED-green.
 *
 * The defect the old `statusTone` shipped: `status === "FIRED"` mapped straight
 * to emerald, so a slate whose provider entry went ERROR, a feed still only
 * PROCESS_PUSHING, or a row left UNKNOWN all read as success on the timeline
 * while the history list beside them showed red or amber — one screen
 * contradicting itself. These render the marker and read its colour off the
 * class, so a revert to the FIRED-green chain turns the amber/red cases green
 * and fails here.
 */

const UP = new Date("2026-09-01T20:45:00Z");
const START = new Date("2026-09-01T21:00:00Z");
const END = new Date("2026-09-01T22:00:00Z");
const FIRE_AT = "2026-09-01T21:30:00Z";

function marker(
	outcome: TimelineRow["outcome"],
	currentEvidence = true,
): HTMLElement {
	const evidence =
		currentEvidence && outcome === "DELIVERED"
			? {
					outcomeEvidenceVersion: 1,
					outcomeEvidenceKind: "PROVIDER_RUNNING" as const,
					outcomeEvidenceAt: FIRE_AT,
				}
			: currentEvidence && outcome === "INGEST_CONNECTED"
				? {
						outcomeEvidenceVersion: 1,
						outcomeEvidenceKind: "HEARTBEAT_INGEST_CONNECTED" as const,
						outcomeEvidenceAt: FIRE_AT,
					}
				: {};
	const { container } = renderWithQuery(
		<ProgramTimeline
			streamUpAt={UP}
			programStartAt={START}
			programEndAt={END}
			slate={false}
			rows={[
				{
					action: "FEEDER_START",
					status: "FIRED",
					outcome,
					fireAt: FIRE_AT,
					...evidence,
				},
			]}
		/>,
	);
	const el = container.querySelector('[data-marker="FEEDER_START"]');
	if (!el) {
		throw new Error("marker not rendered");
	}
	return el as HTMLElement;
}

describe("ProgramTimeline — a FIRED row is coloured by its outcome (audit HIGH-8)", () => {
	it("adds a localized semantic event list and hides duplicate visual markers from assistive technology", () => {
		const { container } = renderWithQuery(
			<ProgramTimeline
				streamUpAt={UP}
				programStartAt={START}
				programEndAt={END}
				slate={false}
				rows={[
					{
						action: "START",
						status: "FIRED",
						outcome: "DELIVERED",
						outcomeEvidenceVersion: 1,
						outcomeEvidenceKind: "PROVIDER_RUNNING",
						outcomeEvidenceAt: FIRE_AT,
						fireAt: FIRE_AT,
					},
					{
						action: "STOP",
						status: "MISSED",
						fireAt: "2026-09-01T22:00:00Z",
					},
				]}
			/>,
			"ja",
		);

		const events = screen.getByRole("list", {
			name: "スケジュールイベント",
		});
		const rows = within(events).getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent(
			`チャンネルを開始 (START) — 実行されました — ${formatDateTime(FIRE_AT)}`,
		);
		expect(rows[1]).toHaveTextContent(
			`チャンネルを停止 (STOP) — 未実行 — ${formatDateTime("2026-09-01T22:00:00Z")}`,
		);
		for (const row of rows) {
			expect(row.querySelector('[aria-hidden="true"]')).not.toBeNull();
		}
		for (const visualMarker of container.querySelectorAll("[data-marker]")) {
			expect(visualMarker).toHaveAttribute("aria-hidden", "true");
		}
	});

	it("greens a DELIVERED row", () => {
		expect(marker("DELIVERED").className).toContain("bg-emerald-500");
	});

	it("greens an INGEST_CONNECTED row — the feeder's terminal-positive", () => {
		expect(marker("INGEST_CONNECTED").className).toContain("bg-emerald-500");
	});

	it("ambers legacy DELIVERED and INGEST_CONNECTED rows without current evidence", () => {
		for (const outcome of ["DELIVERED", "INGEST_CONNECTED"] as const) {
			const el = marker(outcome, false);
			expect(el.className).toContain("bg-amber-500");
			expect(el.className).not.toContain("bg-emerald-500");
			const figure = el.closest("figure");
			if (!figure) throw new Error("timeline figure not rendered");
			expect(within(figure).getByRole("listitem")).toHaveTextContent(
				"Legacy data — delivery not verified",
			);
		}
	});

	it("reds a FAILED row — and never greens it", () => {
		const el = marker("FAILED");
		expect(el.className).toContain("bg-red-500");
		expect(el.className).not.toContain("bg-emerald-500");
	});

	it("ambers a PROCESS_PUSHING row — pushing is not delivery (HIGH-4)", () => {
		const el = marker("PROCESS_PUSHING");
		expect(el.className).toContain("bg-amber-500");
		expect(el.className).not.toContain("bg-emerald-500");
	});

	it("ambers a SLATE_ARMED row — armed is not aired (HIGH-5)", () => {
		const el = marker("SLATE_ARMED");
		expect(el.className).toContain("bg-amber-500");
		expect(el.className).not.toContain("bg-emerald-500");
	});

	it("ambers an UNKNOWN row — fired, never confirmed", () => {
		const el = marker("UNKNOWN");
		expect(el.className).toContain("bg-amber-500");
		expect(el.className).not.toContain("bg-emerald-500");
	});

	it("treats an ABSENT outcome as PENDING (amber), never as delivered", () => {
		// A server that predates the column, or the wizard's planning view — the
		// direction that cannot invent a success.
		const el = marker(undefined);
		expect(el.className).toContain("bg-amber-500");
		expect(el.className).not.toContain("bg-emerald-500");
		expect(el.getAttribute("data-outcome")).toBe("PENDING");
	});

	it("still greens a genuinely COMPLETED (non-FIRED) row and reds a MISSED one", () => {
		// The non-FIRED status arm is unchanged: those verdicts read from status.
		const { container } = renderWithQuery(
			<ProgramTimeline
				streamUpAt={UP}
				programStartAt={START}
				programEndAt={END}
				slate={false}
				rows={[
					{ action: "START", status: "COMPLETED", fireAt: FIRE_AT },
					{ action: "STOP", status: "MISSED", fireAt: FIRE_AT },
				]}
			/>,
		);
		expect(
			(container.querySelector('[data-marker="START"]') as HTMLElement)
				.className,
		).toContain("bg-emerald-500");
		expect(
			(container.querySelector('[data-marker="STOP"]') as HTMLElement)
				.className,
		).toContain("bg-red-500");
	});
});
