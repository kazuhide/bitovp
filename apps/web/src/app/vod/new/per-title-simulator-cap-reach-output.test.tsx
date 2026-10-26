import {
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { buildPerTitleSetup } from "./per-title-guided-setup-model";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	type PerTitleAdviceField,
} from "./per-title-simulator-advice";
import { perTitleAdvicePreview } from "./per-title-simulator-advice-preview-model";
import {
	analyzePerTitleSettings,
	perTitleAnalysisContextKey,
} from "./per-title-simulator-analysis";
import { PerTitleOutputChart } from "./per-title-simulator-output";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

const requirement = {
	strategy: "count",
	codec: "H264",
	minBitrate: 300_000,
	maxBitrate: 4_000_000,
	count: 4,
	rows: [],
} as const;

const intents = ["cap", "bandwidth", "count", "preserve"] as const;
const locales = ["en", "ja"] as const;

function ordinaryGoal(narrow = false): PerTitleGoal {
	return {
		strategy: "count",
		codec: "H264",
		minBitrate: requirement.minBitrate,
		maxBitrate: requirement.maxBitrate,
		minBitrateStepSize: narrow ? 2.128663656502157 : 1.5,
		maxBitrateStepSize: narrow ? 2.1286666666666667 : 6,
		countPolicy: { kind: "exact", count: requirement.count },
		autoRepresentations: {},
		automaticTemplates: [{ id: "automatic-template" }],
	};
}

function expectChartFromEmittedApi(
	proposal: PerTitleProposal,
	countPolicy: PerTitleGoal["countPolicy"],
	locale: "en" | "ja",
) {
	const before = structuredClone(proposal);
	const preview = previewPerTitleOutput(proposal, {
		countPolicy,
		analysisInput: requirement.maxBitrate,
	});
	expect(preview.countProjection).toMatchObject({
		kind: "exact",
		requestedCount: requirement.count,
		status: "conditional",
	});
	expect(preview.rows).toHaveLength(requirement.count);
	const rendered = renderLocalized(
		<PerTitleOutputChart
			proposal={proposal}
			countPolicy={countPolicy}
			analysisInput={requirement.maxBitrate}
		/>,
		locale,
	);
	const chart = screen.getByRole("img");
	const rows = within(chart).getAllByTestId("per-title-output-row");
	const data = within(
		screen.getByRole("table", {
			name: locale === "ja" ? "想定出力（データ）" : "Simulated output (data)",
		}),
	)
		.getAllByRole("row")
		.slice(1);
	expect(rows).toHaveLength(requirement.count);
	expect(data).toHaveLength(requirement.count);
	const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
	const axis = proposal.api.global;
	const position = (value: number) =>
		(100 * Math.log(value / axis.minBitrate)) /
		Math.log(axis.maxBitrate / axis.minBitrate);
	for (const [index, row] of preview.rows.entries()) {
		if (row.minimumBitrate === undefined || row.maximumBitrate === undefined)
			throw new Error("Expected emitted spacing bounds.");
		const visualRow = rows[index];
		const dataRow = data[index];
		if (!visualRow || !dataRow)
			throw new Error("Expected matching visual and accessible rows.");
		const minimum = number.format(row.minimumBitrate / 1000);
		const maximum = number.format(row.maximumBitrate / 1000);
		const range =
			row.minimumBitrate === row.maximumBitrate
				? minimum
				: `${minimum}–${maximum}`;
		expect(visualRow).toHaveTextContent(range);
		expect(dataRow).toHaveTextContent(range);
		const band = within(visualRow).getByTestId("per-title-output-band");
		expect(Number(band.getAttribute("x1"))).toBeCloseTo(
			position(row.minimumBitrate),
			8,
		);
		expect(Number(band.getAttribute("x2"))).toBeCloseTo(
			position(row.maximumBitrate),
			8,
		);
	}
	expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
	expect(proposal).toEqual(before);
	return { preview, rows, data, unmount: rendered.unmount };
}

describe("ordinary count output and overall cap", () => {
	it.each([
		"en",
		"ja",
	] as const)("lets four generated ranges include the requested overall cap after setup and tuning (%s)", (locale) => {
		const result = buildPerTitleSetup(requirement);
		if (!result.goal || !result.proposal)
			throw new Error("Expected a generated setup.");
		expect(result.status).toBe("ready");
		const before = structuredClone(result.goal);
		const tuned = tunePerTitleSettings(result.goal, result.goal);
		expect(tuned.proposal.api).toEqual(result.proposal.api);
		const { preview, rows } = expectChartFromEmittedApi(
			tuned.proposal,
			result.goal.countPolicy,
			locale,
		);
		expect(preview.rows.at(-1)?.maximumBitrate).toBe(requirement.maxBitrate);
		expect(rows.at(-1)).toHaveTextContent("4,000");
		expect(result.goal).toEqual(before);
	});
	it.each([
		"en",
		"ja",
	] as const)("keeps a saved narrow API interval narrow instead of drawing a fabricated cap (%s)", (locale) => {
		const goal = ordinaryGoal(true);
		const before = structuredClone(goal);
		const tuned = tunePerTitleSettings(goal, goal);
		expect(tuned.proposal.api.global).toMatchObject({
			minBitrateStepSize: goal.minBitrateStepSize,
			maxBitrateStepSize: goal.maxBitrateStepSize,
		});
		const { preview, rows } = expectChartFromEmittedApi(
			tuned.proposal,
			goal.countPolicy,
			locale,
		);
		expect(preview.rows.at(-1)).toMatchObject({
			minimumBitrate: 2_893_631,
			maximumBitrate: 2_893_637,
		});
		expect(rows.at(-1)).toHaveTextContent("2,893.631–2,893.637");
		expect(rows.at(-1)).not.toHaveTextContent("4,000");
		expect(goal).toEqual(before);
	});
	it.each(
		intents.flatMap((intent) =>
			locales.flatMap((locale) =>
				(["all", "selected", "keep", "partial"] as const).map((mode) => ({
					intent,
					locale,
					mode,
				})),
			),
		),
	)("uses the actual $mode API in a raw count repair for $intent ($locale)", ({
		intent,
		locale,
		mode,
	}) => {
		const goal = ordinaryGoal();
		const before = structuredClone(goal);
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey(intent),
		};
		const advice = analyzePerTitleSettings(goal, intent, options).advice[0];
		if (!advice) throw new Error("Expected a count-spacing repair.");
		const offered = advice.changes.map(({ scope, key, rowId }) => ({
			scope,
			key,
			...(rowId === undefined ? {} : { rowId }),
		}));
		const minimum = offered.find(
			(field) => field.scope === "global" && field.key === "minBitrateStepSize",
		);
		if (!minimum) throw new Error("Expected a minimum-step repair.");
		const selected: PerTitleAdviceField[] =
			mode === "selected" ? offered : mode === "partial" ? [minimum] : [];
		const kept =
			mode === "keep"
				? offered
				: mode === "partial"
					? offered.filter((field) => field !== minimum)
					: [];
		const comparison = perTitleAdvicePreview(
			goal,
			advice,
			{ selected, kept },
			options,
		);
		const expectedGoal =
			mode === "keep"
				? goal
				: mode === "all"
					? applyPerTitleAdvice(goal, advice, options)
					: applySelectedPerTitleAdvice(goal, advice, selected, options);
		if (!expectedGoal || !comparison.after || !comparison.afterCountPolicy)
			throw new Error("Expected a calculated comparison.");
		expect(comparison.mode).toBe(mode === "partial" ? "selected" : mode);
		expect(comparison.after.api).toEqual(
			tunePerTitleSettings(expectedGoal, goal).proposal.api,
		);
		expect(comparison.afterCountPolicy).toEqual(goal.countPolicy);
		const { preview } = expectChartFromEmittedApi(
			comparison.after,
			comparison.afterCountPolicy,
			locale,
		);
		expect(preview.rows.at(-1)?.maximumBitrate).toBe(requirement.maxBitrate);
		expect(goal).toEqual(before);
	});
	it.each(
		locales,
	)("repairs the saved narrow cap only through an emitted API change (%s)", (locale) => {
		const goal = ordinaryGoal(true);
		const before = structuredClone(goal);
		const options = {
			referenceGoal: goal,
			contextKey: perTitleAnalysisContextKey("cap"),
		};
		const advice = analyzePerTitleSettings(goal, "cap", options).advice[0];
		if (!advice) throw new Error("Expected a cap-permitting spacing proposal.");
		expect(advice.changes).toEqual([
			expect.objectContaining({ scope: "global", key: "maxBitrateStepSize" }),
		]);
		const offered = advice.changes.map(({ scope, key }) => ({ scope, key }));
		for (const choice of [
			{ selected: [], kept: [] },
			{ selected: offered, kept: [] },
			{ selected: [], kept: offered },
		]) {
			const comparison = perTitleAdvicePreview(goal, advice, choice, options);
			if (!comparison.after || !comparison.afterCountPolicy)
				throw new Error("Expected a calculated comparison.");
			const current = previewPerTitleOutput(comparison.current, {
				countPolicy: comparison.currentCountPolicy,
				analysisInput: requirement.maxBitrate,
			});
			expect(current.rows.at(-1)?.maximumBitrate).toBe(2_893_637);
			const { preview, unmount } = expectChartFromEmittedApi(
				comparison.after,
				comparison.afterCountPolicy,
				locale,
			);
			expect(preview.rows.at(-1)?.maximumBitrate).toBe(
				comparison.mode === "keep" ? 2_893_637 : requirement.maxBitrate,
			);
			expect(comparison.after.api.global.minBitrateStepSize).toBe(
				goal.minBitrateStepSize,
			);
			unmount();
		}
		expect(goal).toEqual(before);
	});
	it.each(
		(["bandwidth", "count", "preserve"] as const).flatMap((intent) =>
			locales.map((locale) => ({ intent, locale })),
		),
	)("does not redraw a saved narrow range for the $intent objective ($locale)", ({
		intent,
		locale,
	}) => {
		const goal = ordinaryGoal(true);
		const before = structuredClone(goal);
		const evaluated = analyzePerTitleSettings(goal, intent, {
			referenceGoal: goal,
		});
		expect(evaluated.advice).toEqual([]);
		expect(evaluated.decision.status).toBe(
			intent === "bandwidth" ? "inspect-only" : "keep-current",
		);
		const tuned = tunePerTitleSettings(goal, goal);
		const { preview } = expectChartFromEmittedApi(
			tuned.proposal,
			goal.countPolicy,
			locale,
		);
		expect(preview.rows.at(-1)?.maximumBitrate).toBe(2_893_637);
		expect(goal).toEqual(before);
	});
});
