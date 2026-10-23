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
			minBitrate: 100_000,
			maxBitrate: 2_000_000,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 1.9,
		},
		streams: [
			{
				rowId: "fixed",
				height: 720,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					minBitrate: 200_000,
					maxBitrate: 1_200_000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 200_000,
					highComplexityBoundaryForMaxBitrate: 1_200_000,
				},
			},
		],
	},
	scenarios: [],
	diagnostics: [],
};

function effectivePreview(): PerTitleOutputPreview {
	return {
		analysisInput: 600_000,
		requestedAnalysisInput: 600_000,
		floor: 200_000,
		complexityInput: 600_000,
		usesAspectRatioAssumption: false,
		status: "partial",
		unresolvedAdditional: false,
		rows: [
			{
				id: "fixed",
				rowId: "fixed",
				height: 720,
				kind: "fixed",
				status: "conditional",
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				rangeBasis: "effective",
				minimumBitrate: 400_000,
				maximumBitrate: 600_000,
			},
		],
	};
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test fixture");
	return value;
}

const copy = {
	en: {
		group: "Automatic range (assumed)",
		assumed: "Assumed range 100–2,000",
		groupHint: "Count and resolutions are determined by content analysis.",
		effective: "Effective interval 400–600",
		configured: "Configured 200–1,200",
		point: "Calculated point 400",
		floor: "Complexity input 150 → 200 kbps (fixed-rendition floor).",
		unknownFloor:
			"The fixed-rendition floor is unresolved; complexity targets are unavailable.",
		aspect: "Height-only templates assume a shared aspect ratio.",
		unresolved: "Additional outputs unknown",
	},
	ja: {
		group: "自動生成の範囲（仮定）",
		assumed: "仮定の範囲 100–2,000",
		groupHint: "本数と解像度は素材解析で決まります。",
		effective: "有効範囲 400–600",
		configured: "設定範囲 200–1,200",
		point: "計算点 400",
		floor: "複雑度の計算値 150 → 200 kbps（固定段の下限を適用）。",
		unknownFloor: "固定段の下限が未確定のため、複雑度に応じた値は未確定です。",
		aspect:
			"高さのみを指定したテンプレートは、共通のアスペクト比を仮定しています。",
		unresolved: "追加出力は未確定",
	},
};

beforeEach(() => {
	vi.mocked(previewPerTitleOutput).mockReturnValue(effectivePreview());
});

describe("Per-Title output evidence", () => {
	it.each([
		["en", 100_000, 1_000_000, false, true],
		["ja", 100_000, 1_000_000, false, true],
		["en", 300_000, 2_000_000, true, false],
		["ja", 300_000, 2_000_000, true, false],
		["en", 300_000, 1_000_000, true, true],
		["ja", 300_000, 1_000_000, true, true],
	] as const)("marks a clipped configured background while the effective interval stays in scale (%s %s %s)", (locale, minimum, maximum, below, above) => {
		renderLocalized(
			<PerTitleOutputChart proposal={proposal} axis={{ minimum, maximum }} />,
			locale,
		);
		const chart = screen.getByRole("img");
		const warning = within(chart).getByText(
			locale === "ja" ? /目盛りの範囲外/ : /Outside scale/,
		);
		expect(warning.textContent?.includes("←")).toBe(below);
		expect(warning.textContent?.includes("→")).toBe(above);
		const band = within(chart).getByTestId("per-title-output-band");
		expect(Number(band.getAttribute("x1"))).toBeGreaterThan(0);
		expect(Number(band.getAttribute("x2"))).toBeLessThan(100);
		expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
	});
	it.each([
		"en",
		"ja",
	] as const)("shows an aggregate automatic band without selecting resolutions or points (%s)", (locale) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...effectivePreview(),
			analysisInput: 2_000_000,
			requestedAnalysisInput: 2_000_000,
			complexityInput: 2_000_000,
			unresolvedAdditional: true,
			rows: [
				{
					id: "automatic-range",
					kind: "automatic-group",
					status: "conditional",
					rangeBasis: "assumed",
					minimumBitrate: 100_000,
					maximumBitrate: 2_000_000,
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const chart = screen.getByRole("img");
		expect(within(chart).getByText(copy[locale].group)).toBeVisible();
		expect(within(chart).getByText(copy[locale].assumed)).toBeVisible();
		expect(screen.getByText(copy[locale].groupHint)).toBeVisible();
		expect(within(chart).getAllByTestId("per-title-output-row")).toHaveLength(
			1,
		);
		expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
		expect(within(chart).queryByText(/720|1080/)).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("makes the effective interval primary without inventing a selected point (%s)", (locale) => {
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const chart = screen.getByRole("img");
		expect(within(chart).getByText(copy[locale].effective)).toBeVisible();
		expect(within(chart).getByText(copy[locale].configured)).toBeVisible();
		const band = within(chart).getByTestId("per-title-output-band");
		expect(Number(band.getAttribute("x1"))).toBeCloseTo(
			(Math.log(4) / Math.log(20)) * 100,
		);
		expect(Number(band.getAttribute("x2"))).toBeCloseTo(
			(Math.log(6) / Math.log(20)) * 100,
		);
		expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
		expect(within(chart).queryByTestId("per-title-output-endpoint")).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("marks a calculation point only when the core supplies one (%s)", (locale) => {
		const preview = effectivePreview();
		preview.rows[0] = { ...required(preview.rows[0]), bitrate: 400_000 };
		vi.mocked(previewPerTitleOutput).mockReturnValue(preview);
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const chart = screen.getByRole("img");
		expect(within(chart).getByText(copy[locale].point)).toBeVisible();
		expect(
			Number(
				within(chart).getByTestId("per-title-output-target").getAttribute("x2"),
			),
		).toBeCloseTo((Math.log(4) / Math.log(20)) * 100);
	});

	it.each([
		"en",
		"ja",
	] as const)("explains a raised complexity input and a height-only assumption (%s)", (locale) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...effectivePreview(),
			analysisInput: 150_000,
			requestedAnalysisInput: 150_000,
			complexityInput: 200_000,
			usesAspectRatioAssumption: true,
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		expect(screen.getByText(copy[locale].floor)).toBeVisible();
		expect(screen.getByText(copy[locale].aspect)).toBeVisible();
	});

	it.each([
		"en",
		"ja",
	] as const)("explains an unresolved floor without fabricating complexity output (%s)", (locale) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...effectivePreview(),
			floor: null,
			complexityInput: null,
			rows: [
				{
					...required(effectivePreview().rows[0]),
					status: "unknown",
					rangeBasis: "configured",
					minimumBitrate: 200_000,
					maximumBitrate: 1_200_000,
				},
			],
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		expect(screen.getByText(copy[locale].unknownFloor)).toBeVisible();
		const chart = screen.getByRole("img");
		expect(within(chart).getByText(copy[locale].configured)).toBeVisible();
		expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("keeps unknown additions visible beside a conditional forced row (%s)", (locale) => {
		const preview = effectivePreview();
		preview.unresolvedAdditional = true;
		preview.rows.push({
			id: "forced",
			kind: "additional",
			status: "conditional",
			basis: "forced",
			bitrate: 720_000,
			minimumBitrate: 720_000,
			maximumBitrate: 720_000,
		});
		vi.mocked(previewPerTitleOutput).mockReturnValue(preview);
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		expect(screen.getByText(copy[locale].unresolved)).toBeVisible();
	});

	it.each([
		"en",
		"ja",
	] as const)("shows a singleton effective band without inventing a selected point (%s)", (locale) => {
		const preview = effectivePreview();
		preview.rows[0] = {
			...required(preview.rows[0]),
			minimumBitrate: 400_000,
			maximumBitrate: 400_000,
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue(preview);
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const chart = screen.getByRole("img");
		const band = within(chart).getByTestId("per-title-output-band");
		expect(band.getAttribute("x1")).toBe(band.getAttribute("x2"));
		expect(band).toHaveAttribute("stroke-linecap", "round");
		expect(within(chart).queryByTestId("per-title-output-target")).toBeNull();
		expect(within(chart).queryByTestId("per-title-output-endpoint")).toBeNull();
	});

	it.each([
		"en",
		"ja",
	] as const)("shows a supplied fallback without requiring an analysis row (%s)", (locale) => {
		vi.mocked(previewPerTitleOutput).mockReturnValue({
			...effectivePreview(),
			forcedFallback: {
				baseMinimumBitrate: 400_000,
				baseMaximumBitrate: 600_000,
				minimumBitrate: 480_000,
				maximumBitrate: 720_000,
				count: 1,
				factor: 1.2,
			},
		});
		renderLocalized(<PerTitleOutputChart proposal={proposal} />, locale);
		const fallback = screen.getByTestId("per-title-forced-fallback");
		expect(fallback).toBeVisible();
		expect(fallback).toHaveTextContent("480–720");
		expect(screen.getAllByTestId("per-title-output-row")).toHaveLength(1);
	});

	it.each([
		"en",
		"ja",
	] as const)("uses a forced interval maximum for overflow and avoids a duplicate fallback (%s)", (locale) => {
		const preview = effectivePreview();
		preview.rows.push({
			id: "forced-range",
			kind: "additional",
			status: "conditional",
			basis: "forced",
			rangeBasis: "effective",
			minimumBitrate: 1_500_000,
			maximumBitrate: 3_000_000,
		});
		preview.forcedFallback = {
			baseMinimumBitrate: 1_000_000,
			baseMaximumBitrate: 2_000_000,
			minimumBitrate: 1_500_000,
			maximumBitrate: 3_000_000,
			count: 1,
			factor: 1.5,
		};
		vi.mocked(previewPerTitleOutput).mockReturnValue(preview);
		renderLocalized(
			<PerTitleOutputChart
				proposal={proposal}
				axis={{ minimum: 100_000, maximum: 8_000_000 }}
			/>,
			locale,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("3,000");
		expect(screen.queryByTestId("per-title-forced-fallback")).toBeNull();
		const rows = screen.getAllByTestId("per-title-output-row");
		const forced = required(rows[1]);
		expect(forced).toHaveTextContent("1,500–3,000");
		expect(within(forced).queryByTestId("per-title-output-target")).toBeNull();
	});

	it("replaces the previous calculation point when the assumed analysis input changes", () => {
		vi.mocked(previewPerTitleOutput).mockImplementation(
			(_proposal, options) => {
				const preview = effectivePreview();
				if (options?.analysisInput === 400_000)
					preview.rows[0] = { ...required(preview.rows[0]), bitrate: 400_000 };
				return preview;
			},
		);
		const { rerender } = renderLocalized(
			<PerTitleOutputChart proposal={proposal} analysisInput={400_000} />,
		);
		expect(screen.getByTestId("per-title-output-target")).toBeInTheDocument();
		rerender(
			<PerTitleOutputChart proposal={proposal} analysisInput={600_000} />,
		);
		expect(previewPerTitleOutput).toHaveBeenLastCalledWith(proposal, {
			analysisInput: 600_000,
		});
		expect(screen.queryByTestId("per-title-output-target")).toBeNull();
		expect(screen.getByRole("img")).toHaveTextContent(copy.en.effective);
	});
});
