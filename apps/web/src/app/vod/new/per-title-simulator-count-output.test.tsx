import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { PerTitleOutputChart } from "./per-title-simulator-output";

const automaticGoal = (): PerTitleGoal => ({
	strategy: "automatic",
	codec: "H264",
	minBitrate: 128_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "exact", count: 6 },
	autoRepresentations: {},
	automaticTemplates: [{ id: "automatic-template" }],
});

describe("mixed-template output branches", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows the ordinary upper range and its forced fallback as alternatives (%s)", (locale) => {
		const input: PerTitleProposal = {
			id: "baseline",
			codec: "H264",
			status: "unknown",
			applicable: false,
			evidence: "model-only",
			countGuarantee: false,
			scenarios: [],
			diagnostics: [],
			api: {
				global: {
					minBitrate: 100_000,
					maxBitrate: 2_400_000,
					minBitrateStepSize: 1.5,
					maxBitrateStepSize: 4,
					fixedResolutionAndBitrateConfiguration: {
						forcedRenditionAboveHighestFixedRepresentation: 1,
						forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							"LAST_CALCULATED_BITRATE",
					},
				},
				streams: [
					{
						rowId: "fixed",
						height: 640,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: {
							minBitrate: 200_000,
							maxBitrate: 600_000,
							bitrateSelectionMode: "COMPLEXITY_RANGE",
							lowComplexityBoundaryForMaxBitrate: 200_000,
							highComplexityBoundaryForMaxBitrate: 1_200_000,
						},
					},
					{ rowId: "lower", height: 180, mode: "PER_TITLE_TEMPLATE" },
					{ rowId: "upper-a", height: 960, mode: "PER_TITLE_TEMPLATE" },
					{ rowId: "upper-b", height: 1280, mode: "PER_TITLE_TEMPLATE" },
				],
			},
		};
		const before = structuredClone(input);
		renderLocalized(
			<PerTitleOutputChart
				proposal={input}
				countPolicy={{ kind: "exact", count: 3 }}
			/>,
			locale,
		);
		const chart = screen.getByRole("img");
		expect(within(chart).getAllByTestId("per-title-output-row")).toHaveLength(
			3,
		);
		expect(
			within(chart).getByText(
				locale === "en" ? "Assumed range 894–2,400" : "仮定の範囲 894–2,400",
			),
		).toBeVisible();
		const fallback = screen.getByTestId("per-title-forced-fallback");
		expect(fallback).toBeVisible();
		expect(fallback).toHaveTextContent(
			locale === "en"
				? "If fixed is highest: 720 kbps"
				: "固定段が最上位なら 720 kbps",
		);
		expect(chart).not.toContainElement(fallback);
		expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
			4,
		);
		expect(input).toEqual(before);
	});
});

describe("ordinary-template count output integration", () => {
	it.each([
		"en",
		"ja",
	] as const)("renders the requested six ranges in the adoption preview and adopted output (%s)", (locale) => {
		const ja = locale === "ja";
		const goal = automaticGoal();
		const source = structuredClone(goal);
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
		fireEvent.click(
			screen.getByRole("button", { name: ja ? "評価する" : "Evaluate" }),
		);
		const after = screen.getByRole("img", {
			name: ja ? "すべて反映した場合" : "After applying all changes",
		});
		expect(within(after).getAllByTestId("per-title-output-row")).toHaveLength(
			6,
		);
		expect(
			within(
				screen.getByRole("table", {
					name: ja
						? "すべて反映した場合（データ）"
						: "After applying all changes (data)",
				}),
			).getAllByRole("row"),
		).toHaveLength(7);
		fireEvent.click(
			screen.getByRole("button", {
				name: ja ? "この調整を採用" : "Use this adjustment",
			}),
		);
		const output = screen.getByRole("img", {
			name: ja ? "想定出力" : "Simulated output",
		});
		expect(within(output).getAllByTestId("per-title-output-row")).toHaveLength(
			6,
		);
		expect(within(output).queryByTestId("per-title-output-target")).toBeNull();
		expect(
			screen.getByRole("spinbutton", {
				name: ja ? "希望する本数" : "Desired count",
			}),
		).toHaveValue(6);
		const api = JSON.parse(
			screen.getByTestId("per-title-api-settings").textContent ?? "null",
		);
		expect(api.global).toMatchObject({
			minBitrate: 128_000,
			maxBitrate: 4_000_000,
		});
		expect(api.global).not.toHaveProperty("countPolicy");
		expect(goal).toEqual(source);
		expect(onApply).not.toHaveBeenCalled();
	});
});
