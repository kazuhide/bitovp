import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleRecommendation } from "./per-title-simulator-recommendation";
import { PerTitleSimulatorRows } from "./per-title-simulator-rows";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_000_000,
	countPolicy: { kind: "exact", count: 2 },
	rows: [
		{
			id: "lower",
			height: 360,
			width: 640,
			minBitrate: 100_000,
			maxBitrate: 400_000,
		},
		{ id: "upper", height: 720, minBitrate: 500_000, maxBitrate: 2_000_000 },
	],
};

function show(initialGoal = goal, locale: "en" | "ja" = "en") {
	return renderLocalized(
		<PerTitleSimulator
			open
			initialGoal={initialGoal}
			onOpenChange={vi.fn()}
			onApply={vi.fn()}
		/>,
		locale,
	);
}

describe("Per-Title recommendation flow", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps the analyzed-top assumption local, editable and stable across API changes (%s)", (locale) => {
		const proposal: PerTitleProposal = {
			id: "baseline",
			codec: "H264",
			status: "unknown",
			applicable: false,
			evidence: "model-only",
			countGuarantee: false,
			api: {
				global: {
					minBitrate: 100000,
					maxBitrate: 3000000,
					minBitrateStepSize: 1.2,
					maxBitrateStepSize: 4,
				},
				streams: [
					{ rowId: "start", height: 160, mode: "PER_TITLE_TEMPLATE" },
					{
						rowId: "fixed-a",
						height: 320,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: {
							minBitrate: 240000,
							maxBitrate: 400000,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
							lowComplexityBoundaryForMaxBitrate: 1000000,
							highComplexityBoundaryForMaxBitrate: 3000000,
						},
					},
					{
						rowId: "fixed-b",
						height: 640,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: {
							minBitrate: 800000,
							maxBitrate: 1200000,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
							lowComplexityBoundaryForMaxBitrate: 1000000,
							highComplexityBoundaryForMaxBitrate: 3000000,
						},
					},
					{ rowId: "option-a", height: 960, mode: "PER_TITLE_TEMPLATE" },
					{ rowId: "option-b", height: 1280, mode: "PER_TITLE_TEMPLATE" },
				],
			},
			scenarios: [],
			diagnostics: [],
		};
		const baseline = structuredClone(proposal);
		const snapshot = structuredClone({ proposal, baseline, goal });
		const axis = { minimum: 100000, maximum: 12000000 };
		const { rerender } = renderLocalized(
			<PerTitleRecommendation
				goal={goal}
				proposal={proposal}
				baseline={baseline}
				axis={axis}
			/>,
			locale,
		);
		const label =
			locale === "en"
				? "Assumed top bitrate (kbps)"
				: "解析後の最大ビットレート（仮定、kbps）";
		const sliderLabel =
			locale === "en"
				? "Assumed top bitrate slider (kbps)"
				: "解析後の最大ビットレート（仮定）のスライダー (kbps)";
		const input = screen.getByRole("spinbutton", { name: label });
		const slider = screen.getByRole("slider", { name: sliderLabel });
		expect(input).toHaveValue(3000);
		const updated = {
			...proposal,
			api: {
				...proposal.api,
				global: { ...proposal.api.global, maxBitrate: 4000000 },
			},
		};
		rerender(
			<PerTitleRecommendation
				goal={goal}
				proposal={updated}
				baseline={baseline}
				axis={axis}
			/>,
		);
		expect(input).toHaveValue(4000);
		fireEvent.change(input, { target: { value: "2000" } });
		expect(slider).toHaveValue("2000");
		const next = {
			...proposal,
			api: {
				...proposal.api,
				global: { ...proposal.api.global, maxBitrate: 2500000 },
			},
		};
		rerender(
			<PerTitleRecommendation
				goal={goal}
				proposal={next}
				baseline={baseline}
				axis={axis}
			/>,
		);
		expect(input).toHaveValue(2000);
		fireEvent.change(slider, { target: { value: "1500" } });
		expect(input).toHaveValue(1500);
		expect(
			screen.getByRole("img", {
				name: locale === "en" ? "Simulated output" : "想定出力",
			}),
		).toHaveTextContent("1,500");
		fireEvent.change(input, { target: { value: "" } });
		expect(input).toHaveValue(null);
		expect(slider).toBeDisabled();
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name:
					locale === "en"
						? "Reset assumed top bitrate"
						: "解析ビットレートの仮定をリセット",
			}),
		);
		expect(input).toHaveValue(2500);
		expect(slider).toBeEnabled();
		expect({ proposal, baseline, goal }).toEqual(snapshot);
	});

	it.each([
		"en",
		"ja",
	] as const)("shows a loaded out-of-global maximum and a concrete correction (%s)", (locale) => {
		show(
			{
				...goal,
				maxBitrate: 4_000_000,
				countPolicy: { kind: "unrestricted" },
				rows: [
					{
						id: "large-limit",
						height: 360,
						minBitrate: 200_000,
						maxBitrate: 40_000_000,
					},
				],
			},
			locale,
		);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("360 px");
		expect(alert).toHaveTextContent("40,000");
		expect(alert).toHaveTextContent("4,000");
		expect(alert).toHaveTextContent(
			locale === "ja" ? "全体の上限を上げるか" : "Raise the overall maximum",
		);
		expect(
			screen.getByRole("button", {
				name: locale === "ja" ? "差分を確認" : "Review changes",
			}),
		).toBeDisabled();
	});

	it("explains a minimum below the global floor without flagging complexity boundaries alone", () => {
		const invalid: PerTitleGoal = {
			...goal,
			rows: [
				{
					id: "below-floor",
					height: 240,
					minBitrate: 50_000,
					maxBitrate: 200_000,
				},
			],
		};
		const { unmount } = renderLocalized(
			<PerTitleRecommendation
				goal={invalid}
				proposal={recommendPerTitleSettings(invalid)}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("50");
		expect(screen.getByRole("alert")).toHaveTextContent("100");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Lower the overall minimum",
		);
		unmount();
		const valid: PerTitleGoal = {
			...goal,
			rows: [
				{
					id: "boundary",
					height: 240,
					minBitrate: 100_000,
					maxBitrate: 200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 3_000_000,
					highComplexityBoundaryForMaxBitrate: 4_000_000,
				},
			],
		};
		renderLocalized(
			<PerTitleRecommendation
				goal={valid}
				proposal={recommendPerTitleSettings(valid)}
			/>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a fixed chart ceiling as bitrate limits change and defaults to simulated output", () => {
		show({
			...goal,
			adjustments: {
				streams: {
					lower: { maxBitrate: { mode: "auto", method: "logarithmic" } },
				},
			},
		});
		const panel = screen.getByRole("region", { name: "Simulation" });
		expect(
			within(panel).getByRole("figure", { name: "Simulated output" }),
		).toBeVisible();
		fireEvent.click(
			within(panel).getByRole("button", { name: "Allowed ranges" }),
		);
		const figure = within(panel).getByRole("figure", {
			name: "Allowed bitrate ranges",
		});
		expect(within(figure).getByText("8,000")).toBeVisible();
		const before = Number(
			within(figure)
				.getAllByTestId("per-title-ladder-range")[0]
				?.getAttribute("x2"),
		);
		fireEvent.change(
			screen.getByRole("slider", { name: "Maximum bitrate slider (kbps)" }),
			{ target: { value: "4000" } },
		);
		expect(within(figure).getByText("8,000")).toBeVisible();
		expect(
			Number(
				within(figure)
					.getAllByTestId("per-title-ladder-range")[0]
					?.getAttribute("x2"),
			),
		).toBeGreaterThan(before);
		fireEvent.click(
			within(panel).getByRole("button", { name: "Simulated output" }),
		);
		expect(
			within(panel).getByRole("figure", { name: "Simulated output" }),
		).toBeVisible();
	});
	it.each([
		"en",
		"ja",
	] as const)("identifies a comparison-only result without advertising readiness (%s)", (locale) => {
		const proposal = recommendPerTitleSettings(goal);
		renderLocalized(
			<PerTitleRecommendation goal={goal} proposal={proposal} comparisonOnly />,
			locale,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			locale === "en" ? "Comparison only" : "比較専用",
		);
		expect(
			screen.queryByText(
				locale === "en" ? /Use these values to review/ : /この値を使って/,
			),
		).toBeNull();
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps explanations closed while reviewing the same proposal (%s)", (locale) => {
		show(goal, locale);
		const panel = screen.getByRole("region", {
			name: locale === "en" ? "Simulation" : "シミュレーション",
		});
		expect(
			screen.queryByText(
				locale === "en"
					? "Get recommended settings for your ladder requirements."
					: "必要なラダー構成に合わせて、使う設定を提案します。",
			),
		).toBeNull();
		expect(
			screen.getByText(
				locale === "en"
					? /Switching codecs loads/
					: /切り替えると、そのコーデック/,
			),
		).not.toBeVisible();
		expect(
			within(panel).getByText(
				locale === "en"
					? "Final outputs depend on content analysis."
					: "実際の出力は素材解析で決まります。",
			),
		).not.toBeVisible();
		expect(
			within(panel).queryByText(
				locale === "en"
					? "Use these values to review the encoding changes."
					: "この値でエンコード設定の差分を確認できます。",
			),
		).toBeNull();
		fireEvent.click(
			within(panel).getByText(
				locale === "en" ? "API parameters" : "APIパラメータ",
			),
		);
		expect(
			within(panel).getByText(
				locale === "en"
					? "Final outputs depend on content analysis."
					: "実際の出力は素材解析で決まります。",
			),
		).toBeVisible();
	});
	it.each([
		"en",
		"ja",
	] as const)("does not turn an internal example warning into a failed recommendation (%s)", (locale) => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			countPolicy: { kind: "exact", count: 6 },
			rows: [],
			adjustments: {
				global: {
					minBitrateStepSize: { mode: "auto", method: "constraints" },
					maxBitrateStepSize: { mode: "auto", method: "constraints" },
				},
			},
		};
		const proposal = recommendPerTitleSettings(countGoal);
		expect(proposal.derivation?.targetSatisfied).toBe(true);
		expect(proposal.status).toBe("candidate");
		expect(
			proposal.diagnostics.some((item) => item.code === "scenario-conflict"),
		).toBe(true);
		show(countGoal, locale);
		const panel = screen.getByRole("region", {
			name: locale === "en" ? "Simulation" : "シミュレーション",
		});
		expect(
			within(panel).queryByText(
				/scenario|本数やビットレート間隔の条件を満たせません/i,
			),
		).toBeNull();
		expect(
			within(panel).getByText(
				locale === "en" ? "Calculated count limit" : "計算上の本数上限",
			).nextElementSibling,
		).toHaveTextContent("6");
		fireEvent.click(
			screen.getByText(
				locale === "en"
					? "Comparison and calculation details"
					: "比較・計算の詳細",
			),
		);
		const diagnostics = screen.getByRole("region", {
			name: locale === "en" ? "Conditions to check" : "確認が必要な条件",
		});
		expect(
			within(diagnostics).queryByText(/inspect each scenario|該当するシナリオ/),
		).toBeNull();
		expect(
			within(diagnostics).getByText(
				locale === "en" ? /Some internal bitrate placements/ : /一部の検算では/,
			),
		).toBeVisible();
		expect(
			screen.getByRole("button", {
				name: locale === "en" ? "Review changes" : "差分を確認",
			}),
		).toBeEnabled();
	});
	it.each([
		["en", "Calculated count limit"],
		["ja", "計算上の本数上限"],
	] as const)("reads the calculated count limit rather than echoing the requested six renditions in %s", (locale, label) => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "maximum", count: 6 },
			minBitrateStepSize: 4,
			maxBitrateStepSize: 5,
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		const upper = proposal.scenarios.find(
			(scenario) => scenario.fraction === 1,
		);
		expect(proposal.derivation?.targetSatisfied).toBe(true);
		expect(upper?.status).toBe("modelled");
		const actualRange = upper?.modelCountRange;
		if (!actualRange) throw new Error("Missing model count range");
		expect(actualRange.maximum).toBeLessThan(6);
		renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
			locale,
		);
		expect(screen.getByText(label).nextElementSibling).toHaveTextContent(
			String(actualRange.maximum),
		);
		expect(screen.getByText(label).nextElementSibling).not.toHaveTextContent(
			"–",
		);
	});

	it("withholds model counts when the upper scenario or the successful check is missing", () => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "exact", count: 6 },
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		const { rerender } = renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
		);
		expect(screen.getByText("Calculated count limit")).toBeVisible();
		const derivation = proposal.derivation;
		if (!derivation) throw new Error("Missing derivation");
		for (const unchecked of [
			{ ...proposal, status: "unknown" as const },
			{ ...proposal, applicable: false },
			{ ...proposal, derivation: { ...derivation, targetSatisfied: false } },
			{
				...proposal,
				scenarios: proposal.scenarios.filter(
					(scenario) => scenario.fraction !== 1,
				),
			},
			{
				...proposal,
				scenarios: proposal.scenarios.map((scenario) => ({
					...scenario,
					status: "conflict" as const,
				})),
			},
			{
				...proposal,
				scenarios: proposal.scenarios.map((scenario) => ({
					...scenario,
					modelCountRange: { minimum: NaN, maximum: Infinity },
				})),
			},
		]) {
			rerender(
				<PerTitleRecommendation goal={countGoal} proposal={unchecked} />,
			);
			expect(screen.queryByText("Calculated count limit")).toBeNull();
		}
	});

	it("shows a certified adjustment interval without treating older derivation bounds as one", () => {
		const countGoal: PerTitleGoal = {
			...goal,
			strategy: "count",
			minBitrate: 16_000,
			maxBitrate: 256_000,
			countPolicy: { kind: "exact", count: 5 },
			rows: [],
		};
		const proposal = recommendPerTitleSettings(countGoal);
		expect(proposal.derivation?.minimumStepRange).toBeDefined();
		const { rerender } = renderLocalized(
			<PerTitleRecommendation goal={countGoal} proposal={proposal} />,
		);
		expect(
			screen.getByText("Minimum-step adjustment range").nextElementSibling,
		).toHaveTextContent("≈");
		expect(
			screen.getByText(
				/retains the same integer placement example and maximum ratio/,
			),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("API parameters"));
		expect(screen.getByText("Minimum-step adjustment range")).toBeVisible();
		const derivation = proposal.derivation;
		if (!derivation) throw new Error("Missing derivation");
		rerender(
			<PerTitleRecommendation
				goal={countGoal}
				proposal={{
					...proposal,
					derivation: {
						...derivation,
						minimumStepRange: undefined,
						ratioLowerExclusive: 1.1,
						ratioUpperInclusive: 4,
					},
				}}
			/>,
		);
		expect(screen.queryByText("Minimum-step adjustment range")).toBeNull();
		rerender(
			<PerTitleRecommendation
				goal={countGoal}
				proposal={{ ...proposal, status: "unknown", applicable: false }}
			/>,
		);
		expect(screen.queryByText("Minimum-step adjustment range")).toBeNull();
	});

	it.each([
		[
			"en",
			"Simulation",
			"Automatic candidates retain their attached bitrate settings as source data.",
		],
		[
			"ja",
			"シミュレーション",
			"自動生成の候補に付いたビットレート設定は元データとして保持します。",
		],
	] as const)("keeps inactive automatic warnings in closed details in %s", (locale, title, warning) => {
		show(
			{
				...goal,
				automaticTemplates: [
					{
						id: "automatic",
						height: 1080,
						minBitrate: 800_000,
						maxBitrate: 4_000_000,
					},
				],
			},
			locale,
		);
		const panel = screen.getByRole("region", { name: title });
		expect(
			within(panel).queryByText((text) => text.startsWith(warning)),
		).toBeNull();
		const diagnostic = screen.getByText((text) => text.startsWith(warning));
		expect(diagnostic).not.toBeVisible();
		fireEvent.click(
			screen.getByText(
				locale === "en"
					? "Comparison and calculation details"
					: "比較・計算の詳細",
			),
		);
		expect(diagnostic).toBeVisible();
		expect(
			within(
				within(panel).getByRole("region", {
					name:
						locale === "en"
							? "Calculated Per-Title settings"
							: "計算後のPer-Title設定",
				}),
			).getByText("PER_TITLE_TEMPLATE", { exact: true }),
		).toBeVisible();
	});

	it("shows simulated output first and keeps requested ranges available on the same axis", () => {
		show();
		const panel = screen.getByRole("region", { name: "Simulation" });
		expect(screen.getAllByRole("region", { name: "Simulation" })).toHaveLength(
			1,
		);
		expect(within(panel).getByText("100–2,000")).toBeVisible();
		expect(
			within(panel).getByRole("figure", { name: "Simulated output" }),
		).toBeVisible();
		expect(within(panel).getByText("minBitrateStepSize")).toBeVisible();
		expect(within(panel).getByText("maxBitrateStepSize")).toBeVisible();
		fireEvent.click(
			within(panel).getByRole("button", { name: "Allowed ranges" }),
		);
		const table = within(panel).getByRole("table", {
			name: "Allowed bitrate ranges (data)",
		});
		expect(
			within(table).getByRole("row", { name: "360 100–400" }),
		).toBeInTheDocument();
		expect(
			within(panel).getByRole("figure", { name: "Allowed bitrate ranges" }),
		).toBeVisible();
		expect(
			within(table).getByRole("row", { name: "720 500–2,000" }),
		).toBeInTheDocument();
		expect(within(panel).getByText("Minimum bitrate ratio")).not.toBeVisible();
		expect(within(panel).getByText("Maximum bitrate ratio")).not.toBeVisible();
		expect(within(panel).queryByRole("spinbutton")).toBeNull();
		expect(
			within(panel).getByText(/do not predict encoding quality/),
		).not.toBeVisible();
		expect(
			screen.queryByRole("region", { name: "Illustrative scenarios" }),
		).toBeNull();
		fireEvent.click(within(panel).getByText("API parameters"));
		expect(within(panel).getByText("Minimum bitrate ratio")).toBeVisible();
		expect(within(panel).getByText("Maximum bitrate ratio")).toBeVisible();
		expect(
			screen.queryByRole("spinbutton", {
				name: "Width (px, optional), rendition 1",
			}),
		).toBeNull();
		expect(
			screen.queryByRole("region", { name: "Automatic templates" }),
		).toBeNull();
		expect(screen.getByRole("region", { name: "Renditions" })).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeVisible();
	});

	it("keeps Japanese output and calculated settings visible while explanations start closed", () => {
		show(goal, "ja");
		const panel = screen.getByRole("region", { name: "シミュレーション" });
		expect(
			within(panel).getByRole("figure", { name: "想定出力" }),
		).toBeVisible();
		expect(within(panel).getByText("最小ビットレート比率")).not.toBeVisible();
		expect(
			within(panel).getByText(/画質を予測した値ではありません/),
		).not.toBeVisible();
		expect(screen.getByText("比較・計算の詳細")).toBeVisible();
		expect(
			screen.queryByRole("region", { name: "仮定したシナリオ" }),
		).toBeNull();
		expect(
			screen.queryByRole("spinbutton", {
				name: "幅 (px、省略可), レンディション 1",
			}),
		).toBeNull();
	});

	it("shows a short conflict status and keeps its diagnostic in details", () => {
		show({ ...goal, minBitrate: 3_000_000 });
		const panel = screen.getByRole("region", { name: "Simulation" });
		expect(within(panel).getByText("Needs adjustment")).toBeVisible();
		expect(
			within(panel).queryByText("Enter a positive, ordered bitrate interval."),
		).toBeNull();
		const diagnostic = screen.getByText(
			"Enter a positive, ordered bitrate interval.",
		);
		expect(diagnostic).not.toBeVisible();
		fireEvent.click(screen.getByText("Comparison and calculation details"));
		expect(diagnostic).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
	});

	it("separates candidate templates from the unknown output count with original rules", () => {
		show({
			...goal,
			automaticTemplates: [{ id: "automatic", height: 1080 }],
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
			},
		});
		const panel = screen.getByRole("region", { name: "Simulation" });
		fireEvent.click(
			within(panel).getByRole("button", { name: "Allowed ranges" }),
		);
		expect(within(panel).getByText(/Automatic candidates.*1/)).toBeVisible();
		expect(
			within(panel).getByText(/candidate count is not the output count/),
		).not.toBeVisible();
		expect(within(panel).getByRole("status")).toHaveTextContent(
			"Not established",
		);
		const proposedApi = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "{}",
		);
		expect(proposedApi.global.fixedResolutionAndBitrateConfiguration).toEqual({
			forcedRenditionAboveHighestFixedRepresentation: 1,
		});
		expect(within(panel).queryByText("Calculated count limit")).toBeNull();
		expect(
			screen.queryByRole("checkbox", {
				name: "Include original additional-rendition rules",
			}),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
	});

	it("offers only height for automatic candidates while retaining inactive source settings", async () => {
		const onChange = vi.fn();
		const automatic = {
			id: "automatic",
			height: 1080,
			width: 1920,
			minBitrate: 1_000_000,
			maxBitrate: 6_000_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 2_000_000,
			highComplexityBoundaryForMaxBitrate: 5_000_000,
		};
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={{ ...goal, automaticTemplates: [automatic] }}
				onChange={onChange}
				manualBounds={{}}
				onBitrateChange={vi.fn()}
				onResetBitrates={vi.fn()}
			/>,
		);
		expect(
			within(
				screen.getByRole("listitem", { name: "Automatic template 1" }),
			).getAllByRole("spinbutton"),
		).toHaveLength(1);
		expect(screen.queryByRole("combobox")).toBeNull();
		await userEvent.setup().clear(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), automatic template 1",
			}),
			{ target: { value: "720" } },
		);
		expect(onChange.mock.lastCall?.[0].automaticTemplates).toEqual([
			{ ...automatic, height: 720, width: 1280 },
		]);
	});
});
