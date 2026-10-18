import { screen } from "@testing-library/react";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { CompareFrameChart } from "./compare-frame-chart";

// Fixed-size ResponsiveContainer so the chart mounts under jsdom (0×0) —
// the same workaround as the other qc chart tests.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as ReactElement<{ width?: number; height?: number }>,
						{ width: 800, height: 320 },
					)
				: children,
	};
});

/**
 * Battery batch 2e : the per-frame VMAF overlay chart. The
 * two empty states are the substance — a blank 320px box with no words is
 * exactly what ships broken — and the data state must paint one line per
 * series that has frames, dropping the frameless one silently is its
 * documented filter.
 */

const series = (key: string, frames: number[][]) =>
	({
		key,
		jobId: `job-${key}`,
		jobIndex: 0,
		jobLabel: `job-${key}`,
		label: `label-${key}`,
		color: "#10b981",
		mean: 90,
		result: {
			frames: frames.map(([frameNum, vmaf]) => ({ frameNum, vmaf })),
		},
	}) as never;

describe("CompareFrameChart (ledger #149 batch 2e)", () => {
	it("no series selected: says how to get a plot", () => {
		render(<CompareFrameChart series={[]} />);
		expect(screen.getByText(/No series selected/)).toBeInTheDocument();
	});

	it("series without frames: says there is no per-frame data", () => {
		render(<CompareFrameChart series={[series("a", [])]} />);
		expect(
			screen.getByText("No per-frame data for the selected series."),
		).toBeInTheDocument();
	});

	it("plots one line per series that HAS frames", () => {
		render(
			<CompareFrameChart
				series={[
					series("a", [
						[0, 92],
						[1, 93],
					]),
					series("b", [
						[0, 88],
						[1, 87],
					]),
					series("empty", []),
				]}
			/>,
		);
		const paths = document.querySelectorAll("path.recharts-curve");
		expect(paths.length).toBe(2);
	});
});
