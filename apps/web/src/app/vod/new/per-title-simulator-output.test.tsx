import {
	type PerTitleOutputPreview,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleOutputChart } from "./per-title-simulator-output";

vi.mock("@bitovp/core", async (original) => ({
	...(await original<typeof import("@bitovp/core")>()),
	previewPerTitleOutput: vi.fn(),
}));

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
			maxBitrate: 2000000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 2,
		},
		streams: [],
	},
	scenarios: [],
	diagnostics: [],
};

const preview: PerTitleOutputPreview = {
	analysisInput: 2000000,
	requestedAnalysisInput: 2000000,
	status: "partial",
	unresolvedAdditional: true,
	rows: [
		{
			id: "upper",
			rowId: "upper",
			height: 720,
			kind: "fixed",
			status: "conditional",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			bitrate: 1500000,
			minimumBitrate: 500000,
			maximumBitrate: 1500000,
		},
		{
			id: "candidate",
			rowId: "candidate",
			height: 180,
			kind: "automatic",
			status: "unknown",
			mode: "PER_TITLE_TEMPLATE",
		},
		{
			id: "lower",
			rowId: "lower",
			height: 360,
			kind: "fixed",
			status: "example",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			bitrate: 300000,
		},
		{ id: "anonymous", kind: "unassigned", status: "example", bitrate: 900000 },
		{
			id: "extra",
			kind: "additional",
			status: "conditional",
			bitrate: 1800000,
		},
	],
};

const mixedProposal: PerTitleProposal = {
	...proposal,
	api: {
		global: { ...proposal.api.global, maxBitrate: 7200000 },
		streams: [
			{
				rowId: "fixed",
				height: 640,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: { minBitrate: 800000, maxBitrate: 1200000 },
			},
			{ rowId: "upper-a", height: 960, mode: "PER_TITLE_TEMPLATE" },
			{ rowId: "upper-b", height: 1280, mode: "PER_TITLE_TEMPLATE" },
		],
	},
};

const mixedPreview: PerTitleOutputPreview = {
	analysisInput: 7200000,
	requestedAnalysisInput: 7200000,
	status: "partial",
	unresolvedAdditional: true,
	forcedFallback: {
		baseMinimumBitrate: 800000,
		baseMaximumBitrate: 1200000,
		minimumBitrate: 1000000,
		maximumBitrate: 1500000,
		count: 1,
		factor: 1.25,
	},
	rows: [
		{
			id: "fixed",
			rowId: "fixed",
			height: 640,
			kind: "fixed",
			status: "conditional",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			bitrate: 1200000,
			minimumBitrate: 800000,
			maximumBitrate: 1200000,
		},
		{
			id: "analysis:top",
			kind: "automatic",
			status: "conditional",
			mode: "PER_TITLE_TEMPLATE",
			basis: "analysis",
			bitrate: 7200000,
			minimumBitrate: 7200000,
			maximumBitrate: 7200000,
			candidateRowIds: ["upper-a", "upper-b"],
		},
	],
};

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test fixture");
	return value;
}

beforeEach(() => {
	vi.mocked(previewPerTitleOutput).mockReturnValue(structuredClone(preview));
});

describe("Per-Title output chart", () => {
	it.each([
		[
			"en",
			"Normal calculation (count unresolved)",
			"Assumed 7,200",
			"Candidates 960 / 1,280 px",
			"If fixed is highest: 1,000–1,500 kbps (1 step, ×1.25 each). This factor does not cap normal upper outputs.",
		],
		[
			"ja",
			"通常計算の上位候補（本数未確定）",
			"仮定 7,200",
			"候補 960 / 1,280 px",
			"固定段が最上位なら 1,000–1,500 kbps（1段・各段×1.25）。通常上段の上限ではありません。",
		],
	] as const)("visibly separates the hypothetical normal top from its fixed-highest fallback without adding outputs (%s)", (locale, normal, assumed, candidates, fallback) => {
		const input = structuredClone(mixedProposal);
		const result = structuredClone(mixedPreview);
		const inputSnapshot = structuredClone(input);
		const resultSnapshot = structuredClone(result);
		vi.mocked(previewPerTitleOutput).mockReturnValue(result);
		renderLocalized(<PerTitleOutputChart proposal={input} />, locale);
		const chart = screen.getByRole("img");
		const rows = within(chart).getAllByTestId("per-title-output-row");
		expect(rows).toHaveLength(2);
		const upper = required(rows[1]);
		expect(within(upper).getByText(normal)).toBeVisible();
		expect(within(upper).getByText(assumed)).toBeVisible();
		expect(within(upper).getByText(candidates)).toBeVisible();
		expect(
			within(upper).getByTestId("per-title-output-target"),
		).toHaveAttribute("x2", "100");
		expect(rows[0]).toHaveTextContent(
			locale === "en" ? "Configured 800–1,200" : "設定範囲 800–1,200",
		);
		const explanation = screen.getByText(fallback);
		expect(explanation).toBeVisible();
		expect(explanation.closest(".sr-only")).toBeNull();
		expect(chart).toHaveAccessibleDescription(
			expect.stringContaining(fallback),
		);
		expect(
			screen.getByText(
				locale === "en" ? "Additional outputs unknown" : "追加出力は未確定",
			),
		).toBeVisible();
		expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
			3,
		);
		expect(
			within(chart).queryByText(
				locale === "en" ? "Candidate 960 px" : "候補 960 px",
			),
		).toBeNull();
		expect(
			within(chart).queryByText(
				locale === "en" ? "Candidate 1280 px" : "候補 1280 px",
			),
		).toBeNull();
		expect(input).toEqual(inputSnapshot);
		expect(result).toEqual(resultSnapshot);
	});

	it("does not invent a fixed-highest fallback when the model provides none", () => {
		const { forcedFallback: _fallback, ...result } =
			structuredClone(mixedPreview);
		vi.mocked(previewPerTitleOutput).mockReturnValue(result);
		renderLocalized(<PerTitleOutputChart proposal={mixedProposal} />);
		expect(screen.getByRole("img")).toHaveTextContent(
			"Normal calculation (count unresolved)",
		);
		expect(screen.queryByText(/If fixed is highest:/)).toBeNull();
	});

	it("formats a single fallback point without presenting an extra rendition", () => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...mixedPreview,
			forcedFallback: {
				...required(mixedPreview.forcedFallback),
				minimumBitrate: 1500000,
				maximumBitrate: 1500000,
			},
		});
		renderLocalized(<PerTitleOutputChart proposal={mixedProposal} />);
		expect(
			screen.getByText(
				"If fixed is highest: 1,500 kbps (1 step, ×1.25 each). This factor does not cap normal upper outputs.",
			),
		).toBeVisible();
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(2);
	});

	it.each([
		[
			"en",
			"If fixed is highest: 450 kbps (2 steps, ×1.5 each). This factor does not cap normal upper outputs.",
		],
		[
			"ja",
			"固定段が最上位なら 450 kbps（2段・各段×1.5）。通常上段の上限ではありません。",
		],
	] as const)("explains a multi-step fallback without inferring total rendition count (%s)", (locale, explanation) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...mixedPreview,
			forcedFallback: {
				baseMinimumBitrate: 200000,
				baseMaximumBitrate: 200000,
				minimumBitrate: 450000,
				maximumBitrate: 450000,
				count: 2,
				factor: 1.5,
			},
		});
		renderLocalized(<PerTitleOutputChart proposal={mixedProposal} />, locale);
		const note = screen.getByTestId("per-title-forced-fallback");
		expect(note).toBeVisible();
		expect(note).toHaveTextContent(explanation);
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(2);
		expect(
			screen.getByText(
				locale === "en" ? "Additional outputs unknown" : "追加出力は未確定",
			),
		).toBeVisible();
	});

	it.each([
		"en",
		"ja",
	] as const)("warns about an above-cap fallback without clipping it or changing normal output (%s)", (locale) => {
		const input: PerTitleProposal = {
			...mixedProposal,
			api: {
				global: {
					...mixedProposal.api.global,
					maxBitrate: 2400000,
					maxBitrateStepSize: 5,
					fixedResolutionAndBitrateConfiguration: {
						forcedRenditionAboveHighestFixedRepresentation: 2,
						forcedRenditionAboveHighestFixedRepresentationFactor: 3,
						forcedRenditionAboveHighestFixedRepresentationCalculationMode:
							"LAST_CALCULATED_BITRATE",
					},
				},
				streams: mixedProposal.api.streams.map((row) =>
					row.rowId === "fixed"
						? {
								...row,
								perTitleSettings: { minBitrate: 600000, maxBitrate: 600000 },
							}
						: row,
				),
			},
		};
		const result: PerTitleOutputPreview = {
			...mixedPreview,
			analysisInput: 2400000,
			requestedAnalysisInput: 2400000,
			rows: mixedPreview.rows.map((row) => ({
				...row,
				bitrate: row.basis === "analysis" ? 2400000 : 600000,
				minimumBitrate: row.basis === "analysis" ? 2400000 : 600000,
				maximumBitrate: row.basis === "analysis" ? 2400000 : 600000,
			})),
			forcedFallback: {
				baseMinimumBitrate: 600000,
				baseMaximumBitrate: 600000,
				minimumBitrate: 5400000,
				maximumBitrate: 5400000,
				count: 2,
				factor: 3,
			},
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue(result);
		const { rerender } = renderLocalized(
			<PerTitleOutputChart proposal={input} />,
			locale,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "en"
				? "Additional value 5,400 kbps exceeds the overall maximum of 2,400 kbps. Lower the additional factor or fixed-rendition maximum."
				: "追加値 5,400 kbps が全体上限 2,400 kbps を超えます。追加倍率か固定段の上限を下げてください。",
		);
		expect(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByTestId("per-title-forced-fallback")).toHaveTextContent(
			locale === "en"
				? "5,400 kbps (2 steps, ×3 each)"
				: "5,400 kbps（2段・各段×3）",
		);
		const rows = screen.getAllByTestId("per-title-output-row");
		expect(rows).toHaveLength(2);
		const normal = required(rows[1]);
		expect(
			within(normal).getByText(
				locale === "en" ? "Assumed 2,400" : "仮定 2,400",
			),
		).toBeVisible();
		expect(
			within(normal).getByTestId("per-title-output-target"),
		).toHaveAttribute("x2", "100");
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...result,
			forcedFallback: {
				...required(result.forcedFallback),
				minimumBitrate: 2400000,
				maximumBitrate: 2400000,
			},
		});
		rerender(<PerTitleOutputChart proposal={input} />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(2);
	});

	it.each([
		["en", "Configured 200–800", "Target 300", "Target 650"],
		["ja", "設定範囲 200–800", "計算点 300", "計算点 650"],
	] as const)("keeps configured bitrate bands fixed as the assumed point changes (%s)", (locale, configured, initialTarget, nextTarget) => {
		const input: PerTitleProposal = {
			...proposal,
			api: {
				...proposal.api,
				streams: [
					{
						rowId: "fixed-a",
						height: 360,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: { minBitrate: 200000, maxBitrate: 800000 },
					},
					{
						rowId: "fixed-b",
						height: 360,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: { minBitrate: 900000, maxBitrate: 1200000 },
					},
					{
						rowId: "candidate",
						height: 720,
						mode: "PER_TITLE_TEMPLATE",
						perTitleSettings: { minBitrate: 333000, maxBitrate: 999000 },
					},
				],
			},
		};
		const snapshot = structuredClone(input);
		const result: PerTitleOutputPreview = {
			...preview,
			rows: [
				{
					id: "fixed-a",
					rowId: "fixed-a",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					kind: "fixed",
					status: "conditional",
					bitrate: 300000,
					minimumBitrate: 300000,
					maximumBitrate: 300000,
				},
				{
					id: "fixed-b",
					rowId: "fixed-b",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					kind: "fixed",
					status: "conditional",
					bitrate: 1100000,
					minimumBitrate: 1100000,
					maximumBitrate: 1100000,
				},
				{
					id: "candidate",
					rowId: "candidate",
					height: 720,
					mode: "PER_TITLE_TEMPLATE",
					kind: "automatic",
					status: "unknown",
				},
			],
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue(result);
		const axis = { minimum: 100000, maximum: 2000000 };
		const { rerender } = renderLocalized(
			<PerTitleOutputChart
				proposal={input}
				axis={axis}
				analysisInput={1000000}
			/>,
			locale,
		);
		const row = required(
			screen
				.getAllByTestId("per-title-output-row")
				.find((item) => item.textContent?.includes(configured)),
		);
		expect(within(row).getByText(configured)).toBeVisible();
		expect(within(row).getByText(initialTarget)).toBeVisible();
		const band = within(row).getByTestId("per-title-output-band");
		const bounds = [band.getAttribute("x1"), band.getAttribute("x2")];
		expect(Number(bounds[0])).toBeLessThan(Number(bounds[1]));
		const endpoint = Number(
			within(row).getByTestId("per-title-output-endpoint").getAttribute("x1"),
		);
		expect(endpoint).toBeGreaterThan(Number(bounds[0]));
		expect(endpoint).toBeLessThan(Number(bounds[1]));
		expect(band).not.toHaveAttribute("stroke-dasharray");
		expect(screen.getByRole("img")).toHaveTextContent(
			locale === "en" ? "Configured 900–1,200" : "設定範囲 900–1,200",
		);
		const candidate = required(
			screen.getAllByTestId("per-title-output-row").at(-1),
		);
		expect(candidate).not.toHaveTextContent("333–999");
		expect(
			within(candidate).queryByTestId("per-title-output-target"),
		).toBeNull();
		expect(
			within(candidate).getByTestId("per-title-output-band"),
		).toHaveAttribute("stroke-dasharray", "4 3");
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...result,
			rows: result.rows.map((item) =>
				item.rowId === "fixed-a"
					? {
							...item,
							bitrate: 650000,
							minimumBitrate: 650000,
							maximumBitrate: 650000,
						}
					: item,
			),
		});
		rerender(
			<PerTitleOutputChart
				proposal={input}
				axis={axis}
				analysisInput={1500000}
			/>,
		);
		expect(within(row).getByText(nextTarget)).toBeVisible();
		expect([band.getAttribute("x1"), band.getAttribute("x2")]).toEqual(bounds);
		expect(
			Number(
				within(row).getByTestId("per-title-output-endpoint").getAttribute("x1"),
			),
		).toBeGreaterThan(endpoint);
		expect(screen.getByRole("table")).toHaveTextContent(`${configured}`);
		expect(screen.getByRole("table")).toHaveTextContent(nextTarget);
		expect(input).toEqual(snapshot);
	});

	it.each([
		["en", "Configured 200–800", "Target 484", "Effective interval 250–484"],
		["ja", "設定範囲 200–800", "計算点 484", "有効範囲 250–484"],
	] as const)("keeps the effective interval separate from configured bitrate bands (%s)", (locale, configured, target, effective) => {
		const input: PerTitleProposal = {
			...proposal,
			api: {
				...proposal.api,
				streams: [
					{
						rowId: "fixed",
						height: 360,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: { minBitrate: 200000, maxBitrate: 800000 },
					},
				],
			},
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [
				{
					id: "fixed",
					rowId: "fixed",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					kind: "fixed",
					status: "conditional",
					bitrate: 484000,
					minimumBitrate: 250000,
					maximumBitrate: 484000,
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={input} />, locale);
		const row = screen.getByTestId("per-title-output-row");
		expect(within(row).getByText(configured)).toBeVisible();
		expect(within(row).getByText(target)).toHaveAttribute("title", effective);
		expect(screen.getByRole("table")).toHaveTextContent(effective);
	});

	it("shows a configured band for an unknown fixed-range row without inventing a point", () => {
		const input: PerTitleProposal = {
			...proposal,
			api: {
				...proposal.api,
				streams: [
					{
						rowId: "fixed",
						height: 360,
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
						perTitleSettings: { minBitrate: 200000, maxBitrate: 800000 },
					},
				],
			},
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [
				{
					id: "fixed",
					rowId: "fixed",
					height: 360,
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					kind: "fixed",
					status: "unknown",
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={input} />);
		const row = screen.getByTestId("per-title-output-row");
		expect(row).toHaveTextContent("Configured 200–800");
		expect(row).toHaveTextContent("Unknown");
		expect(within(row).queryByTestId("per-title-output-endpoint")).toBeNull();
		expect(
			within(row).getByTestId("per-title-output-band"),
		).not.toHaveAttribute("stroke-dasharray");
	});

	it.each([
		[
			"en",
			"Candidates 960 / 1,280 px",
			"Normal calculation (count unresolved)",
		],
		["ja", "候補 960 / 1,280 px", "通常計算の上位候補（本数未確定）"],
	] as const)("groups unresolved upper resolutions under the analysis basis (%s)", (locale, candidates, origin) => {
		const input: PerTitleProposal = {
			...proposal,
			api: {
				...proposal.api,
				streams: [
					{ rowId: "option-a", height: 960, mode: "PER_TITLE_TEMPLATE" },
					{ rowId: "option-b", height: 1280, mode: "PER_TITLE_TEMPLATE" },
				],
			},
		};
		const snapshot = structuredClone(input);
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			analysisInput: 1500000,
			requestedAnalysisInput: 1500000,
			status: "partial",
			unresolvedAdditional: false,
			rows: [
				{
					id: "analysis-top",
					kind: "automatic",
					mode: "PER_TITLE_TEMPLATE",
					status: "conditional",
					basis: "analysis",
					candidateRowIds: ["option-a", "option-b"],
					bitrate: 1500000,
				},
			],
		});
		renderLocalized(
			<PerTitleOutputChart proposal={input} analysisInput={1500000} />,
			locale,
		);
		const row = screen.getByTestId("per-title-output-row");
		expect(row).toHaveTextContent(candidates);
		expect(within(row).getByText(origin)).toBeVisible();
		expect(row).toHaveTextContent("1,500");
		expect(within(row).getByTestId("per-title-output-target")).toHaveAttribute(
			"stroke-dasharray",
			"3 2",
		);
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(1);
		expect(
			screen.queryByText(
				locale === "en"
					? "Additional (if fixed is highest)"
					: "固定レンディションが最上位の場合に追加",
			),
		).toBeNull();
		expect(screen.queryByText("960 px", { exact: true })).toBeNull();
		expect(previewPerTitleOutput).toHaveBeenCalledWith(input, {
			analysisInput: 1500000,
		});
		expect(input).toEqual(snapshot);
	});

	it.each([
		["en", "Capped top: 2,000 kbps (assumed 3,000)"],
		["ja", "上限適用後 2,000 kbps（仮定値 3,000）"],
	] as const)("distinguishes the requested analysis input from its capped value (%s)", (locale, caption) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			requestedAnalysisInput: 3000000,
		});
		renderLocalized(
			<PerTitleOutputChart proposal={proposal} analysisInput={3000000} />,
			locale,
		);
		expect(screen.getByText(caption)).toBeVisible();
	});

	it.each([
		[
			"en",
			"Simulated output",
			"Candidate 180 px",
			"Upper input assumed at 2,000 kbps",
			"Conditional",
			"Resolution unknown",
		],
		[
			"ja",
			"想定出力",
			"候補 180 px",
			"解析値を 2,000 kbps と仮定",
			"条件付き",
			"解像度未確定",
		],
	] as const)("distinguishes examples, conditional targets and automatic candidates (%s)", (locale, title, candidate, input, conditional, unknownHeight) => {
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const figure = screen.getByRole("figure", { name: title });
		expect(figure).toBeVisible();
		expect(screen.getByText(input)).toBeVisible();
		const chart = screen.getByRole("img", { name: title });
		expect(chart).toHaveAccessibleDescription(/kbps/);
		expect(within(chart).getByText(candidate)).toBeVisible();
		expect(within(chart).getByText("PER_TITLE_TEMPLATE")).toBeVisible();
		const rows = within(chart).getAllByTestId("per-title-output-row");
		expect(rows[0]).toHaveTextContent(candidate);
		expect(rows[1]).toHaveTextContent("360 px");
		expect(rows[2]).toHaveTextContent("720 px");
		expect(rows[3]).toHaveTextContent(unknownHeight);
		expect(within(required(rows[2])).getByText(conditional)).toBeVisible();
		expect(rows[2]).toHaveTextContent("500–1,500");
		expect(rows[2]).toHaveTextContent(
			locale === "en" ? "Upper target 1,500" : "上限の目安 1,500",
		);
		expect(
			within(required(rows[0])).getByTestId("per-title-output-band"),
		).toHaveAttribute("stroke-dasharray", "4 3");
		expect(
			within(required(rows[0])).queryByTestId("per-title-output-target"),
		).toBeNull();
		expect(
			within(required(rows[1])).getByTestId("per-title-output-target"),
		).not.toHaveAttribute("stroke-dasharray");
		expect(
			within(required(rows[2])).getByTestId("per-title-output-target"),
		).toHaveAttribute("stroke-dasharray", "3 2");
		expect(
			within(required(rows[2])).getByTestId("per-title-output-target"),
		).toHaveAttribute("x1", "0");
		expect(
			Number(
				within(required(rows[2]))
					.getByTestId("per-title-output-target")
					.getAttribute("x2"),
			),
		).toBeGreaterThan(0);
		expect(screen.queryByRole("status")).toBeNull();
		const table = screen.getByRole("table", {
			name: locale === "en" ? "Simulated output (data)" : "想定出力（データ）",
		});
		expect(table).toHaveTextContent("500–1,500");
		expect(table).not.toHaveClass("sr-only");
		expect(table.parentElement).toHaveClass("sr-only");
		expect(previewPerTitleOutput).toHaveBeenCalledWith(proposal);
	});

	it("does not present unknown automatic candidate metadata as numeric output", () => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [
				{
					...required(preview.rows[1]),
					status: "unknown",
					bitrate: 700000,
					minimumBitrate: 200000,
					maximumBitrate: 800000,
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />);
		const row = screen.getByTestId("per-title-output-row");
		expect(row).toHaveTextContent("Unknown");
		expect(within(row).queryByTestId("per-title-output-target")).toBeNull();
		expect(row).not.toHaveTextContent("200–800");
		expect(row).not.toHaveTextContent("700");
	});

	it.each([
		[
			"en",
			"Start",
			"Additional (if fixed is highest)",
			"Conditional",
			"Unknown",
		],
		[
			"ja",
			"開始",
			"固定レンディションが最上位の場合に追加",
			"条件付き",
			"未確定",
		],
	] as const)("shows conditional automatic starts and additions separately from unknown candidates (%s)", (locale, start, forced, conditional, unknown) => {
		const rows: PerTitleOutputPreview["rows"] = [
			{
				id: "start",
				rowId: "start",
				height: 180,
				kind: "automatic",
				status: "conditional",
				mode: "PER_TITLE_TEMPLATE",
				basis: "minimum",
				bitrate: 100000,
			},
			{
				id: "pending",
				rowId: "pending",
				height: 720,
				kind: "automatic",
				status: "unknown",
				mode: "PER_TITLE_TEMPLATE",
			},
			{
				id: "forced-first",
				rowId: "pending",
				height: 1080,
				kind: "automatic",
				status: "conditional",
				mode: "PER_TITLE_TEMPLATE",
				basis: "forced",
				bitrate: 1800000,
			},
			{
				id: "forced-next",
				rowId: "pending",
				height: 1080,
				kind: "additional",
				status: "conditional",
				mode: "PER_TITLE_TEMPLATE",
				basis: "forced",
				bitrate: 1980000,
			},
		];
		const snapshot = structuredClone(rows);
		vi.mocked(previewPerTitleOutput).mockReturnValue({ ...preview, rows });
		renderLocalized(
			<PerTitleOutputChart
				proposal={proposal}
				axis={{ minimum: 100000, maximum: 8000000 }}
			/>,
			locale,
		);
		const visibleRows = screen.getAllByTestId("per-title-output-row");
		expect(visibleRows).toHaveLength(4);
		expect(screen.getByRole("img")).toHaveAccessibleDescription(
			locale === "en"
				? /source analysis may change resolutions.*fixed rendition is highest/
				: /素材解析で解像度が変わる場合があります.*固定レンディションが最上位の場合/,
		);
		expect(within(required(visibleRows[0])).getByText(start)).toBeVisible();
		expect(visibleRows[0]).toHaveTextContent("100");
		expect(
			within(required(visibleRows[0])).getByText(conditional),
		).toBeVisible();
		expect(
			within(required(visibleRows[0])).getByTestId("per-title-output-target"),
		).toHaveAttribute("stroke-dasharray", "3 2");
		expect(
			within(required(visibleRows[0])).getByTestId("per-title-output-endpoint"),
		).toHaveAttribute("x1", "0");
		expect(
			within(required(visibleRows[0])).getByTestId("per-title-output-endpoint"),
		).toHaveAttribute("y1", "2");
		expect(
			within(required(visibleRows[0])).getByTestId("per-title-output-endpoint"),
		).toHaveAttribute("y2", "10");
		expect(visibleRows[1]).toHaveTextContent(unknown);
		expect(
			within(required(visibleRows[1])).queryByTestId("per-title-output-target"),
		).toBeNull();
		for (const [index, value] of [
			[2, "1,800"],
			[3, "1,980"],
		] as const) {
			const row = required(visibleRows[index]);
			expect(within(row).getByText(forced)).toBeVisible();
			expect(row).toHaveTextContent(value);
			expect(row).toHaveTextContent(
				locale === "en" ? "Candidate 1080 px" : "候補 1080 px",
			);
			expect(within(row).getByText("PER_TITLE_TEMPLATE")).toBeVisible();
			expect(
				within(row).getByTestId("per-title-output-target"),
			).toHaveAttribute("stroke-dasharray", "3 2");
		}
		expect(
			screen.queryByText(
				locale === "en" ? "Additional outputs unknown" : "追加出力は未確定",
			),
		).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect(rows).toEqual(snapshot);
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps the unknown-additions footer when no forced value can be calculated (%s)", (locale) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [
				{
					...required(preview.rows[1]),
					basis: "forced",
					status: "unknown",
					bitrate: 700000,
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		expect(
			screen.getByText(
				locale === "en" ? "Additional outputs unknown" : "追加出力は未確定",
			),
		).toBeVisible();
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
	});

	it("keeps anonymous model points separate without assigning API candidate resolutions", () => {
		renderLocalized(<PerTitleOutputChart proposal={proposal} />);
		const row = required(screen.getAllByTestId("per-title-output-row")[3]);
		expect(row).toHaveTextContent("Resolution unknown");
		expect(row).toHaveTextContent("900");
		expect(row).not.toHaveTextContent(/180 px|360 px|720 px/);
	});

	it.each([
		"en",
		"ja",
	] as const)("warns when a conditional addition exceeds the global cap inside the display axis (%s)", (locale) => {
		const row: PerTitleOutputPreview["rows"][number] = {
			id: "forced",
			rowId: "candidate",
			height: 1080,
			kind: "automatic",
			mode: "PER_TITLE_TEMPLATE",
			status: "conditional",
			basis: "forced",
			bitrate: 3000000,
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [row],
		});
		const input = structuredClone(proposal);
		const snapshot = structuredClone(input);
		const axis = { minimum: 100000, maximum: 8000000 };
		const { rerender } = renderLocalized(
			<PerTitleOutputChart proposal={input} axis={axis} />,
			locale,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			locale === "en"
				? "Additional value 3,000 kbps exceeds the overall maximum of 2,000 kbps. Lower the additional factor or fixed-rendition maximum."
				: "追加値 3,000 kbps が全体上限 2,000 kbps を超えます。追加倍率か固定段の上限を下げてください。",
		);
		expect(screen.getByRole("alert")).toBeVisible();
		const visible = screen.getByTestId("per-title-output-row");
		expect(within(visible).getByText("3,000")).toBeVisible();
		expect(visible).toHaveTextContent(
			locale === "en" ? "Conditional" : "条件付き",
		);
		expect(
			screen.queryByText(locale === "en" ? /Outside scale/ : /目盛りの範囲外/),
		).toBeNull();
		const position = Number(
			screen.getByTestId("per-title-output-target").getAttribute("x2"),
		);
		expect(position).toBeGreaterThan(0);
		expect(position).toBeLessThan(100);
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [{ ...row, bitrate: 2000000 }],
		});
		rerender(<PerTitleOutputChart proposal={input} axis={axis} />);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			Number(screen.getByTestId("per-title-output-target").getAttribute("x2")),
		).toBeLessThan(position);
		expect(input).toEqual(snapshot);
	});

	it("limits an unknown candidate envelope to actual global bounds on the fixed display axis", () => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [required(preview.rows[1])],
		});
		const axis = { minimum: 100000, maximum: 16000000 };
		const { rerender } = renderLocalized(
			<PerTitleOutputChart proposal={proposal} axis={axis} />,
		);
		const ticks = screen.getByTestId("per-title-output-axis").textContent;
		const before = Number(
			screen.getByTestId("per-title-output-band").getAttribute("x2"),
		);
		expect(before).toBeLessThan(100);
		rerender(
			<PerTitleOutputChart
				proposal={{
					...proposal,
					api: {
						...proposal.api,
						global: { ...proposal.api.global, maxBitrate: 4000000 },
					},
				}}
				axis={axis}
			/>,
		);
		const after = Number(
			screen.getByTestId("per-title-output-band").getAttribute("x2"),
		);
		expect(after).toBeGreaterThan(before);
		expect(after).toBeLessThan(100);
		expect(screen.getByTestId("per-title-output-axis").textContent).toBe(ticks);
		expect(screen.getByTestId("per-title-output-row")).toHaveTextContent(
			"Unknown",
		);
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
	});

	it("withholds an unknown candidate envelope when actual global limits are invalid", () => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			rows: [required(preview.rows[1])],
		});
		renderLocalized(
			<PerTitleOutputChart
				proposal={{
					...proposal,
					api: {
						...proposal.api,
						global: { ...proposal.api.global, minBitrate: Number.NaN },
					},
				}}
				axis={{ minimum: 100000, maximum: 16000000 }}
			/>,
		);
		expect(screen.getByTestId("per-title-output-row")).toHaveTextContent(
			"Unknown",
		);
		expect(screen.queryByTestId("per-title-output-band")).toBeNull();
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
	});

	it("keeps the explicit log axis fixed and clips only geometry, never numeric output", () => {
		const axis = { minimum: 200000, maximum: 1000000 };
		const input = structuredClone(proposal);
		const snapshot = structuredClone(input);
		const { rerender } = renderLocalized(
			<PerTitleOutputChart proposal={input} axis={axis} />,
		);
		const ticks = screen.getByTestId("per-title-output-axis").textContent;
		const upper = required(screen.getAllByTestId("per-title-output-row")[2]);
		expect(upper).toHaveTextContent("500–1,500");
		expect(upper).toHaveTextContent("Outside scale →");
		expect(
			within(upper).getByTestId("per-title-output-target"),
		).toHaveAttribute("x2", "100");
		const lower = required(screen.getAllByTestId("per-title-output-row")[1]);
		const before = Number(
			within(lower).getByTestId("per-title-output-target").getAttribute("x2"),
		);
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...preview,
			analysisInput: 4000000,
			rows: preview.rows.map((row) =>
				row.id === "lower" ? { ...row, bitrate: 600000 } : row,
			),
		});
		rerender(
			<PerTitleOutputChart
				proposal={{
					...input,
					api: {
						...input.api,
						global: { ...input.api.global, maxBitrate: 4000000 },
					},
				}}
				axis={axis}
			/>,
		);
		expect(screen.getByTestId("per-title-output-axis").textContent).toBe(ticks);
		const after = required(screen.getAllByTestId("per-title-output-row")[1]);
		expect(
			Number(
				within(after).getByTestId("per-title-output-target").getAttribute("x2"),
			),
		).toBeGreaterThan(before);
		expect(input).toEqual(snapshot);
	});

	it.each([
		{ minimum: 0, maximum: 1000000 },
		{ minimum: 1000000, maximum: 100000 },
		{ minimum: Number.NaN, maximum: Number.POSITIVE_INFINITY },
	])("withholds invalid explicit axis geometry %j", (axis) => {
		const { container } = renderLocalized(
			<PerTitleOutputChart proposal={proposal} axis={axis} />,
		);
		expect(screen.getByText("Output unavailable")).toBeVisible();
		expect(screen.queryByRole("img")).toBeNull();
		expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
	});

	it("never plots unknown or invalid numeric values", () => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			analysisInput: Number.NaN,
			requestedAnalysisInput: Number.NaN,
			status: "partial",
			unresolvedAdditional: false,
			rows: [
				{
					id: "bad",
					height: 360,
					kind: "fixed",
					status: "conditional",
					bitrate: Number.POSITIVE_INFINITY,
					minimumBitrate: 400000,
					maximumBitrate: 100000,
				},
				{
					id: "unknown",
					kind: "unassigned",
					status: "unknown",
					bitrate: 500000,
				},
			],
		});
		const { container } = renderLocalized(
			<PerTitleOutputChart proposal={proposal} />,
		);
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
		expect(screen.getByText("Upper input unavailable")).toBeVisible();
		expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
		for (const line of container.querySelectorAll("line")) {
			for (const key of ["x1", "x2", "y1", "y2"])
				expect(Number.isFinite(Number(line.getAttribute(key)))).toBe(true);
		}
	});

	it("renders real core preview examples as bars, not equal-range ticks or duplicate limits", async () => {
		const actual =
			await vi.importActual<typeof import("@bitovp/core")>("@bitovp/core");
		vi.mocked(previewPerTitleOutput).mockImplementation(
			actual.previewPerTitleOutput,
		);
		const candidate = actual.recommendPerTitleSettings({
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100000,
			maxBitrate: 2400000,
			countPolicy: { kind: "exact", count: 3 },
			rows: [
				{ id: "a", height: 240, minBitrate: 160000, maxBitrate: 200000 },
				{ id: "b", height: 480, minBitrate: 400000, maxBitrate: 480000 },
				{ id: "c", height: 720, minBitrate: 1000000, maxBitrate: 1200000 },
			],
		});
		const before = structuredClone(candidate);
		renderLocalized(<PerTitleOutputChart proposal={candidate} />);
		expect(screen.getByText("Upper input assumed at 2,400 kbps")).toBeVisible();
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(3);
		for (const bar of screen.getAllByTestId("per-title-output-target")) {
			expect(bar).toHaveAttribute("x1", "0");
			expect(Number(bar.getAttribute("x2"))).toBeGreaterThan(0);
			expect(bar).not.toHaveAttribute("stroke-dasharray");
		}
		expect(screen.getAllByTestId("per-title-output-target")).toHaveLength(3);
		expect(screen.getByRole("img")).not.toHaveTextContent(
			/200–200|480–480|1,200–1,200|Unknown/,
		);
		expect(candidate).toEqual(before);
	});
});
