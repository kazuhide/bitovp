import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleComplexity } from "./per-title-simulator-complexity";
import { PerTitleRecommendation } from "./per-title-simulator-recommendation";

const lowField = "lowComplexityBoundaryForMaxBitrate";
const highField = "highComplexityBoundaryForMaxBitrate";
type Stream = PerTitleProposal["api"]["streams"][number];

function stream(id: string, low = 1_000_000, high = 2_400_000): Stream {
	return {
		rowId: id,
		height: 360,
		mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		perTitleSettings: {
			minBitrate: 160_000,
			maxBitrate: 200_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			[lowField]: low,
			[highField]: high,
		},
	};
}

function proposal(streams = [stream("first")]): PerTitleProposal {
	return {
		id: "step-adjusted",
		codec: "H264",
		status: "unknown",
		applicable: false,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100_000,
				maxBitrate: 2_400_000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 3,
			},
			streams,
		},
		scenarios: [],
		diagnostics: [],
	};
}

describe("Per-Title complexity boundary parameters", () => {
	it.each([
		"en",
		"ja",
	] as const)("shows emitted API values and before/current changes in %s", (locale) => {
		const baseline = proposal([stream("first", 800_000, 2_000_000)]);
		const current = proposal();
		current.derivation = {
			method: "joint-constraints",
			requiredRowCount: 1,
			selectedMinStep: 1.5,
			selectedMaxStep: 3,
			targetSatisfied: false,
			rationale: "Not displayed",
			constraints: {
				status: "unknown",
				scope: "conditional",
				inputRange: null,
				floorRange: null,
				calibration: { low: 8_000_000, high: 9_000_000, rowIds: ["first"] },
				forced: { count: 0, factor: null, conditional: true, ranges: [] },
				changes: [],
				checkpoints: [],
				conditions: [],
			},
		};
		const before = structuredClone({ baseline, current });
		renderLocalized(
			<PerTitleComplexity proposal={current} baseline={baseline} />,
			locale,
		);
		const figure = screen.getByRole("figure", {
			name: locale === "en" ? "Complexity boundaries" : "複雑度境界",
		});
		expect(within(figure).getByText("800 → 1,000")).toBeVisible();
		expect(within(figure).getByText("2,000 → 2,400")).toBeVisible();
		expect(within(figure).getByTitle(lowField)).toBeVisible();
		expect(within(figure).getByTitle(highField)).toBeVisible();
		expect(figure).not.toHaveTextContent(/8,000|9,000|prediction|予測値/);
		expect(figure.querySelectorAll("svg")).toHaveLength(1);
		expect(figure.querySelectorAll("button,input,select")).toHaveLength(0);
		expect({ baseline, current }).toEqual(before);
	});

	it("updates the markers and values on rerender without clipping boundaries to the global cap", () => {
		const baseline = proposal([stream("first", 800_000, 2_000_000)]);
		const { rerender } = renderLocalized(
			<PerTitleComplexity proposal={proposal()} baseline={baseline} />,
		);
		rerender(
			<PerTitleComplexity
				proposal={proposal([stream("first", 1_200_000, 4_800_000)])}
				baseline={baseline}
			/>,
		);
		expect(screen.getByText("800 → 1,200")).toBeVisible();
		expect(screen.getByText("2,000 → 4,800")).toBeVisible();
		expect(screen.queryByText("2,000 → 2,400")).toBeNull();
		const point = screen
			.getAllByTestId("per-title-complexity-point")
			.find(
				(element) =>
					element.getAttribute("data-phase") === "current" &&
					element.getAttribute("data-boundary") === highField,
			);
		expect(point).toHaveAttribute("data-value", "4800000");
		expect(point).toHaveAttribute("cx", "100");
	});

	it("omits automatic, resolution-only and default selection rows", () => {
		const source = stream("first");
		const { container } = renderLocalized(
			<PerTitleComplexity
				proposal={proposal([
					{ ...source, rowId: "automatic", mode: "PER_TITLE_TEMPLATE" },
					{
						...source,
						rowId: "resolution",
						mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
					},
					{
						...source,
						rowId: "optimized",
						perTitleSettings: {
							...source.perTitleSettings,
							bitrateSelectionMode: "OPTIMIZED",
						},
					},
					{ ...source, rowId: "default", perTitleSettings: undefined },
				])}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		[undefined, 2_000_000],
		[1_000_000, undefined],
		[Number.NaN, 2_000_000],
		[1_000_000, Infinity],
		[2_000_000, 1_000_000],
		[0, 2_000_000],
		[1.5, 2_000_000],
	])("does not invent a boundary pair for %s/%s", (low, high) => {
		const current = stream("first");
		current.perTitleSettings = {
			...current.perTitleSettings,
			[lowField]: low,
			[highField]: high,
		};
		const { container } = renderLocalized(
			<PerTitleComplexity proposal={proposal([current])} />,
		);
		expect(screen.getByText("Boundary values unavailable")).toBeVisible();
		expect(container.querySelector("svg")).toBeNull();
		expect(container).not.toHaveTextContent(/NaN|Infinity|8,000/);
	});

	it("keeps duplicate heights separate and refuses ambiguous baseline identity", () => {
		const current = proposal([
			stream("same", 1_000_000, 2_400_000),
			stream("same", 1_200_000, 3_000_000),
		]);
		const { container } = renderLocalized(
			<PerTitleComplexity
				proposal={current}
				baseline={proposal([stream("same", 777_000, 1_700_000)])}
			/>,
		);
		expect(screen.getByText("Rendition 1 · 360 px")).toBeVisible();
		expect(screen.getByText("Rendition 2 · 360 px")).toBeVisible();
		expect(container.querySelectorAll("svg")).toHaveLength(2);
		expect(container).not.toHaveTextContent(/777|1,700|→/);
		expect(
			screen
				.getAllByTestId("per-title-complexity-point")
				.every((point) => point.getAttribute("data-phase") === "current"),
		).toBe(true);
	});

	it("does not compare another codec or an ambiguous baseline row", () => {
		const baseline = proposal([stream("first", 777_000, 1_700_000)]);
		const { container, rerender } = renderLocalized(
			<PerTitleComplexity
				proposal={proposal()}
				baseline={{ ...baseline, codec: "VP9" }}
			/>,
		);
		expect(container).not.toHaveTextContent(/777|1,700|→/);
		rerender(
			<PerTitleComplexity
				proposal={proposal()}
				baseline={proposal([
					stream("first", 777_000, 1_700_000),
					stream("first"),
				])}
			/>,
		);
		expect(container).not.toHaveTextContent(/777|1,700|→/);
	});

	it("receives the optional before proposal through the recommendation panel", () => {
		const goal: PerTitleGoal = {
			strategy: "fixed-ranges",
			codec: "H264",
			minBitrate: 100_000,
			maxBitrate: 2_400_000,
			countPolicy: { kind: "unrestricted" },
		};
		renderLocalized(
			<PerTitleRecommendation
				goal={goal}
				proposal={proposal()}
				baseline={proposal([stream("first", 800_000, 2_000_000)])}
			/>,
		);
		expect(screen.getByText("800 → 1,000")).toBeVisible();
	});
});
