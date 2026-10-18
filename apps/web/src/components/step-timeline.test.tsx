import type { StepLogEntry } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { StepTimeline } from "./step-timeline";

/**
 * Pins the shared step-log rendering contract (VOD job detail and live
 * channel detail render the same component): status badge tones, the
 * stoppedSiblings billing note and the request/response expander.
 */

function entry(partial: Partial<StepLogEntry> & Pick<StepLogEntry, "step">) {
	return {
		kind: "CREATE_ENCODING",
		payload: {},
		refs: {},
		status: "PENDING",
		...partial,
	} satisfies StepLogEntry;
}

describe("StepTimeline", () => {
	it.each([
		["ja", "挿入受付", "結果未確認", "提供元の予約一覧"],
		["en", "Insertion accepted", "Outcome unverified", "provider reservations"],
	] as const)("marks manual acceptance as neutral, with help in %s", (locale, accepted, unknown, explanation) => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "slate:manual",
						kind: "SLATE_INSERTED",
						status: "DONE",
						payload: { viaDirectRoute: true },
					}),
				]}
			/>,
			locale,
		);
		expect(screen.getByText(accepted)).toHaveClass("text-zinc-400");
		expect(screen.getByText(unknown)).toBeVisible();
		expect(screen.getByText("DONE")).not.toBeVisible();
		expect(screen.getByText("SLATE_INSERTED")).not.toBeVisible();
		expect(screen.queryByText(new RegExp(explanation))).not.toBeInTheDocument();
		const help = screen.getByRole("button", { name: new RegExp(accepted) });
		fireEvent.click(help);
		expect(screen.getByText(new RegExp(explanation))).toBeVisible();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByText(new RegExp(explanation))).not.toBeInTheDocument();
		expect(help).toHaveFocus();
		const protocol = screen.getByText("DONE").closest("details");
		expect(protocol).not.toHaveAttribute("open");
		protocol?.setAttribute("open", "");
		expect(screen.getByText("DONE")).toBeVisible();
		expect(screen.getByText("SLATE_INSERTED")).toBeVisible();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it.each([
		{},
		{ viaDirectRoute: false },
		{ viaDirectRoute: "true" },
	])("keeps non-manual slate protocol status unchanged (%j)", (payload) => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "slate:scheduled",
						kind: "SLATE_INSERTED",
						status: "DONE",
						payload,
					}),
				]}
			/>,
		);
		expect(screen.getByText("DONE")).toHaveClass("text-emerald-300");
		expect(screen.getByText("SLATE_INSERTED")).toBeVisible();
		expect(screen.queryByText("Insertion accepted")).not.toBeInTheDocument();
	});

	it("preserves failed manual insertion and its error", () => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "slate:failed",
						kind: "SLATE_INSERTED",
						status: "FAILED",
						payload: { viaDirectRoute: true },
						error: "insertion rejected",
					}),
				]}
			/>,
		);
		expect(screen.getByText("FAILED")).toHaveClass("text-red-300");
		expect(screen.getByText("insertion rejected")).toBeVisible();
		expect(screen.queryByText("Insertion accepted")).not.toBeInTheDocument();
	});

	it("renders each entry with its status badge tone, step key and op kind", () => {
		render(
			<StepTimeline
				entries={[
					entry({ step: "encoding", status: "DONE", resourceId: "enc-123" }),
					entry({
						step: "start",
						kind: "START_LIVE_ENCODING",
						status: "RUNNING",
					}),
					entry({
						step: "await:running",
						kind: "AWAIT_LIVE_RUNNING",
						status: "PENDING",
					}),
					entry({
						step: "muxing:v720",
						kind: "CREATE_MUXING_FMP4",
						status: "FAILED",
						error: "segmentLength rejected",
					}),
				]}
			/>,
		);
		// Badge tones: DONE/RUNNING ok (emerald), PENDING neutral, FAILED error.
		expect(screen.getByText("DONE")).toHaveClass("text-emerald-300");
		expect(screen.getByText("RUNNING")).toHaveClass("text-emerald-300");
		expect(screen.getByText("PENDING")).toHaveClass("text-zinc-400");
		expect(screen.getByText("FAILED")).toHaveClass("text-red-300");
		// Step key, op kind, created resource id and the error line.
		expect(screen.getByText("await:running")).toBeInTheDocument();
		expect(screen.getByText("AWAIT_LIVE_RUNNING")).toBeInTheDocument();
		expect(screen.getByText("enc-123")).toBeInTheDocument();
		expect(screen.getByText("segmentLength rejected")).toBeInTheDocument();
	});

	it("notes stopped sibling encodings on a failed await (still billing)", () => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "await:enc2",
						kind: "AWAIT_ENCODING",
						status: "FAILED",
						response: { stoppedSiblings: ["sib-a", "sib-b"] },
					}),
				]}
			/>,
		);
		expect(
			screen.getByText(/Stopped 2 sibling encodings \(still billing/),
		).toBeInTheDocument();
	});

	it("singularizes the sibling note and omits it for empty/absent lists", () => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "await:enc2",
						kind: "AWAIT_ENCODING",
						status: "FAILED",
						response: { stoppedSiblings: ["sib-a"] },
					}),
					entry({
						step: "await:enc3",
						kind: "AWAIT_ENCODING",
						status: "FAILED",
						response: { stoppedSiblings: [] },
					}),
				]}
			/>,
		);
		expect(
			screen.getByText(/Stopped 1 sibling encoding \(still billing/),
		).toBeInTheDocument();
		expect(screen.getAllByText(/Stopped \d+ sibling/)).toHaveLength(1);
	});

	it("shows the request/response expander only when a snapshot exists", () => {
		render(
			<StepTimeline
				entries={[
					entry({
						step: "encoding",
						status: "DONE",
						request: { name: "Live Channel" },
						response: { id: "enc-123" },
						finishedAt: "2026-06-13T10:00:00.000Z",
					}),
					entry({ step: "await:running", status: "PENDING" }),
				]}
			/>,
		);
		const summaries = screen.getAllByText(/request \/ response/);
		expect(summaries).toHaveLength(1);
		// The snapshot body renders inside the expander.
		expect(screen.getByText(/"Live Channel"/)).toBeInTheDocument();
		expect(screen.getByText(/"enc-123"/)).toBeInTheDocument();
	});
});
