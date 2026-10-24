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
	] as const)("retains the count-model-limit action beside a generic configuration conflict (%s)", (locale) => {
		const ja = locale === "ja";
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{
					...source(),
					maxBitrate: 4_000_000,
					countPolicy: { kind: "exact", count: 257 },
				}}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const panel = screen.getByRole("region", {
			name: ja ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(within(panel).getByRole("status")).toHaveTextContent("256");
		fireEvent.click(
			within(panel).getByRole("button", {
				name: ja ? "設定を確認: 本数条件" : "Review setting: Count goal",
			}),
		);
		const countInput = screen.getByRole("spinbutton", {
			name: ja ? "希望する本数" : "Desired count",
		});
		expect(countInput).toHaveFocus();
		expect(countInput).toHaveValue(257);
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("discloses changed Auto fields while retaining unrelated Auto controls after adoption (%s)", (locale) => {
		const ja = locale === "ja";
		const goal: PerTitleGoal = {
			strategy: "automatic",
			codec: "H264",
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: {},
			automaticTemplates: [{ id: "automatic-template" }],
			adjustments: {
				global: {
					minBitrateStepSize: { mode: "auto", method: "default" },
					targetQualityCrf: { mode: "auto", method: "default" },
				},
			},
		};
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
		const minimumMode = () =>
			screen.getByRole("combobox", {
				name: ja
					? "ビットレート間隔の下限 の調整"
					: "Minimum bitrate ratio adjustment",
			});
		const qualityMode = () =>
			screen.getByRole("combobox", {
				name: ja ? "目標品質 (CRF) の調整" : "Target quality (CRF) adjustment",
			});
		expect(minimumMode()).toHaveValue("auto");
		expect(qualityMode()).toHaveValue("auto");
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const suggestion = screen.getByRole("region", {
			name: ja ? "調整案" : "Suggested adjustment",
		});
		expect(
			within(suggestion).getByText(
				ja
					? "自動（エンコーダの既定値） → 固定"
					: "Auto (Encoder default) → Fixed",
			),
		).toBeVisible();
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		fireEvent.click(
			within(suggestion).getByRole("button", {
				name: ja ? "この調整を採用" : "Use this adjustment",
			}),
		);
		expect(minimumMode()).toHaveValue("fixed");
		expect(qualityMode()).toHaveValue("auto");
		expect(screen.getByTestId("per-title-api-settings").textContent).not.toBe(
			before,
		);
		expect(
			screen.getByRole("spinbutton", {
				name: ja ? "希望する本数" : "Desired count",
			}),
		).toHaveValue(6);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("recovers a checked real count proposal by releasing its identified maintained step (%s)", (locale) => {
		const ja = locale === "ja";
		const goal: PerTitleGoal = {
			strategy: "automatic",
			codec: "H264",
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "exact", count: 6 },
			autoRepresentations: {},
			automaticTemplates: [{ id: "automatic-template" }],
		};
		const before = structuredClone(goal);
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
			locale,
		);
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: ja
					? "選択: ビットレート間隔の下限"
					: "Decision: Minimum bitrate ratio",
			}),
			{ target: { value: "keep" } },
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "選択した内容で再評価" : "Re-evaluate selected decisions",
			}),
		);
		expect(
			screen.queryByRole("region", {
				name: ja ? "調整案" : "Suggested adjustment",
			}),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: ja
					? "該当項目の維持を解除して再評価"
					: "Release these maintained values and re-evaluate",
			}),
		);
		expect(
			screen.getByRole("region", {
				name: ja ? "調整案" : "Suggested adjustment",
			}),
		).toBeVisible();
		expect(
			screen.queryByRole("region", {
				name: ja ? "維持する値" : "Maintained values",
			}),
		).toBeNull();
		expect(goal).toEqual(before);
		expect(onAdopt).not.toHaveBeenCalled();
	});

	it.each([
		["en", "all"],
		["ja", "all"],
		["en", "partial"],
		["ja", "partial"],
	] as const)("offers count-repair values after all-automatic setup without changing the default evaluation goal (%s, %s)", (locale, adoption) => {
		const ja = locale === "ja";
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={source()}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "新規設定ウィザード" : "New setup wizard",
			}),
		);
		fireEvent.click(
			screen.getByRole("radio", {
				name: ja ? "すべて任せる" : "Let the encoder choose",
			}),
		);
		const next = () =>
			fireEvent.click(
				screen.getByRole("button", { name: ja ? "次へ" : "Next" }),
			);
		next();
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: ja ? "最小ビットレート (kbps)" : "Minimum bitrate (kbps)",
			}),
			{ target: { value: "128" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: ja ? "最大ビットレート (kbps)" : "Maximum bitrate (kbps)",
			}),
			{ target: { value: "4000" } },
		);
		next();
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "シミュレーターで確認" : "Inspect in simulator",
			}),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: ja ? "レンディションの本数" : "Rendition count",
			}),
			{ target: { value: "exact" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: ja ? "希望する本数" : "Desired count",
			}),
			{ target: { value: "6" } },
		);
		const purpose = screen.getByRole("combobox", {
			name: ja ? "目的" : "Goal",
		});
		expect(purpose).toHaveValue("adaptive");
		const api = () =>
			JSON.parse(
				screen.getByTestId("per-title-api-settings").textContent ?? "{}",
			);
		const before = api();
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const suggestion = screen.getByRole("region", {
			name: ja ? "調整案" : "Suggested adjustment",
		});
		expect(suggestion).toBeVisible();
		expect(
			within(suggestion).getAllByRole("combobox", {
				name: ja ? /^選択:/ : /^Decision:/,
			}).length,
		).toBeGreaterThan(0);
		expect(api()).toEqual(before);
		if (adoption === "partial") {
			fireEvent.change(
				within(suggestion).getByRole("combobox", {
					name: ja
						? "選択: ビットレート間隔の上限"
						: "Decision: Maximum bitrate ratio",
				}),
				{ target: { value: "apply" } },
			);
			fireEvent.click(
				within(suggestion).getByRole("button", {
					name: ja ? "選択した内容で再評価" : "Re-evaluate selected decisions",
				}),
			);
			expect(api().global.minBitrateStepSize).toBe(
				before.global.minBitrateStepSize,
			);
			expect(api().global.maxBitrateStepSize).not.toBe(
				before.global.maxBitrateStepSize,
			);
		}
		fireEvent.click(
			within(
				screen.getByRole("region", {
					name: ja ? "調整案" : "Suggested adjustment",
				}),
			).getByRole("button", {
				name: ja ? "この調整を採用" : "Use this adjustment",
			}),
		);
		const after = api();
		expect([
			after.global.minBitrateStepSize,
			after.global.maxBitrateStepSize,
		]).not.toEqual([
			before.global.minBitrateStepSize,
			before.global.maxBitrateStepSize,
		]);
		expect(after.global.minBitrate).toBe(128_000);
		expect(after.global.maxBitrate).toBe(4_000_000);
		expect(
			screen.getByRole("combobox", {
				name: ja ? "レンディションの本数" : "Rendition count",
			}),
		).toHaveValue("exact");
		expect(
			screen.getByRole("spinbutton", {
				name: ja ? "希望する本数" : "Desired count",
			}),
		).toHaveValue(6);
		expect(purpose).toHaveValue("adaptive");
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		expect(
			within(
				screen.getByRole("region", {
					name: ja ? "現在の設定を評価" : "Evaluate current settings",
				}),
			)
				.getByRole("status")
				.textContent?.trim(),
		).not.toBe("");
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("takes a missing count requirement to the current simulator input (%s)", (locale) => {
		const ja = locale === "ja";
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{
					...source(),
					strategy: "automatic",
					countPolicy: { kind: "unrestricted" },
				}}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: ja ? "目的" : "Goal" }),
			{ target: { value: "count" } },
		);
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "設定を確認: 本数条件" : "Review setting: Count goal",
			}),
		);
		expect(
			screen.getByRole("combobox", {
				name: ja ? "レンディションの本数" : "Rendition count",
			}),
		).toHaveFocus();
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("opens the affected global spacing input without changing the draft (%s)", (locale) => {
		const ja = locale === "ja";
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={{
					...source(),
					strategy: "automatic",
					countPolicy: { kind: "unrestricted" },
					minBitrateStepSize: 0,
				}}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja
					? "設定を確認: ビットレート間隔の下限"
					: "Review setting: Minimum bitrate ratio",
			}),
		);
		const field = screen.getByRole("spinbutton", {
			name: ja ? "ビットレート間隔の下限" : "Minimum bitrate ratio",
		});
		expect(field).toHaveFocus();
		expect(field.closest("details")).toHaveAttribute("open");
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});

	it.each([
		"en",
		"ja",
	] as const)("opens the affected rendition range input without changing the draft (%s)", (locale) => {
		const ja = locale === "ja";
		const onApply = vi.fn();
		const goal: PerTitleGoal = {
			...source(),
			strategy: "fixed-ranges",
			countPolicy: { kind: "unrestricted" },
			rows: [
				{
					id: "top",
					height: 720,
					minBitrate: Number.NaN,
					maxBitrate: 6_000_000,
				},
			],
		};
		renderLocalized(
			<PerTitleSimulator
				initialGoal={goal}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const before = screen.getByTestId("per-title-api-settings").textContent;
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja
					? "設定を確認: 最小ビットレート (kbps), 段 1"
					: "Review setting: Minimum bitrate (kbps), rendition 1",
			}),
		);
		expect(
			screen.getByRole("spinbutton", {
				name: ja
					? "最小ビットレート (kbps), レンディション 1"
					: "Minimum bitrate (kbps), rendition 1",
			}),
		).toHaveFocus();
		expect(screen.getByTestId("per-title-api-settings").textContent).toBe(
			before,
		);
		expect(onApply).not.toHaveBeenCalled();
	});

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
		const goal = { ...mixedLadder(maximum), maxBitrateStepSize: 1.6 };
		const normalized = tunePerTitleSettings(goal, goal).goal;
		const evaluated = analyzePerTitleSettings(normalized, "adaptive");
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
			{ target: { value: "adaptive" } },
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
		expect(evaluated.ladder.topResponse.status).toBe("gap");
		const response = (ladder: typeof proposed) => {
			const labels =
				locale === "ja"
					? {
							tracked: "追従確認",
							gap: "接続条件外",
							unknown: "未確認",
							"not-applicable": "対象外",
						}
					: {
							tracked: "Tracked",
							gap: "Connection gap",
							unknown: "Unknown",
							"not-applicable": "Not applicable",
						};
			const { status, domain, checkedSegments } = ladder.topResponse;
			return `${labels[status]}${domain ? ` · ${domain.minimum === domain.maximum ? format(domain.minimum) : `${format(domain.minimum)}–${format(domain.maximum)}`} kbps · ${checkedSegments}` : ""}`;
		};
		const currentResponse = response(evaluated.ladder);
		const nextResponse = response(proposed);
		expect(
			screen.getByText(
				locale === "ja"
					? "上段の応答・確認範囲・分割数"
					: "Top response, domain and segments",
			).nextElementSibling,
		).toHaveTextContent(
			currentResponse === nextResponse
				? currentResponse
				: `${currentResponse} → ${nextResponse}`,
		);
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
		const evaluated = analyzePerTitleSettings(goal, "adaptive", {
			referenceGoal: goal,
		});
		expect(evaluated.search.generated).toBeGreaterThan(0);
		const onAdopt = vi.fn();
		renderLocalized(
			<PerTitleAdvisor goal={goal} session={goal} onAdopt={onAdopt} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
		expect(
			within(
				screen.getByRole("region", { name: "Evaluate current settings" }),
			).getByRole("status"),
		).toHaveTextContent(
			evaluated.decision.status === "proposal"
				? "A checked adjustment is available."
				: evaluated.decision.message.en,
		);
		expect(screen.queryByText(/Automatic adjustment is enabled/)).toBeNull();
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
		["cap", "cap-unresolved", "count-conditional", "Chosen goal conclusion"],
		[
			"bandwidth",
			"quality-measurement-required",
			"cap-blocked",
			"Other condition",
		],
		["count", "count-required", "cap-unresolved", "Chosen goal conclusion"],
	] as const)("keeps the %s decision visible with a relevant cause instead of substituting media advice for a configuration warning", (intent, code, otherCode, cause) => {
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
					decision: {
						status: "no-certified-candidate",
						message: {
							en: "No checked improving adjustment.",
							ja: "検証済みの改善案はありません。",
						},
					},
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
			"No checked improving adjustment.",
		);
		expect(screen.getByRole("status")).toHaveTextContent(cause);
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
