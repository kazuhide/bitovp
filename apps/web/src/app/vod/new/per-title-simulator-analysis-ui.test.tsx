import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { applyPerTitleAdvice } from "./per-title-simulator-advice";
import { PerTitleAdvisor } from "./per-title-simulator-advisor";
import {
	analyzePerTitleSettings,
	type PerTitleAnalysisIntent,
} from "./per-title-simulator-analysis";
import { assessPerTitleLadder } from "./per-title-simulator-analysis-ladder";
import {
	PerTitleAnalysisDetails,
	PerTitleAnalysisPanel,
} from "./per-title-simulator-analysis-panel";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const source = (): PerTitleGoal => ({
	strategy: "count",
	codec: "VP9",
	minBitrate: 100_000,
	maxBitrate: 8_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "exact", count: 3 },
});

const mixedLadder = (maximum: number): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 120_000,
	maxBitrate: maximum,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "unrestricted" },
	targetQualityCrf: 19,
	complexityFactor: 1,
	resolutionScaleFactor: 0,
	autoRepresentations: false,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{ id: "first", height: 400, minBitrate: 240_000, maxBitrate: 440_000 },
		{ id: "second", height: 400, minBitrate: 520_000, maxBitrate: 800_000 },
		{ id: "middle", height: 600, minBitrate: 900_000, maxBitrate: 1_250_000 },
		{
			id: "highest",
			height: 800,
			minBitrate: 1_600_000,
			maxBitrate: 2_200_000,
		},
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
		lowComplexityBoundaryForMaxBitrate: 2_000_000,
		highComplexityBoundaryForMaxBitrate: 4_800_000,
	})),
	automaticTemplates: [
		{ id: "bottom-auto", height: 200 },
		{ id: "top-auto-a", height: 1000 },
		{ id: "top-auto-b", height: 1200 },
	],
});

describe("current Per-Title settings analysis", () => {
	it.each([
		"en",
		"ja",
	] as const)("preserves six declared outputs with alternative upper templates (%s)", (locale) => {
		const goal: PerTitleGoal = {
			...mixedLadder(7_200_000),
			countPolicy: { kind: "exact", count: 6 },
		};
		const normalized = tunePerTitleSettings(goal, goal).goal;
		const evaluated = analyzePerTitleSettings(normalized, "preserve");
		expect(evaluated.countStructure.nativeCount).toBe("requires-media");
		expect(evaluated.reach.count.status).not.toBe("model-checked");
		expect(evaluated.advice.length).toBeGreaterThan(0);
		expect(
			evaluated.advice.every((item) => item.proof === "conditional-settings"),
		).toBe(true);
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const api = () =>
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			);
		const before = api();
		fireEvent.change(
			screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
			{ target: { value: "preserve" } },
		);
		const evaluate = () =>
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "ja" ? "評価する" : "Evaluate",
				}),
			);
		evaluate();
		const summary = () =>
			screen.getByText(
				locale === "ja"
					? "指定した出力構成: 6本 = 200p + 400p × 2 + 600p + 800p + (1000p または 1200p)。実際の本数は素材で確認します。"
					: "Declared output structure: 6 = 200p + 400p × 2 + 600p + 800p + (1000p or 1200p). Native count requires media.",
			);
		expect(summary()).toBeVisible();
		expect(summary().closest("details")).toBeNull();
		const comparison = screen.getByRole("region", {
			name: locale === "ja" ? "調整案" : "Suggested adjustment",
		});
		expect(comparison).toBeVisible();
		const evaluation = screen.getByRole("region", {
			name: locale === "ja" ? "現在の設定を評価" : "Evaluate current settings",
		});
		const details = screen.getByText(
			locale === "ja" ? "評価の詳細" : "Evaluation details",
			{ selector: "summary" },
		);
		expect(details.closest("details")).not.toHaveAttribute("open");
		expect(
			evaluation.compareDocumentPosition(comparison) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			comparison.compareDocumentPosition(details) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(api()).toEqual(before);
		const adopt = screen.getAllByRole("button", {
			name: locale === "ja" ? "この調整を採用" : "Use this adjustment",
		})[0];
		if (!adopt) throw new Error("Expected the first checked adjustment.");
		fireEvent.click(adopt);
		expect(api()).not.toEqual(before);
		evaluate();
		expect(summary()).toBeVisible();
		expect(api().global.minBitrate).toBe(before.global.minBitrate);
		expect(api().global.maxBitrate).toBe(before.global.maxBitrate);
		expect(api().streams).toHaveLength(7);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		["en", 4_800_000],
		["ja", 4_800_000],
		["en", 7_200_000],
		["ja", 7_200_000],
	] as const)("compares every mixed template with a checked whole-ladder proposal (%s, %i)", (locale, maximum) => {
		const goal = mixedLadder(maximum);
		const normalized = tunePerTitleSettings(goal, goal).goal;
		const evaluated = analyzePerTitleSettings(normalized, "cap");
		const first = evaluated.advice[0];
		if (!first) throw new Error("Expected a certified whole-ladder proposal.");
		const explanation = first.explanation?.[locale];
		if (!explanation) throw new Error("Expected the proposal's reasoning.");
		const proposed = assessPerTitleLadder(first.goal, first.proposal);
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const api = () =>
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			);
		const before = api();
		fireEvent.change(
			screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
			{ target: { value: "cap" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "評価する" : "Evaluate",
			}),
		);
		expect(
			screen.getByRole("region", {
				name: locale === "ja" ? "調整案" : "Suggested adjustment",
			}),
		).toHaveTextContent(explanation);
		expect(api()).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
		const fullSummary = screen.getByText(
			locale === "ja" ? "ラダー全体" : "Full ladder",
			{ selector: "summary" },
		);
		expect(fullSummary.closest("details")).not.toHaveAttribute("open");
		fireEvent.click(
			screen.getByText(locale === "ja" ? "評価の詳細" : "Evaluation details", {
				selector: "summary",
			}),
		);
		fireEvent.click(fullSummary);
		const table = screen.getByRole("table", {
			name: locale === "ja" ? "ラダー全体" : "Full ladder",
		});
		const renderedRows = within(table).getAllByRole("row").slice(1);
		expect(renderedRows.map((row) => row.getAttribute("data-row-id"))).toEqual(
			evaluated.ladder.rows.map((row) => row.rowId),
		);
		expect(renderedRows).toHaveLength(7);
		const template = (id: string) => {
			const row = renderedRows.find(
				(item) => item.getAttribute("data-row-id") === id,
			);
			if (!row) throw new Error(`Missing template ${id}.`);
			return within(row);
		};
		const firstCells = template("first").getAllByRole("cell");
		expect(firstCells[0]).toHaveTextContent("240–440");
		expect(firstCells[1]).toHaveTextContent("240");
		expect(firstCells[2]).toHaveTextContent("440");
		expect(template("first").getByRole("rowheader")).toHaveTextContent(
			"400 px",
		);
		expect(template("second").getByRole("rowheader")).toHaveTextContent(
			"400 px",
		);
		expect(
			template("bottom-auto").getAllByText(
				locale === "ja" ? "素材解析で決定" : "Determined by media",
			),
		).toHaveLength(4);
		const target = proposed.rows.find(
			(row) => row.rowId === "first",
		)?.configured;
		if (!target) throw new Error("Expected a proposed configured range.");
		const format = (value: number) =>
			new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
				value / 1000,
			);
		expect(template("first").getAllByRole("cell").at(-1)).toHaveTextContent(
			target.minimum === target.maximum
				? format(target.minimum)
				: `${format(target.minimum)}–${format(target.maximum)}`,
		);
		expect(
			screen.getByText(
				locale === "ja" ? "全区間の分割数" : "Full-interval segments",
			),
		).toBeVisible();
		expect(
			screen.getByText(
				locale === "ja"
					? "上段の応答・確認範囲・分割数"
					: "Top response, domain and segments",
			).nextElementSibling,
		).toHaveTextContent(locale === "ja" ? "追従確認" : "Tracked");
		expect(
			screen.getByText(
				locale === "ja"
					? "配置余地と容量は算術値で、実際の出力本数ではありません。"
					: "Placement slots and capacity are arithmetic, not the native output count.",
			),
		).toBeVisible();
		const select = screen.getAllByRole("combobox", {
			name: locale === "ja" ? /^選択:/ : /^Decision:/,
		})[0];
		if (!select) throw new Error("Expected selectable changes.");
		expect(select).toHaveValue("skip");
		fireEvent.change(select, { target: { value: "apply" } });
		expect(select).toHaveValue("apply");
		expect(
			screen
				.getAllByRole("button", {
					name:
						locale === "ja"
							? "選択した内容で再評価"
							: "Re-evaluate selected decisions",
				})
				.filter((button) => !button.hasAttribute("disabled")),
		).toHaveLength(1);
		expect(api()).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("offers the goal that preserves current bitrate limits and count (%s)", (locale) => {
		const onIntentChange = vi.fn();
		renderLocalized(
			<PerTitleAnalysisPanel
				goal={source()}
				intent="cap"
				onIntentChange={onIntentChange}
				onEvaluate={vi.fn()}
			/>,
			locale,
		);
		expect(
			screen.getByRole("option", {
				name:
					locale === "ja"
						? "最小・最大と本数を保って見直す"
						: "Optimize within the current bitrate limits and count",
			}),
		).toHaveValue("preserve");
		fireEvent.change(
			screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
			{ target: { value: "preserve" } },
		);
		expect(onIntentChange).toHaveBeenCalledWith("preserve");
	});

	it.each([
		["en", "proposal"],
		["ja", "proposal"],
		["en", "keep-current"],
		["ja", "keep-current"],
		["en", "no-certified-candidate"],
		["ja", "no-certified-candidate"],
		["en", "inspect-only"],
		["ja", "inspect-only"],
	] as const)("shows a short proposal or the supplied %s outcome for %s outside collapsed details", (locale, status) => {
		const goal = source();
		const evaluated = analyzePerTitleSettings(goal, "count");
		const message = { en: `Decision: ${status}`, ja: `評価結果: ${status}` };
		const result = {
			...evaluated,
			findings: [],
			advice: status === "proposal" ? evaluated.advice : [],
			decision: { status, message },
		};
		renderLocalized(
			<>
				<PerTitleAnalysisPanel
					goal={goal}
					intent="count"
					onIntentChange={vi.fn()}
					onEvaluate={vi.fn()}
					result={result}
				/>
				<PerTitleAnalysisDetails goal={goal} result={result} />
			</>,
			locale,
		);
		const conclusion =
			status === "proposal"
				? locale === "ja"
					? "調整案があります。"
					: "A checked adjustment is available."
				: message[locale];
		expect(screen.getByText(conclusion)).toBeVisible();
		expect(screen.getByText(conclusion).closest("details")).toBeNull();
		expect(
			screen
				.getByText(locale === "ja" ? "評価の詳細" : "Evaluation details")
				.closest("details"),
		).not.toHaveAttribute("open");
	});

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
		expect(
			within(panel).queryByText(
				locale === "ja" ? "評価の詳細" : "Evaluation details",
			),
		).toBeNull();
		const details = screen
			.getByText(locale === "ja" ? "評価の詳細" : "Evaluation details")
			.closest("details");
		expect(details).not.toHaveAttribute("open");
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("places explicitly maintained values before the closed diagnostics (%s)", (locale) => {
		const goal = source();
		const original = structuredClone(goal);
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
			locale,
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
			{ target: { value: "count" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "評価する" : "Evaluate",
			}),
		);
		const decision = screen.getAllByRole("combobox", {
			name: locale === "ja" ? /^選択:/ : /^Decision:/,
		})[0];
		if (!decision) throw new Error("Expected a parameter decision.");
		fireEvent.change(decision, { target: { value: "keep" } });
		expect(
			screen.queryByRole("region", {
				name: locale === "ja" ? "維持する値" : "Maintained values",
			}),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name:
					locale === "ja"
						? "選択した内容で再評価"
						: "Re-evaluate selected decisions",
			}),
		);
		const maintained = screen.getByRole("region", {
			name: locale === "ja" ? "維持する値" : "Maintained values",
		});
		const details = screen.getByText(
			locale === "ja" ? "評価の詳細" : "Evaluation details",
			{ selector: "summary" },
		);
		expect(details.closest("details")).not.toHaveAttribute("open");
		expect(
			maintained.compareDocumentPosition(details) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(goal).toEqual(original);
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
		const detailSummary = screen.getByText(
			locale === "ja" ? "評価の詳細" : "Evaluation details",
			{ selector: "summary" },
		);
		expect(detailSummary.closest("details")).not.toHaveAttribute("open");
		fireEvent.click(detailSummary);
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
		expect(high).toBeVisible();
		expect(low).toHaveTextContent("1,000 kbps");
		expect(low).toBeVisible();
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
			<PerTitleAnalysisDetails
				goal={goal}
				result={analyzePerTitleSettings(goal, "cap")}
			/>,
		);
		const summary = screen.getByText("Evaluation details", {
			selector: "summary",
		});
		expect(summary.closest("details")).not.toHaveAttribute("open");
		fireEvent.click(summary);
		expect(
			screen.getByText("Top at high analysis input").closest("div"),
		).toHaveTextContent("4,000–4,461.538 kbps");
	});

	it.each([
		["cap", "cap-unresolved", "count-conditional"],
		["bandwidth", "quality-measurement-required", "cap-blocked"],
		["count", "count-required", "cap-unresolved"],
	] as const)("explains the chosen %s goal ahead of an unrelated warning when no advice is available", (intent, code, otherCode) => {
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
					advice: [],
					decision: { ...result.decision, status: "no-certified-candidate" },
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
					advice: [],
					decision: { ...result.decision, status: "no-certified-candidate" },
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
