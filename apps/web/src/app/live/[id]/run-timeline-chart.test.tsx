import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { RunTimelineChart } from "./run-timeline-chart";
import { jumpToLiveSection } from "./section-focus";

vi.mock("./section-focus", () => ({ jumpToLiveSection: vi.fn() }));
// This test covers the history notice/navigation, not chart geometry.
vi.mock("recharts", () =>
	Object.fromEntries(
		[
			"CartesianGrid",
			"Line",
			"LineChart",
			"ReferenceDot",
			"ReferenceLine",
			"ResponsiveContainer",
			"Tooltip",
			"XAxis",
			"YAxis",
		].map((name) => [name, () => null]),
	),
);

const chart = (truncated: boolean) => (
	<RunTimelineChart
		window={{ startMs: 0, endMs: 1_000 }}
		events={[]}
		points={[]}
		nowMs={1_000}
		pushTimeline={{ events: [], coverage: "recent-receipts", truncated }}
	/>
);

describe("Push timeline history window notice", () => {
	it.each([
		"ja",
		"en",
	] as const)("links to the existing Push receipt log in %s without an alarm", (locale) => {
		renderLocalized(chart(true), locale);
		const label = locale === "ja" ? "Push受信ログへ" : "Go to Push receipt log";
		const link = screen.getByRole("link", { name: label });
		expect(link).toHaveAttribute("href", "#sec-heartbeat-log");
		expect(link.parentElement).not.toHaveClass("text-amber-400");
		fireEvent.click(link);
		expect(jumpToLiveSection).toHaveBeenCalledWith(
			expect.anything(),
			"sec-heartbeat-log",
		);
	});
	it("does not show the overflow notice when the bounded window is complete", () => {
		renderLocalized(chart(false));
		expect(
			screen.queryByRole("link", { name: "Go to Push receipt log" }),
		).not.toBeInTheDocument();
	});
});

describe("state-line source legend (row #328)", () => {
	const legend = (push: boolean) => (
		<RunTimelineChart
			window={{ startMs: 0, endMs: 1_000 }}
			events={[]}
			points={[]}
			nowMs={1_000}
			laneSources={{ push, pushTruncated: false }}
		/>
	);
	it("says the state lines follow Push where it was received", () => {
		renderLocalized(legend(true), "en");
		expect(
			screen.getByText(/state lines: Push where received, Poll elsewhere/),
		).toBeInTheDocument();
	});
	it("says when only the most recent Push receipts drew the lines", () => {
		renderLocalized(
			<RunTimelineChart
				window={{ startMs: 0, endMs: 1_000 }}
				events={[]}
				points={[]}
				nowMs={1_000}
				laneSources={{ push: true, pushTruncated: true }}
			/>,
			"en",
		);
		expect(
			screen.getByText(
				/Only the most recent Push receipts drew the state lines/,
			),
		).toBeInTheDocument();
	});
	it("keeps the Poll legend for a run with no Push receipt", () => {
		renderLocalized(legend(false), "en");
		expect(screen.getByText(/state lines: Poll$/)).toBeInTheDocument();
	});
});

describe("state history outside the flattened chart (ledger #161)", () => {
	it.each([
		"ja",
		"en",
	] as const)("exposes timed three-lane observations and events in %s", (locale) => {
		renderLocalized(
			<RunTimelineChart
				window={{ startMs: 0, endMs: 2_000 }}
				events={[
					{ kind: "INPUT_DISCONNECTED", atMs: 1_000, source: "heartbeat" },
				]}
				points={[
					{ atMs: 0, ingest: true, encoder: true, output: false },
					{ atMs: 1_000, ingest: false, encoder: true, output: true },
				]}
				nowMs={2_000}
			/>,
			locale,
		);
		const history = screen.getByRole("list", {
			name: locale === "ja" ? "観測された状態" : "Observed states",
		});
		const rows = within(history).getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent(
			locale === "ja"
				? "入力: 正常; エンコーダ: 正常; 出力: 未検出"
				: "Input: Healthy; Encoder: Healthy; Output: Not detected",
		);
		expect(rows[1]).toHaveTextContent(
			locale === "ja"
				? "入力: 未検出; エンコーダ: 正常; 出力: 正常"
				: "Input: Not detected; Encoder: Healthy; Output: Healthy",
		);
		expect(rows[1]?.querySelector("time")).toHaveAttribute(
			"dateTime",
			"1970-01-01T00:00:01.000Z",
		);
		expect(history.closest('[role="img"]')).toBeNull();
		expect(screen.getByRole("img")).toHaveAccessibleDescription(
			locale === "ja"
				? /未観測の時刻の状態は推測しません/
				: /Unobserved times are not inferred/,
		);
		const event = screen.getByText(
			locale === "ja" ? "入力切断" : "Input disconnected",
		);
		expect(event.closest("li")?.querySelector("time")).toHaveAttribute(
			"dateTime",
			"1970-01-01T00:00:01.000Z",
		);
	});

	it.each([
		"ja",
		"en",
	] as const)("says unobserved, not healthy, with no samples in %s", (locale) => {
		renderLocalized(chart(false), locale);
		expect(screen.getByRole("img")).toHaveAccessibleDescription(
			locale === "ja"
				? "状態の観測データはありません。"
				: "No state observations are available.",
		);
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});

	it("keeps every change plus the first/last sample without repeating a dense stable run", () => {
		const points = Array.from({ length: 100 }, (_, i) => ({
			atMs: i * 1_000,
			ingest: i !== 50,
			encoder: true,
			output: true,
		}));
		renderLocalized(
			<RunTimelineChart
				window={{ startMs: 0, endMs: 100_000 }}
				events={[]}
				points={points.toReversed()}
				nowMs={100_000}
			/>,
		);
		const history = screen.getByRole("list", { name: "Observed states" });
		expect(
			[...history.querySelectorAll("time")].map((node) => node.dateTime),
		).toEqual(
			[0, 50, 51, 99].map((seconds) => new Date(seconds * 1_000).toISOString()),
		);
		expect(history.closest("[aria-live]")).toBeNull();
	});
});
