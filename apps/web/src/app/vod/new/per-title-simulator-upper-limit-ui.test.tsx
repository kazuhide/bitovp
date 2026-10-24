import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import { analyzePerTitleSettings } from "./per-title-simulator-analysis";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

const mixed = (maximum = 6_000_000): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: maximum,
	minBitrateStepSize: 1.6,
	maxBitrateStepSize: 5,
	countPolicy: { kind: "exact", count: 6 },
	autoRepresentations: false,
	targetQualityCrf: 19,
	complexityFactor: 1,
	resolutionScaleFactor: 0,
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 1,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
	rows: [
		{ id: "first", height: 400, minBitrate: 300_000, maxBitrate: 400_000 },
		{ id: "second", height: 400, minBitrate: 650_000, maxBitrate: 750_000 },
		{ id: "middle", height: 600, minBitrate: 1_200_000, maxBitrate: 1_300_000 },
		{
			id: "highest",
			height: 800,
			minBitrate: 2_050_000,
			maxBitrate: 2_200_000,
		},
	].map((row) => ({
		...row,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 3_000_000,
		highComplexityBoundaryForMaxBitrate: 3_800_000,
	})),
	automaticTemplates: [
		{ id: "bottom", height: 200 },
		{ id: "upper-a", height: 1000 },
		{ id: "upper-b", height: 1200 },
	],
});

const api = () =>
	JSON.parse(screen.getByTestId("per-title-api-settings").textContent ?? "{}");

describe("live upper-output requirement", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows the current error while offering a safe repair (%s)", (locale) => {
		const initial = mixed();
		const current = tunePerTitleSettings(initial, initial);
		const finding = assessPerTitleUpperLimit(
			current.goal,
			current.proposal,
		).finding;
		if (!finding)
			throw new Error("Expected a real upper-output requirement conflict.");
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={initial}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const evaluate = screen.getByRole("button", {
			name: locale === "ja" ? "評価する" : "Evaluate",
		});
		const review = screen.getByRole("button", {
			name: locale === "ja" ? "差分を確認" : "Review changes",
		});
		const evaluation = screen.getByRole("region", {
			name: locale === "ja" ? "現在の設定を評価" : "Evaluate current settings",
		});
		expect(within(evaluation).getByRole("alert")).toHaveTextContent(
			finding.message[locale],
		);
		expect(evaluate).toBeEnabled();
		expect(review).toBeDisabled();
		fireEvent.click(review);
		expect(onApply).not.toHaveBeenCalled();
		const before = api();
		fireEvent.change(
			screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
			{ target: { value: "adaptive" } },
		);
		fireEvent.click(evaluate);
		const offered = analyzePerTitleSettings(current.goal, "adaptive").advice[0];
		if (!offered) throw new Error("Expected a checked structural repair.");
		expect(
			assessPerTitleUpperLimit(offered.goal, offered.proposal).status,
		).toBe("satisfied");
		expect(
			screen.getByRole("region", {
				name: locale === "ja" ? "調整案" : "Suggested adjustment",
			}),
		).toBeVisible();
		expect(within(evaluation).getByRole("alert")).toHaveTextContent(
			finding.message[locale],
		);
		expect(api()).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "この調整を採用" : "Use this adjustment",
			}),
		);
		expect(api()).toEqual(offered.proposal.api);
		expect(within(evaluation).queryByRole("alert")).toBeNull();
		expect(onApply).not.toHaveBeenCalled();
		expect(offered.proof).toBe("conditional-settings");
		expect(offered.proposal.countGuarantee).toBe(false);
	});

	it.each([
		"en",
		"ja",
	] as const)("updates the error and Apply gate from live edits without evaluation (%s)", (locale) => {
		const initial = mixed(4_000_000);
		const current = tunePerTitleSettings(initial, initial);
		expect(current.proposal).toMatchObject({
			status: "candidate",
			applicable: true,
			countGuarantee: false,
		});
		expect(
			assessPerTitleUpperLimit(current.goal, current.proposal).finding,
		).toBeNull();
		const onApply = vi.fn();
		renderLocalized(
			<PerTitleSimulator
				initialGoal={initial}
				open
				onOpenChange={vi.fn()}
				onApply={onApply}
			/>,
			locale,
		);
		const review = screen.getByRole("button", {
			name: locale === "ja" ? "差分を確認" : "Review changes",
		});
		const evaluation = screen.getByRole("region", {
			name: locale === "ja" ? "現在の設定を評価" : "Evaluate current settings",
		});
		const maximum = screen.getByRole("spinbutton", {
			name:
				locale === "ja" ? "最大ビットレート (kbps)" : "Maximum bitrate (kbps)",
		});
		expect(review).toBeEnabled();
		expect(within(evaluation).queryByRole("alert")).toBeNull();
		fireEvent.change(maximum, { target: { value: "6000" } });
		expect(within(evaluation).getByRole("alert")).toBeVisible();
		expect(review).toBeDisabled();
		fireEvent.click(review);
		expect(onApply).not.toHaveBeenCalled();
		fireEvent.change(maximum, { target: { value: "4000" } });
		expect(within(evaluation).queryByRole("alert")).toBeNull();
		expect(review).toBeEnabled();
		expect(
			screen.getByRole("button", {
				name: locale === "ja" ? "評価する" : "Evaluate",
			}),
		).toBeEnabled();
		expect(onApply).not.toHaveBeenCalled();
	});
});
