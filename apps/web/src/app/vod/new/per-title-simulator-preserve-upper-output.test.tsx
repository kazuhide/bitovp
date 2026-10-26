import {
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
} from "./per-title-simulator-advice";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { PerTitleOutputChart } from "./per-title-simulator-output";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

function mixedGoal(): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec: "H264",
		minBitrate: 155_000,
		maxBitrate: 4_800_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 3.9,
		countPolicy: { kind: "exact", count: 6 },
		autoRepresentations: false,
		rows: [
			{ id: "fixed-a", height: 160, minBitrate: 350_000, maxBitrate: 550_000 },
			{
				id: "fixed-b",
				height: 320,
				minBitrate: 760_000,
				maxBitrate: 1_140_000,
			},
			{
				id: "fixed-c",
				height: 640,
				minBitrate: 1_550_000,
				maxBitrate: 2_100_000,
			},
			{
				id: "fixed-d",
				height: 960,
				minBitrate: 2_200_000,
				maxBitrate: 3_000_000,
			},
		].map((row) => ({
			...row,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 3_600_000,
			highComplexityBoundaryForMaxBitrate: 4_800_000,
		})),
		automaticTemplates: [
			{ id: "lower", height: 80 },
			{ id: "upper-a", height: 1280 },
			{ id: "upper-b", height: 1600 },
		],
		fixedResolutionAndBitrateConfiguration: {
			forcedRenditionAboveHighestFixedRepresentation: 1,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.3,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"LAST_CALCULATED_BITRATE",
		},
	};
}

function expectSixRoleChart(
	proposal: PerTitleProposal,
	goal: PerTitleGoal,
	locale: "en" | "ja",
	title: string,
	axisMaximum: number,
) {
	const preview = previewPerTitleOutput(proposal, {
		countPolicy: goal.countPolicy,
		analysisInput: goal.maxBitrate,
	});
	const chart = screen.getByRole("img", { name: title });
	const visual = within(chart).getAllByTestId("per-title-output-row");
	const data = within(
		screen.getByRole("table", {
			name: locale === "ja" ? `${title}（データ）` : `${title} (data)`,
		}),
	)
		.getAllByRole("row")
		.slice(1);
	expect(visual).toHaveLength(6);
	expect(data).toHaveLength(6);
	expect(preview.rows).toHaveLength(6);
	expect(preview.rows.filter((row) => row.kind === "fixed")).toHaveLength(4);
	expect(preview.rows.filter((row) => row.basis === "minimum")).toHaveLength(1);
	expect(proposal.countGuarantee).toBe(false);
	const upperIds = ["upper-a", "upper-b"];
	const choices = preview.rows.filter((row) =>
		row.candidateRowIds?.some((id) => upperIds.includes(id)),
	);
	expect(choices).toHaveLength(1);
	expect(choices[0]?.candidateRowIds?.toSorted()).toEqual(upperIds);
	expect(
		preview.rows.filter((row) => row.rowId && upperIds.includes(row.rowId)),
	).toHaveLength(0);
	expect(
		proposal.api.streams
			.filter((row) => upperIds.includes(row.rowId))
			.map(({ rowId, height, mode }) => ({ rowId, height, mode })),
	).toEqual([
		{ rowId: "upper-a", height: 1280, mode: "PER_TITLE_TEMPLATE" },
		{ rowId: "upper-b", height: 1600, mode: "PER_TITLE_TEMPLATE" },
	]);
	const sorted = preview.rows
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) =>
				(a.row.height ?? Infinity) - (b.row.height ?? Infinity) ||
				a.index - b.index,
		);
	const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const position = (bitrate: number) =>
		(100 * Math.log(bitrate / goal.minBitrate)) /
		Math.log(axisMaximum / goal.minBitrate);
	for (const [index, { row }] of sorted.entries()) {
		const element = visual[index];
		const accessible = data[index];
		if (!element || !accessible) throw new Error("Missing output role row.");
		if (row.minimumBitrate !== undefined && row.maximumBitrate !== undefined) {
			const minimum = number.format(row.minimumBitrate / 1000);
			const maximum = number.format(row.maximumBitrate / 1000);
			expect(element).toHaveTextContent(minimum);
			expect(element).toHaveTextContent(maximum);
			expect(accessible).toHaveTextContent(minimum);
			expect(accessible).toHaveTextContent(maximum);
			const band = within(element).getByTestId("per-title-output-band");
			expect(Number(band.getAttribute("x1"))).toBeCloseTo(
				position(row.minimumBitrate),
				8,
			);
			expect(Number(band.getAttribute("x2"))).toBeCloseTo(
				position(row.maximumBitrate),
				8,
			);
		}
	}
	return preview;
}

const readApi = () =>
	JSON.parse(
		screen.getByTestId("per-title-api-settings").textContent ?? "null",
	);

function evaluatePreserve(goal: PerTitleGoal, locale: "en" | "ja") {
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
	fireEvent.change(
		screen.getByRole("combobox", { name: locale === "ja" ? "目的" : "Goal" }),
		{ target: { value: "preserve" } },
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: locale === "ja" ? "評価する" : "Evaluate",
		}),
	);
	return onApply;
}

describe("preserve evaluation and one upper output role", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps ordinary upper choices in one role before any adjustment (%s)", (locale) => {
		const goal = mixedGoal();
		const before = structuredClone(goal);
		const proposal = tunePerTitleSettings(goal, goal).proposal;
		const title = locale === "ja" ? "想定出力" : "Simulated output";
		renderLocalized(
			<PerTitleOutputChart
				proposal={proposal}
				countPolicy={goal.countPolicy}
				analysisInput={goal.maxBitrate}
			/>,
			locale,
		);
		expectSixRoleChart(proposal, goal, locale, title, goal.maxBitrate);
		expect(goal).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("compares six roles with one normal-or-forced upper choice (%s)", (locale) => {
		const goal = mixedGoal();
		const before = structuredClone(goal);
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("preserve"),
		};
		const advice = analyzePerTitleSettings(goal, "preserve", options).advice[0];
		if (!advice) throw new Error("Expected a configuration adjustment.");
		const onApply = evaluatePreserve(goal, locale);
		expect(readApi()).toEqual(tunePerTitleSettings(goal, goal).proposal.api);
		expectSixRoleChart(
			advice.proposal,
			goal,
			locale,
			locale === "ja" ? "すべて反映した場合" : "After applying all changes",
			goal.maxBitrate,
		);
		expect(goal).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
	});
	it.each([
		"en",
		"ja",
	] as const)("adopts the emitted API and retains six visual and accessible roles (%s)", (locale) => {
		const goal = mixedGoal();
		const before = structuredClone(goal);
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("preserve"),
		};
		const advice = analyzePerTitleSettings(goal, "preserve", options).advice[0];
		if (!advice) throw new Error("Expected a configuration adjustment.");
		const selected = advice.changes.map(({ scope, key, rowId }) => ({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
		}));
		const adopted = applyPerTitleAdvice(goal, advice, options);
		const selectedGoal = applySelectedPerTitleAdvice(
			goal,
			advice,
			selected,
			options,
		);
		if (!adopted || !selectedGoal)
			throw new Error("Expected both adoption paths.");
		const emitted = tunePerTitleSettings(adopted, goal).proposal;
		expect(emitted.api).toEqual(advice.proposal.api);
		expect(tunePerTitleSettings(selectedGoal, goal).proposal.api).toEqual(
			emitted.api,
		);
		expect(adopted.countPolicy).toEqual({ kind: "exact", count: 6 });
		const onApply = evaluatePreserve(goal, locale);
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "この調整を採用" : "Use this adjustment",
			}),
		);
		expect(readApi()).toEqual(emitted.api);
		expectSixRoleChart(
			emitted,
			adopted,
			locale,
			locale === "ja" ? "想定出力" : "Simulated output",
			goal.maxBitrate * 4,
		);
		expect(goal).toEqual(before);
		expect(onApply).not.toHaveBeenCalled();
	});
});
