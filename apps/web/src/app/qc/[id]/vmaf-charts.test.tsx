import { computePooled, computePsnrPooled, type VmafFrame } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import {
	renditionColor,
	sortedRenditions,
	type VmafResultDetail,
} from "../vmaf-shared";

// Recharts' ResponsiveContainer measures its box via ResizeObserver, which
// reports 0×0 under jsdom — so the chart child never gets a width and skips
// drawing its geometry. The real container clones the child with the measured
// width/height; the mock does the same with fixed dimensions so the SVG
// (lines/dots/symbols) actually mounts. Standard Recharts-in-vitest workaround.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as React.ReactElement<{
							width?: number;
							height?: number;
						}>,
						{ width: 800, height: 320 },
					)
				: children,
	};
});

import { FrameChart } from "./frame-chart";
import { LadderScatter } from "./ladder-scatter";
import { PooledTable } from "./pooled-table";

function chartFrames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}

function result(
	id: string,
	label: string,
	height: number,
	bitrate: number,
	scores: number[],
): VmafResultDetail {
	const frames = chartFrames(scores);
	const pooled = computePooled(frames);
	return {
		id,
		renditionRef: { label, height, bitrate },
		pooled,
		frames: frames.map((f) =>
			f.frameNum === pooled.worstFrame.frameNum ? { ...f, worst: true } : f,
		),
		frameCount: frames.length,
	};
}

const RESULTS: VmafResultDetail[] = [
	result("r1", "360p", 360, 800_000, [88, 84, 60, 86, 89]),
	result("r2", "1080p", 1080, 4_500_000, [97, 96, 80, 98, 97]),
];

/** A result whose frames + pooled also carry PSNR (dB) — P4-PR5. */
function psnrResult(
	id: string,
	label: string,
	scores: number[],
	psnr: number[],
): VmafResultDetail {
	const frames: VmafFrame[] = scores.map((vmaf, frameNum) => ({
		frameNum,
		vmaf,
		psnr: psnr[frameNum],
	}));
	const pooled = computePooled(frames);
	pooled.psnr = computePsnrPooled(psnr);
	return {
		id,
		renditionRef: { label, height: 1080, bitrate: 4_500_000 },
		pooled,
		frames: frames.map((f) =>
			f.frameNum === pooled.worstFrame.frameNum ? { ...f, worst: true } : f,
		),
		frameCount: frames.length,
	};
}

const PSNR_RESULTS: VmafResultDetail[] = [
	psnrResult("p1", "1080p", [97, 96, 80, 98, 97], [46, 45, 38, 47, 46]),
];

describe("PooledTable", () => {
	it("explains continuous subjective anchors without assigning score verdicts", () => {
		const { container } = renderL(<PooledTable results={RESULTS} />, "ja");
		expect(
			screen.getByText(
				/20 ≈ bad.*40 ≈ poor.*60 ≈ fair.*80 ≈ good.*100 ≈ excellent/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/区間の境界や合否基準ではありません/),
		).toBeInTheDocument();

		const high = container.querySelector('[data-score="93.6"]');
		const medium = container.querySelector('[data-score="81.4"]');
		const low = container.querySelector('[data-score="60.0"]');
		expect(high).not.toBeNull();
		expect(medium).not.toBeNull();
		expect(low).not.toBeNull();
		for (const cell of [high, medium, low]) {
			expect(cell?.textContent).not.toMatch(/[○△!]/);
			expect(cell?.className).not.toMatch(/text-(emerald|amber|red)-/);
		}
		expect(
			screen.getByRole("link", { name: "Netflix / VMAF" }),
		).toHaveAttribute(
			"href",
			"https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v0.md",
		);
	});

	it("sorts bitrate ascending by default and toggles without changing chart colors", () => {
		const { container } = renderL(
			<PooledTable results={[...RESULTS].reverse()} />,
		);
		const rows = () => [...container.querySelectorAll("tbody tr")];
		expect(rows().map((row) => row.querySelector("td")?.textContent)).toEqual([
			"360p",
			"1080p",
		]);
		expect(rows()[0]?.querySelector('[aria-hidden="true"]')).toHaveStyle({
			backgroundColor: renditionColor(1),
		});
		expect(
			screen.getByRole("columnheader", { name: /Rendition/ }),
		).toHaveAttribute("aria-sort", "ascending");
		fireEvent.click(screen.getByTitle("Sort by bitrate: high to low"));
		expect(rows().map((row) => row.querySelector("td")?.textContent)).toEqual([
			"1080p",
			"360p",
		]);
		expect(
			screen.getByRole("columnheader", { name: /Rendition/ }),
		).toHaveAttribute("aria-sort", "descending");
	});

	it("keeps unknown bitrate last, equal bitrates stable and original identities unchanged", () => {
		const input = [
			undefined,
			3_000,
			1_000,
			3_000,
			Number.NaN,
			0,
			-1,
			Number.POSITIVE_INFINITY,
		].map((bitrate, index) => ({
			...result(String(index), "rendition", 720, 1_000, [100]),
			id: String(index),
			renditionRef: { bitrate },
		}));
		const ids = (direction: "asc" | "desc") =>
			sortedRenditions(input, direction).map(({ result, index }) => [
				result.id,
				index,
			]);
		expect(ids("asc")).toEqual([
			["2", 2],
			["1", 1],
			["3", 3],
			["0", 0],
			["4", 4],
			["5", 5],
			["6", 6],
			["7", 7],
		]);
		expect(ids("desc")).toEqual([
			["1", 1],
			["3", 3],
			["2", 2],
			["0", 0],
			["4", 4],
			["5", 5],
			["6", 6],
			["7", 7],
		]);
		expect(input.map((r) => r.id)).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
		]);
	});

	it("renders a row per rendition with the headline metrics", () => {
		renderL(<PooledTable results={RESULTS} />);
		expect(screen.getByText("360p")).toBeInTheDocument();
		expect(screen.getByText("1080p")).toBeInTheDocument();
		// column headers for the trickier aggregates are present.
		expect(screen.getByText("Harm.")).toBeInTheDocument();
		expect(screen.getByText("1% low")).toBeInTheDocument();
		expect(screen.getByText("p5")).toBeInTheDocument();
		// worst-frame cell shows the dip frame number (#2 in r1's series).
		expect(screen.getAllByText(/#2/).length).toBeGreaterThan(0);
	});

	it("exposes InfoHint tooltips explaining harmonic mean / 1% low / percentiles", () => {
		renderL(<PooledTable results={RESULTS} />);
		expect(
			screen.getByLabelText("Harmonic mean — more information"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("1% low — more information"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("p1 — more information")).toBeInTheDocument();
	});

	it("hides the PSNR columns when no result carries PSNR", () => {
		renderL(<PooledTable results={RESULTS} />);
		expect(screen.queryByText("PSNR (dB)")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("PSNR mean — more information"),
		).not.toBeInTheDocument();
	});

	it("renders PSNR mean/min/max columns + values when PSNR is present (P4-PR5)", () => {
		renderL(<PooledTable results={PSNR_RESULTS} />);
		expect(screen.getByText("PSNR (dB)")).toBeInTheDocument();
		expect(screen.getByText("PSNR min")).toBeInTheDocument();
		expect(screen.getByText("PSNR max")).toBeInTheDocument();
		expect(
			screen.getByLabelText("PSNR mean — more information"),
		).toBeInTheDocument();
		// pooled psnr of [46,45,38,47,46]: mean 44.40, min 38.00, max 47.00.
		expect(screen.getByText("44.40")).toBeInTheDocument();
		expect(screen.getByText("38.00")).toBeInTheDocument();
		expect(screen.getByText("47.00")).toBeInTheDocument();
	});

	it("shows em-dashes for a result without PSNR when another result has it", () => {
		renderL(
			<PooledTable
				results={[...PSNR_RESULTS, RESULTS[0] as VmafResultDetail]}
			/>,
		);
		// the PSNR columns exist (one result has psnr); the non-psnr row's three
		// dB cells render as em-dashes.
		expect(screen.getByText("PSNR (dB)")).toBeInTheDocument();
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
	});
});

describe("FrameChart", () => {
	it("uses labelled native inputs as the keyboard range control and rejects an inverted range", async () => {
		const { container } = renderL(<FrameChart results={RESULTS} />);
		const start = screen.getByLabelText("Start frame");
		const end = screen.getByLabelText("End frame");
		expect(start).toHaveValue(0);
		expect(end).toHaveValue(4);

		fireEvent.change(start, { target: { value: "1" } });
		expect(screen.getByRole("status")).toHaveTextContent(
			"Current frame range: 1–4",
		);

		fireEvent.change(start, { target: { value: "4" } });
		fireEvent.change(end, { target: { value: "2" } });
		expect(start).toHaveAttribute("aria-invalid", "true");
		expect(end).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("status")).toHaveTextContent(
			"Start frame must not be greater than end frame.",
		);

		await waitFor(() => {
			const travellers = container.querySelectorAll(
				".recharts-brush-traveller",
			);
			expect(travellers).toHaveLength(2);
			for (const traveller of travellers) {
				expect(traveller).toHaveAttribute("tabindex", "-1");
			}
		});
	});

	it("renders an SVG line per rendition over the downsampled series", () => {
		const { container } = renderL(<FrameChart results={RESULTS} />);
		// Recharts draws each <Line> as a path.recharts-line-curve.
		const lines = container.querySelectorAll(".recharts-line-curve");
		expect(lines.length).toBe(2);
	});

	it("marks each rendition's worst frame with a reference dot", () => {
		const { container } = renderL(<FrameChart results={RESULTS} />);
		const dots = container.querySelectorAll(".recharts-reference-dot");
		expect(dots.length).toBe(2);
	});

	it("shows an empty-state line when no rendition has frames", () => {
		renderL(
			<FrameChart
				results={[
					{ ...RESULTS[0], frames: [], frameCount: 0 } as VmafResultDetail,
				]}
			/>,
		);
		expect(screen.getByText(/No per-frame data/i)).toBeInTheDocument();
	});

	it("offers no PSNR toggle when no rendition has PSNR", () => {
		renderL(<FrameChart results={RESULTS} />);
		expect(screen.queryByText(/PSNR/i)).not.toBeInTheDocument();
	});

	it("toggles a PSNR series on a secondary axis when PSNR is present (P4-PR5)", () => {
		const { container } = renderL(<FrameChart results={PSNR_RESULTS} />);
		// Default view: VMAF-only — one line, the toggle shows "Show PSNR".
		expect(container.querySelectorAll(".recharts-line-curve").length).toBe(1);
		const toggle = screen.getByRole("button", { name: /show psnr/i });
		expect(toggle).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(toggle);

		// After toggling: a second (PSNR) line appears alongside the VMAF line.
		expect(container.querySelectorAll(".recharts-line-curve").length).toBe(2);
		expect(screen.getByRole("button", { name: /hide psnr/i })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});
});

describe("LadderScatter", () => {
	it("renders a scatter point per rendition (quality vs bitrate)", () => {
		const { container } = renderL(<LadderScatter results={RESULTS} />);
		const symbols = container.querySelectorAll(".recharts-scatter-symbol");
		expect(symbols.length).toBe(2);
	});

	it("falls back to an explanatory line when no bitrate/height metadata", () => {
		renderL(
			<LadderScatter
				results={[
					{
						...RESULTS[0],
						renditionRef: { label: "unknown" },
					} as VmafResultDetail,
				]}
			/>,
		);
		expect(screen.getByText(/ladder view\s+unavailable/i)).toBeInTheDocument();
	});
});
