import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { applyPerTitleAdvice } from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";
import {
	analyzePerTitleSettings,
	type PerTitleAnalysisIntent,
} from "./per-title-simulator-analysis";
import { PerTitleAnalysisPanel } from "./per-title-simulator-analysis-panel";

const source = (): PerTitleGoal => ({
	strategy: "count",
	codec: "VP9",
	minBitrate: 100_000,
	maxBitrate: 8_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "exact", count: 3 },
});

describe("current Per-Title settings analysis", () => {
	it.each([
		"en",
		"ja",
	] as const)("evaluates current settings before any edit with a concise localized panel (%s)", (locale) => {
		const goal = source();
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
			locale,
		);
		const panel = screen.getByRole("region", {
			name: locale === "ja" ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(panel).toHaveTextContent("8,000");
		expect(panel).toHaveTextContent("3");
		fireEvent.click(
			within(panel).getByRole("button", {
				name: locale === "ja" ? "評価する" : "Evaluate",
			}),
		);
		expect(within(panel).getByRole("status")).toBeInTheDocument();
		expect(
			within(panel).queryByText(
				locale === "ja"
					? "解析値が上限の場合の最上段"
					: "Top at high analysis input",
			),
		).toBeNull();
		const details = within(panel)
			.getByText(
				locale === "ja" ? "根拠と画質確認" : "Reasoning and quality checks",
			)
			.closest("details");
		expect(details).not.toHaveAttribute("open");
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it("offers a certified current-only count adjustment without altering the count requirement", () => {
		const goal = source();
		const original = structuredClone(goal);
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Goal" }), {
			target: { value: "count" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		const explanation = analyzePerTitleSettings(goal, "count").advice[0]
			?.explanation?.en;
		if (!explanation)
			throw new Error("Expected the candidate dependency calculation.");
		expect(
			screen.getByRole("region", { name: "Suggested adjustment" }),
		).toHaveTextContent(explanation);
		expect(goal).toEqual(original);
		expect(onAdopt).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Use this adjustment" }),
		);
		const [advice, options] = onAdopt.mock.calls[0] ?? [];
		const adopted = applyPerTitleAdvice(goal, advice, options);
		expect(adopted?.countPolicy).toEqual(original.countPolicy);
		expect(adopted?.maxBitrate).toBe(original.maxBitrate);
		expect(advice.proof).toBe("model-count");
	});

	it("inspects automatic settings without silently fixing or adopting them", () => {
		const goal: PerTitleGoal = {
			...source(),
			adjustments: {
				global: { minBitrateStepSize: { mode: "auto", method: "constraints" } },
			},
		};
		const original = structuredClone(goal);
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		expect(
			screen.getByText(/Automatic adjustment is enabled/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Use this adjustment" }),
		).toBeNull();
		expect(goal).toEqual(original);
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("shows conditional high and low top values from the current settings (%s)", (locale) => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 6_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "top",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 6_000_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_500_000,
					highComplexityBoundaryForMaxBitrate: 6_000_000,
				},
			],
		};
		const result = analyzePerTitleSettings(goal, "cap");
		expect(result.reach.high?.maximum).toBe(6_000_000);
		expect(result.reach.low?.maximum).toBeLessThan(6_000_000);
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={vi.fn()} />,
			locale,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "評価する" : "Evaluate",
			}),
		);
		const high = screen
			.getByText(
				locale === "ja"
					? "解析値が上限の場合の最上段"
					: "Top at high analysis input",
			)
			.closest("div");
		const low = screen
			.getByText(
				locale === "ja"
					? "解析値が下限の場合の最上段"
					: "Top at low analysis input",
			)
			.closest("div");
		expect(high).toHaveTextContent("6,000 kbps");
		expect(low).toHaveTextContent("1,000 kbps");
		expect(low).not.toHaveTextContent("6,000 kbps");
	});

	it("shows both ends of a conditional top interval when they differ", () => {
		const goal: PerTitleGoal = {
			...source(),
			strategy: "fixed-ranges",
			codec: "H264",
			maxBitrate: 6_000_000,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			autoRepresentations: false,
			rows: [
				{
					id: "top",
					height: 720,
					minBitrate: 1_000_000,
					maxBitrate: 6_000_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1_500_000,
					highComplexityBoundaryForMaxBitrate: 8_000_000,
				},
			],
		};
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent="cap"
				onIntentChange={vi.fn()}
				onEvaluate={vi.fn()}
				result={analyzePerTitleSettings(goal, "cap")}
			/>,
		);
		expect(
			screen.getByText("Top at high analysis input").closest("div"),
		).toHaveTextContent("4,000–4,461.538 kbps");
	});

	it.each([
		["cap", "cap-unresolved", "count-conditional"],
		["bandwidth", "quality-measurement-required", "cap-blocked"],
		["count", "count-required", "cap-unresolved"],
	] as const)("summarizes the chosen %s goal ahead of an unrelated warning", (intent, code, otherCode) => {
		const goal = source();
		const result = analyzePerTitleSettings(goal, intent);
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent={intent}
				onIntentChange={vi.fn()}
				onEvaluate={vi.fn()}
				result={{
					...result,
					findings: [
						{
							code: otherCode,
							severity: "warning",
							message: { en: "Other condition", ja: "別の条件" },
						},
						{
							code,
							severity: "info",
							message: {
								en: "Chosen goal conclusion",
								ja: "選択した目的の結論",
							},
						},
					],
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Chosen goal conclusion",
		);
	});

	it("prioritizes a configuration conflict over the selected goal conclusion", () => {
		const goal = source();
		const intent: PerTitleAnalysisIntent = "cap";
		const result = analyzePerTitleSettings(goal, intent);
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={goal}
				intent={intent}
				onIntentChange={vi.fn()}
				onEvaluate={vi.fn()}
				result={{
					...result,
					findings: [
						{
							code: "cap-blocked",
							severity: "warning",
							message: { en: "Cap conclusion", ja: "上限の結論" },
						},
						{
							code: "configuration-conflict",
							severity: "conflict",
							message: {
								en: "Fix the configuration conflict",
								ja: "設定の競合を確認",
							},
						},
					],
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Fix the configuration conflict",
		);
	});
});
