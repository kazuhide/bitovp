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
		expect(screen.getByRole("table")).toHaveClass("sr-only");
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
