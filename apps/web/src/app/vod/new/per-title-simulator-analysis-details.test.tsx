import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { createPerTitleEvaluationAdvice } from "./per-title-simulator-advice";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import {
	PerTitleAnalysisDetails,
	PerTitleAnalysisPanel,
} from "./per-title-simulator-analysis-panel";

const detailMessage = {
	en: "Review the conditional template selection.",
	ja: "条件付きのテンプレート選択を確認してください。",
};

function fixture() {
	const goal: PerTitleGoal = {
		strategy: "count",
		codec: "VP9",
		minBitrate: 100_000,
		maxBitrate: 8_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 1.9,
		countPolicy: { kind: "exact", count: 3 },
	};
	const result = analyzePerTitleSettings(goal, "count");
	if (result.decision.status !== "proposal")
		throw new Error("Expected a checked count proposal.");
	result.reach.high = { minimum: 8_000_000, maximum: 8_000_000 };
	result.reach.low = { minimum: 400_000, maximum: 600_000 };
	result.findings.unshift({
		code: "displayed-detail",
		severity: "warning",
		message: detailMessage,
	});
	return { goal, result };
}

describe.each([
	"en",
	"ja",
] as const)("compact evaluation and separate details (%s)", (locale) => {
	const ja = locale === "ja";
	it("keeps controls and a short proposal status without inline diagnostics", () => {
		const { goal, result } = fixture();
		const before = structuredClone({ goal, result });
		const onEvaluate = vi.fn();
		const onIntentChange = vi.fn();
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent="count"
				result={result}
				onEvaluate={onEvaluate}
				onIntentChange={onIntentChange}
			/>,
			locale,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			ja ? "調整案があります。" : "A checked adjustment is available.",
		);
		expect(screen.queryByText(result.decision.message[locale])).toBeNull();
		expect(screen.queryByText(detailMessage[locale])).toBeNull();
		expect(
			screen.queryByText(
				ja ? "解析値が上限の場合の最上段" : "Top at high analysis input",
			),
		).toBeNull();
		expect(
			screen.queryByText(ja ? "評価の詳細" : "Evaluation details"),
		).toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		expect(onEvaluate).toHaveBeenCalledOnce();
		fireEvent.change(
			screen.getByRole("combobox", { name: ja ? "目的" : "Goal" }),
			{ target: { value: "cap" } },
		);
		expect(onIntentChange).toHaveBeenCalledWith("cap");
		expect({ goal, result }).toEqual(before);
	});

	it("folds all diagnostics into initially closed, read-only details", () => {
		const { goal, result } = fixture();
		const before = structuredClone({ goal, result });
		const { container } = renderLocalized(
			<PerTitleAnalysisDetails goal={goal} result={result} />,
			locale,
		);
		const summary = screen.getByText(ja ? "評価の詳細" : "Evaluation details", {
			selector: "summary",
		});
		const details = summary.closest("details");
		expect(details).not.toHaveAttribute("open");
		const high = screen.getByText(
			ja ? "解析値が上限の場合の最上段" : "Top at high analysis input",
		);
		const low = screen.getByText(
			ja ? "解析値が下限の場合の最上段" : "Top at low analysis input",
		);
		const dependencies = screen.getByText(
			ja ? "全項目の依存関係" : "All parameter dependencies",
		);
		expect(high).not.toBeVisible();
		expect(dependencies).not.toBeVisible();
		expect(container.querySelectorAll("button, input, select")).toHaveLength(0);
		fireEvent.click(summary);
		expect(details).toHaveAttribute("open");
		expect(high).toBeVisible();
		expect(high.parentElement).toHaveTextContent("8,000 kbps");
		expect(low.parentElement).toHaveTextContent("400–600 kbps");
		expect(dependencies).toBeVisible();
		expect(screen.getByText(result.quality.message[locale])).toBeVisible();
		expect(screen.getByText(detailMessage[locale])).toBeVisible();
		expect(
			screen
				.getByText(ja ? "ラダー全体" : "Full ladder", { selector: "summary" })
				.closest("details"),
		).not.toHaveAttribute("open");
		fireEvent.click(summary);
		expect(details).not.toHaveAttribute("open");
		expect({ goal, result }).toEqual(before);
	});

	it("compares the selected alternative while retaining current diagnostics", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 5,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "band",
					height: 480,
					minBitrate: 300_000,
					maxBitrate: 600_000,
					bitrateSelectionMode: "OPTIMIZED",
				},
			],
		};
		const candidate = (maximum: number) => {
			const advice = createPerTitleEvaluationAdvice(goal, {
				...goal,
				rows: goal.rows?.map((row) => ({ ...row, maxBitrate: maximum })),
			});
			if (!advice)
				throw new Error("Expected a certified row-range alternative.");
			return advice;
		};
		const first = candidate(900_000);
		const selected = candidate(1_200_000);
		const result = analyzePerTitleSettings(goal, "cap");
		result.advice = [first, selected];
		result.findings.unshift({
			code: "displayed-detail",
			severity: "warning",
			message: detailMessage,
		});
		const before = structuredClone({ goal, result, selected });
		renderLocalized(
			<PerTitleAnalysisDetails goal={goal} result={result} advice={selected} />,
			locale,
		);
		fireEvent.click(
			screen.getByText(ja ? "評価の詳細" : "Evaluation details", {
				selector: "summary",
			}),
		);
		fireEvent.click(
			screen.getByText(ja ? "ラダー全体" : "Full ladder", {
				selector: "summary",
			}),
		);
		const table = screen.getByRole("table", {
			name: ja ? "ラダー全体" : "Full ladder",
		});
		const cells = within(table).getAllByRole("cell");
		expect(cells[0]).toHaveTextContent(/^300–600$/);
		expect(cells[3]).toHaveTextContent(/^300–1,200$/);
		expect(table).not.toHaveTextContent("300–900");
		expect(screen.getByText(detailMessage[locale])).toBeVisible();
		expect(screen.getByText(result.quality.message[locale])).toBeVisible();
		expect({ goal, result, selected }).toEqual(before);
	});

	it("shows a concrete conflict when no adjustment is available", () => {
		const { goal, result } = fixture();
		result.advice = [];
		result.decision.status = "no-certified-candidate";
		result.findings.push({
			code: "invalid-range",
			severity: "conflict",
			message: {
				en: "The minimum exceeds the maximum.",
				ja: "最小値が最大値を超えています。",
			},
		});
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent="count"
				result={result}
				onEvaluate={vi.fn()}
				onIntentChange={vi.fn()}
			/>,
			locale,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			ja
				? "最小値が最大値を超えています。"
				: "The minimum exceeds the maximum.",
		);
		expect(screen.queryByText(result.decision.message[locale])).toBeNull();
	});

	it("renders no results before evaluation", () => {
		const { goal } = fixture();
		renderLocalized(
			<>
				<PerTitleAnalysisPanel
					goal={goal}
					intent="count"
					onEvaluate={vi.fn()}
					onIntentChange={vi.fn()}
				/>
				<PerTitleAnalysisDetails goal={goal} />
			</>,
			locale,
		);
		expect(screen.queryByRole("status")).toBeNull();
		expect(
			screen.queryByText(ja ? "評価の詳細" : "Evaluation details"),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		).toBeVisible();
	});

	it("explains why automatic settings cannot offer individual changes", () => {
		const original = fixture().goal;
		const goal: PerTitleGoal = {
			...original,
			maxBitrateStepSize: 20,
			adjustments: {
				global: { minBitrateStepSize: { mode: "auto", method: "constraints" } },
			},
		};
		const result = analyzePerTitleSettings(goal, "count");
		const reason = result.findings.find(
			(item) => item.code === "automatic-settings",
		);
		if (!reason)
			throw new Error("Expected the automatic-settings explanation.");
		expect(result.decision.status).toBe("inspect-only");
		expect(result.findings.some((item) => item.severity === "conflict")).toBe(
			false,
		);
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent="count"
				result={result}
				onEvaluate={vi.fn()}
				onIntentChange={vi.fn()}
			/>,
			locale,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			reason.message[locale],
		);
	});
});
