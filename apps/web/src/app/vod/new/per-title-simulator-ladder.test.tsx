import type { PerTitleProposal } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleLadder } from "./per-title-simulator-ladder";

const global = {
	minBitrate: 100_000,
	maxBitrate: 2_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
};
const lower = {
	rowId: "lower",
	mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" as const,
	height: 360,
	perTitleSettings: { minBitrate: 100_000, maxBitrate: 400_000 },
};
const upper = {
	rowId: "upper",
	mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" as const,
	height: 720,
	perTitleSettings: { minBitrate: 500_000, maxBitrate: 2_000_000 },
};
const automatic = {
	rowId: "automatic",
	mode: "PER_TITLE_TEMPLATE" as const,
	height: 1080,
};

function proposal(
	api: Partial<PerTitleProposal["api"]> = {},
): PerTitleProposal {
	return {
		id: "baseline",
		codec: "H264",
		status: "candidate",
		applicable: true,
		evidence: "model-only",
		countGuarantee: false,
		api: { global, streams: [lower, upper, automatic], ...api },
		scenarios: [],
		diagnostics: [],
	};
}

describe("Per-Title bitrate range plot", () => {
	it.each([
		[
			"en",
			"Allowed bitrate ranges",
			"Allowed bitrate ranges (data)",
			"kbps (log scale)",
			"Ordinary templates: 1",
		],
		[
			"ja",
			"許容ビットレート範囲",
			"許容ビットレート範囲（データ）",
			"kbps（対数目盛）",
			"通常テンプレート: 1",
		],
	] as const)("shows requested bands and accessible row data in %s", (locale, title, dataTitle, axis, candidateCount) => {
		renderLocalized(<PerTitleLadder proposal={proposal()} />, locale);
		expect(screen.getByRole("figure", { name: title })).toBeVisible();
		expect(
			screen.getByRole("img", { name: title }),
		).toHaveAccessibleDescription(/kbps/);
		expect(screen.getByText(axis)).toBeVisible();
		expect(screen.getByText("360 px")).toBeVisible();
		expect(
			within(screen.getByRole("img", { name: title })).getByText("100–400"),
		).toBeVisible();
		const table = screen.getByRole("table", { name: dataTitle });
		expect(
			within(table).getByRole("row", { name: "360 100–400" }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole("row", { name: "720 500–2,000" }),
		).toBeInTheDocument();
		expect(table).toHaveClass("sr-only");
		expect(screen.getByText(candidateCount)).toBeVisible();
		expect(screen.queryByText("1080 px")).toBeNull();
	});

	it("keeps duplicate required heights as separate ranges", () => {
		renderLocalized(
			<PerTitleLadder
				proposal={proposal({ streams: [lower, { ...upper, height: 360 }] })}
			/>,
		);
		expect(screen.getAllByText("360 px")).toHaveLength(2);
		const rows = within(screen.getByRole("table")).getAllByRole("row");
		expect(rows).toHaveLength(3);
		expect(rows[1]).toHaveTextContent("100–400");
		expect(rows[2]).toHaveTextContent("500–2,000");
	});

	it("plots a fixed-resolution template as the global dashed band without a target bitrate", () => {
		renderLocalized(
			<PerTitleLadder
				proposal={proposal({
					streams: [
						{
							rowId: "fixed",
							mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
							height: 540,
						},
						automatic,
					],
				})}
			/>,
		);
		expect(screen.getByText("Auto")).toBeVisible();
		expect(
			within(screen.getByRole("table")).getByRole("row", {
				name: "540 100–2,000 Auto",
			}),
		).toBeInTheDocument();
		expect(screen.getByTestId("per-title-ladder-range")).toHaveAttribute(
			"stroke-dasharray",
			"4 3",
		);
		expect(screen.queryByText("1080 px")).toBeNull();
	});

	it("places the middle decade halfway along a logarithmic bitrate axis", () => {
		renderLocalized(
			<PerTitleLadder
				proposal={proposal({
					global: { ...global, maxBitrate: 10_000_000 },
					streams: [
						{
							...lower,
							perTitleSettings: {
								minBitrate: 1_000_000,
								maxBitrate: 10_000_000,
							},
						},
					],
				})}
			/>,
		);
		const range = screen.getByTestId("per-title-ladder-range");
		expect(Number(range.getAttribute("x1"))).toBeCloseTo(50, 8);
		expect(Number(range.getAttribute("x2"))).toBeCloseTo(100, 8);
		for (const line of screen.getByRole("img").querySelectorAll("line")) {
			for (const attribute of ["x1", "x2", "y1", "y2"]) {
				expect(Number.isFinite(Number(line.getAttribute(attribute)))).toBe(
					true,
				);
			}
		}
	});

	it("shows automatic candidates without creating required output rows", () => {
		renderLocalized(
			<PerTitleLadder
				proposal={proposal({
					streams: [
						automatic,
						{ ...automatic, rowId: "another", height: 2160 },
					],
				})}
			/>,
		);
		expect(screen.getByText("Ordinary templates: 2")).toBeVisible();
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.queryByTestId("per-title-ladder-range")).toBeNull();
		expect(screen.queryByText("1080 px")).toBeNull();
		expect(screen.queryByText("2160 px")).toBeNull();
	});

	it("keeps a supplied axis fixed while a changed global maximum moves the band", () => {
		const axis = { minimum: 100000, maximum: 10000000 };
		const stream = {
			...lower,
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" as const,
		};
		const initial = proposal({ streams: [stream] });
		const { rerender } = renderLocalized(
			<PerTitleLadder proposal={initial} axis={axis} />,
		);
		const before = Number(
			screen.getByTestId("per-title-ladder-range").getAttribute("x2"),
		);
		const tickText = screen.getByTestId("per-title-ladder-axis").textContent;
		rerender(
			<PerTitleLadder
				proposal={proposal({
					global: { ...global, maxBitrate: 4000000 },
					streams: [stream],
				})}
				axis={axis}
			/>,
		);
		expect(screen.getByTestId("per-title-ladder-axis").textContent).toBe(
			tickText,
		);
		expect(
			Number(screen.getByTestId("per-title-ladder-range").getAttribute("x2")),
		).toBeGreaterThan(before);
		expect(
			within(screen.getByRole("table")).getByRole("row", {
				name: "360 100–4,000 Auto",
			}),
		).toBeInTheDocument();
		expect(initial.api.global.maxBitrate).toBe(2000000);
	});

	it.each([
		"en",
		"ja",
	] as const)("clips display geometry with visible overflow while retaining legal API limits (%s)", (locale) => {
		const input = proposal();
		const original = structuredClone(input);
		renderLocalized(
			<PerTitleLadder
				proposal={input}
				axis={{ minimum: 200000, maximum: 1000000 }}
			/>,
			locale,
		);
		const ranges = screen.getAllByTestId("per-title-ladder-range");
		expect(ranges[0]).toHaveAttribute("x1", "0");
		expect(ranges[1]).toHaveAttribute("x2", "100");
		expect(
			screen.getAllByText(locale === "en" ? /Outside scale/ : /目盛りの範囲外/),
		).toHaveLength(2);
		expect(
			within(screen.getByRole("table")).getByRole("row", {
				name: "360 100–400",
			}),
		).toBeInTheDocument();
		expect(
			within(screen.getByRole("table")).getByRole("row", {
				name: "720 500–2,000",
			}),
		).toBeInTheDocument();
		expect(input).toEqual(original);
	});

	it.each([
		{ minimum: 0, maximum: 1000000 },
		{ minimum: 1.5, maximum: 1000000 },
		{ minimum: Number.NaN, maximum: 1000000 },
		{ minimum: 100000, maximum: Number.POSITIVE_INFINITY },
		{ minimum: 2000000, maximum: 100000 },
	])("withholds geometry for an invalid explicit axis $minimum–$maximum", (axis) => {
		const { container } = renderLocalized(
			<PerTitleLadder proposal={proposal()} axis={axis} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Ranges unavailable");
		expect(container.querySelector("svg")).toBeNull();
		expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
	});

	it.each([
		{
			name: "nonfinite global minimum",
			api: { global: { ...global, minBitrate: NaN } },
		},
		{
			name: "infinite global maximum",
			api: { global: { ...global, maxBitrate: Infinity } },
		},
		{
			name: "reversed global limits",
			api: { global: { ...global, minBitrate: 3_000_000 } },
		},
		{
			name: "zero global minimum",
			api: { global: { ...global, minBitrate: 0 } },
		},
		{
			name: "reversed row limits",
			api: {
				streams: [
					{
						...lower,
						perTitleSettings: { minBitrate: 400_000, maxBitrate: 100_000 },
					},
				],
			},
		},
		{
			name: "row beyond global maximum",
			api: {
				streams: [
					{
						...lower,
						perTitleSettings: { minBitrate: 100_000, maxBitrate: 3_000_000 },
					},
				],
			},
		},
		{
			name: "row below global minimum",
			api: {
				streams: [
					{
						...lower,
						perTitleSettings: { minBitrate: 50_000, maxBitrate: 400_000 },
					},
				],
			},
		},
		{
			name: "nonfinite row limit",
			api: {
				streams: [
					{
						...lower,
						perTitleSettings: { minBitrate: NaN, maxBitrate: 400_000 },
					},
				],
			},
		},
		{
			name: "missing row limit",
			api: {
				streams: [{ ...lower, perTitleSettings: { minBitrate: 100_000 } }],
			},
		},
		{
			name: "missing required height",
			api: { streams: [{ ...lower, height: undefined }] },
		},
	] satisfies Array<{
		name: string;
		api: Partial<PerTitleProposal["api"]>;
	}>)("withholds invalid geometry for $name", ({ api }) => {
		const { container } = renderLocalized(
			<PerTitleLadder proposal={proposal(api)} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Ranges unavailable");
		expect(screen.queryByRole("img")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
		expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
	});

	it("handles an equal global range without nonfinite coordinates or fabricated values", () => {
		renderLocalized(
			<PerTitleLadder
				proposal={proposal({
					global: { ...global, maxBitrate: global.minBitrate },
					streams: [
						{
							...lower,
							perTitleSettings: {
								minBitrate: global.minBitrate,
								maxBitrate: global.minBitrate,
							},
						},
					],
				})}
			/>,
		);
		const range = screen.getByTestId("per-title-ladder-range");
		expect(range).toHaveAttribute("x1", "50");
		expect(range).toHaveAttribute("x2", "50");
		expect(
			within(screen.getByRole("table")).getByRole("row", {
				name: "360 100–100",
			}),
		).toBeInTheDocument();
	});

	it("does not mutate or replace proposal data while drawing it", () => {
		const input = proposal({
			global: { ...global },
			streams: [
				{ ...lower, perTitleSettings: { ...lower.perTitleSettings } },
				{ ...upper, perTitleSettings: { ...upper.perTitleSettings } },
			],
		});
		const snapshot = structuredClone(input);
		const identity = input.api.streams;
		Object.freeze(input.api.global);
		Object.freeze(input.api.streams);
		renderLocalized(<PerTitleLadder proposal={input} />);
		expect(input).toEqual(snapshot);
		expect(input.api.streams).toBe(identity);
	});
});
