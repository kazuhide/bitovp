import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	createPerTitleEvaluationAdvice,
	type PerTitleAdviceField,
} from "./per-title-simulator-advice";
import { PerTitleAdvicePreview } from "./per-title-simulator-advice-preview";
import { PerTitleOutputChart } from "./per-title-simulator-output";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const minimum: PerTitleAdviceField = {
	scope: "stream",
	rowId: "fixed",
	key: "minBitrate",
};
const maximum: PerTitleAdviceField = {
	scope: "stream",
	rowId: "fixed",
	key: "maxBitrate",
};

function fixture(includeUpperTemplate = true) {
	const goal: PerTitleGoal = {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 100_000,
		maxBitrate: 4_000_000,
		minBitrateStepSize: 1.25,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: false,
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		},
		rows: [
			{
				id: "fixed",
				height: 720,
				minBitrate: 1_000_000,
				maxBitrate: 1_600_000,
				bitrateSelectionMode: "COMPLEXITY_RANGE",
				lowComplexityBoundaryForMaxBitrate: 1_250_000,
				highComplexityBoundaryForMaxBitrate: 4_000_000,
			},
		],
		automaticTemplates: [
			{ id: "bottom", height: 120 },
			...(includeUpperTemplate ? [{ id: "top", height: 1080 }] : []),
		],
	};
	const options = { contextKey: "preview-fixture" };
	const advice = createPerTitleEvaluationAdvice(
		goal,
		{
			...goal,
			maxBitrate: 8_000_000,
			rows: goal.rows?.map((row) => ({
				...row,
				minBitrate: 1_200_000,
				maxBitrate: 2_400_000,
			})),
		},
		options,
	);
	if (!advice)
		throw new Error("Expected a certified neutral range adjustment.");
	return { goal, advice, options };
}

describe.each(["en", "ja"] as const)("staged ladder preview (%s)", (locale) => {
	const ja = locale === "ja";
	const title = ja ? "ラダーの変化" : "Ladder comparison";
	const currentTitle = ja ? "現在のラダー" : "Current ladder";
	const allTitle = ja ? "すべて反映した場合" : "After applying all changes";
	const selectedTitle = ja
		? "選択した変更を反映した場合"
		: "After applying selected changes";
	const keptTitle = ja ? "現在値を維持する場合" : "Keeping current values";
	const fieldTitle = ja
		? "解析値の仮定 (kbps)"
		: "Assumed analysis bitrate (kbps)";
	const configured = (range: string) =>
		`${ja ? "設定範囲" : "Configured"} ${range}`;
	const getFigure = (name: string) => screen.getByRole("figure", { name });
	const axisText = (figure: HTMLElement) =>
		within(figure).getByTestId("per-title-output-axis").textContent;
	const endpoint = (figure: HTMLElement) => {
		const row = within(figure)
			.getAllByTestId("per-title-output-row")
			.find((row) => row.textContent?.includes(ja ? "設定範囲" : "Configured"));
		if (!row) throw new Error("Expected a configured fixed row.");
		return Number(
			within(row).getByTestId("per-title-output-endpoint").getAttribute("x1"),
		);
	};

	it("shows the whole recommendation with one shared assumption and fixed axis before adoption", () => {
		const input = fixture();
		const before = structuredClone(input);
		renderLocalized(
			<PerTitleAdvicePreview {...input} selected={[]} kept={[]} />,
			locale,
		);
		expect(screen.getByRole("region", { name: title })).toBeVisible();
		const current = getFigure(currentTitle);
		const after = getFigure(allTitle);
		expect(current.parentElement).toBe(after.parentElement);
		expect(current.parentElement).toHaveClass(
			"grid",
			"grid-cols-1",
			"lg:grid-cols-2",
		);
		expect(within(current).getByText(configured("1,000–1,600"))).toBeVisible();
		expect(within(after).getByText(configured("1,200–2,400"))).toBeVisible();
		expect(axisText(current)).toEqual(axisText(after));
		expect(axisText(current)).toContain("8,000");
		expect(screen.getAllByRole("slider")).toHaveLength(1);
		const field = screen.getByRole("spinbutton", { name: fieldTitle });
		expect(field).toHaveValue(8000);
		expect(current).toHaveTextContent(ja ? "仮定値 8,000" : "assumed 8,000");
		expect(after).toHaveTextContent(
			ja ? "解析値を 8,000 kbps と仮定" : "Upper input assumed at 8,000 kbps",
		);
		const dataTitle = ja ? `${allTitle}（データ）` : `${allTitle} (data)`;
		expect(screen.getByRole("table", { name: dataTitle })).toBeInTheDocument();
		const previous = [endpoint(current), endpoint(after)];
		fireEvent.change(field, { target: { value: "2000" } });
		for (const figure of [current, after]) {
			expect(figure).toHaveTextContent(
				ja ? "解析値を 2,000 kbps と仮定" : "Upper input assumed at 2,000 kbps",
			);
			expect(axisText(figure)).toEqual(axisText(current));
		}
		expect(endpoint(current)).toBeLessThan(previous[0] ?? 0);
		expect(endpoint(after)).toBeLessThan(previous[1] ?? 0);
		fireEvent.change(screen.getByRole("slider"), {
			target: { value: "3000" },
		});
		expect(field).toHaveValue(3000);
		for (const figure of [current, after])
			expect(figure).toHaveTextContent(
				ja ? "解析値を 3,000 kbps と仮定" : "Upper input assumed at 3,000 kbps",
			);
		expect(input).toEqual(before);
	});

	it("updates only staged fields and keeps the full recommendation axis stable", () => {
		const input = fixture();
		const before = structuredClone(input);
		const { rerender } = renderLocalized(
			<PerTitleAdvicePreview {...input} selected={[]} kept={[]} />,
			locale,
		);
		const originalAxis = axisText(getFigure(allTitle));
		fireEvent.change(screen.getByRole("spinbutton", { name: fieldTitle }), {
			target: { value: "2000" },
		});
		rerender(
			<PerTitleAdvicePreview
				{...input}
				selected={[maximum]}
				kept={[minimum]}
			/>,
		);
		const after = getFigure(selectedTitle);
		expect(within(after).getByText(configured("1,000–2,400"))).toBeVisible();
		expect(within(after).queryByText(configured("1,200–2,400"))).toBeNull();
		expect(axisText(after)).toEqual(originalAxis);
		expect(screen.getByRole("spinbutton", { name: fieldTitle })).toHaveValue(
			2000,
		);
		expect(input).toEqual(before);
	});

	it("compares current values when all staged decisions are Keep", () => {
		const input = fixture();
		const before = structuredClone(input);
		renderLocalized(
			<PerTitleAdvicePreview {...input} selected={[]} kept={[minimum]} />,
			locale,
		);
		const current = getFigure(currentTitle);
		const after = getFigure(keptTitle);
		expect(within(after).getByText(configured("1,000–1,600"))).toBeVisible();
		expect(endpoint(after)).toEqual(endpoint(current));
		expect(axisText(after)).toEqual(axisText(current));
		expect(input).toEqual(before);
	});

	it("retains conditional constraints and aggregate automatic ranges while the output count is unknown", () => {
		const input = fixture();
		expect(input.advice.proposal.status).toBe("unknown");
		expect(input.advice.proposal.countGuarantee).toBe(false);
		renderLocalized(
			<PerTitleAdvicePreview {...input} selected={[]} kept={[]} />,
			locale,
		);
		for (const name of [currentTitle, allTitle]) {
			const figure = getFigure(name);
			expect(within(figure).getByRole("img", { name })).toBeVisible();
			expect(
				within(figure).getAllByTestId("per-title-output-band").length,
			).toBeGreaterThan(0);
			expect(figure).toHaveTextContent("PER_TITLE_TEMPLATE");
			expect(
				within(figure).getByText(
					ja ? "追加出力は未確定" : "Additional outputs unknown",
				),
			).toBeVisible();
			const automatic = within(figure)
				.getAllByTestId("per-title-output-row")
				.find((row) =>
					row.textContent?.includes(
						ja ? "自動生成の範囲（仮定）" : "Automatic range (assumed)",
					),
				);
			if (!automatic) throw new Error("Expected an aggregate automatic range.");
			expect(automatic).toHaveTextContent(ja ? "条件付き" : "Conditional");
			expect(
				within(automatic).queryByTestId("per-title-output-target"),
			).toBeNull();
			expect(
				within(automatic).queryByTestId("per-title-output-endpoint"),
			).toBeNull();
			expect(automatic).not.toHaveTextContent("1080 px");
		}
		expect(getFigure(currentTitle)).toHaveTextContent(
			ja ? "計算点 1,600" : "Calculated point 1,600",
		);
		expect(
			screen.getByText(
				ja
					? "実際の本数・解像度・画質は素材で確認します。"
					: "Verify actual rendition count, resolutions and quality with media.",
			),
		).toBeVisible();
	});

	it("keeps forced upper values in a conditional fallback when no upper template is declared", () => {
		const input = fixture(false);
		const before = structuredClone(input);
		renderLocalized(
			<PerTitleAdvicePreview {...input} selected={[]} kept={[]} />,
			locale,
		);
		for (const [name, rate] of [
			[currentTitle, "2,000"],
			[allTitle, "3,000"],
		] as const) {
			const figure = getFigure(name);
			expect(
				within(figure).getByTestId("per-title-forced-fallback"),
			).toHaveTextContent(
				ja
					? `固定段が最上位なら ${rate} kbps（1段・各段×1.25）。通常上段の上限ではありません。`
					: `If fixed is highest: ${rate} kbps (1 step, ×1.25 each). This factor does not cap normal upper outputs.`,
			);
			expect(
				within(figure).getByText(
					ja ? "追加出力は未確定" : "Additional outputs unknown",
				),
			).toBeVisible();
			const rows = within(figure).getAllByTestId("per-title-output-row");
			expect(rows).toHaveLength(2);
			for (const row of rows)
				expect(row).not.toHaveTextContent(
					ja
						? "固定レンディションが最上位の場合に追加"
						: "Additional (if fixed is highest)",
				);
		}
		fireEvent.change(screen.getByRole("spinbutton", { name: fieldTitle }), {
			target: { value: "1000" },
		});
		const after = getFigure(allTitle);
		expect(
			within(after).getByTestId("per-title-forced-fallback"),
		).toHaveTextContent(
			ja
				? "固定段が最上位なら 1,500–1,636.363 kbps（1段・各段×1.25）。通常上段の上限ではありません。"
				: "If fixed is highest: 1,500–1,636.363 kbps (1 step, ×1.25 each). This factor does not cap normal upper outputs.",
		);
		const fixed = within(after)
			.getAllByTestId("per-title-output-row")
			.find((row) => row.textContent?.includes(configured("1,200–2,400")));
		if (!fixed) throw new Error("Expected the configured fixed row.");
		expect(fixed).toHaveTextContent(
			ja ? "有効範囲 1,200–1,309.09" : "Effective interval 1,200–1,309.09",
		);
		expect(fixed).toHaveTextContent(ja ? "条件付き" : "Conditional");
		expect(within(fixed).queryByTestId("per-title-output-target")).toBeNull();
		expect(within(fixed).queryByTestId("per-title-output-endpoint")).toBeNull();
		const band = within(fixed).getByTestId("per-title-output-band");
		expect(Number(band.getAttribute("x1"))).toBeLessThan(
			Number(band.getAttribute("x2")),
		);
		expect(
			within(after).getByText(
				ja ? "追加出力は未確定" : "Additional outputs unknown",
			),
		).toBeVisible();
		expect(input).toEqual(before);
	});

	it("shows a concise conflict instead of a feasible after chart for an invalid subset", () => {
		const goal: PerTitleGoal = {
			strategy: "automatic",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 8_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
			countPolicy: { kind: "unrestricted" },
		};
		const advice = createPerTitleEvaluationAdvice(goal, {
			...goal,
			minBitrateStepSize: 2,
			maxBitrateStepSize: 3,
		});
		if (!advice) throw new Error("Expected a checked count adjustment.");
		renderLocalized(
			<PerTitleAdvicePreview
				goal={goal}
				advice={advice}
				selected={[{ scope: "global", key: "minBitrateStepSize" }]}
				kept={[]}
			/>,
			locale,
		);
		expect(getFigure(currentTitle)).toBeVisible();
		expect(screen.getByRole("status")).toHaveTextContent(
			ja
				? "選択した変更は条件が競合するため、変更後のラダーを表示できません。"
				: "The selected changes conflict; the after ladder is unavailable.",
		);
		expect(screen.queryByRole("figure", { name: selectedTitle })).toBeNull();
	});

	it("does not render an after chart for stale recommendation context", () => {
		const input = fixture();
		renderLocalized(
			<PerTitleAdvicePreview
				{...input}
				options={{ contextKey: "different-context" }}
				selected={[]}
				kept={[]}
			/>,
			locale,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			ja
				? "現在の設定ではこの調整案を比較できません。再評価してください。"
				: "This adjustment cannot be compared with the current settings. Re-evaluate.",
		);
		expect(screen.queryByRole("figure", { name: allTitle })).toBeNull();
	});

	it("keeps the existing chart title and data name when no override is supplied", () => {
		const { goal } = fixture();
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const name = ja ? "想定出力" : "Simulated output";
		expect(screen.getByRole("figure", { name })).toBeVisible();
		expect(screen.getByRole("img", { name })).toBeVisible();
		expect(
			screen.getByRole("table", {
				name: ja ? "想定出力（データ）" : "Simulated output (data)",
			}),
		).toBeInTheDocument();
	});
});
