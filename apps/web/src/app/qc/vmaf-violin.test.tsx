import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import type { VmafScoreDistribution } from "./vmaf-shared";
import { VmafViolinChart } from "./vmaf-violin";

const distribution: VmafScoreDistribution = {
	frameCount: 1000,
	min: 40,
	max: 90,
	mean: 85,
	binWidth: 50 / 64,
	bins: Array.from({ length: 64 }, (_, i) => ({
		score: 40 + ((i + 0.5) * 50) / 64,
		count: i === 0 ? 100 : i === 63 ? 900 : 0,
	})),
};
const series = (
	key: string,
	values: VmafScoreDistribution | null = distribution,
) => ({
	key,
	label: key,
	color: "#34d399",
	distribution: values,
});

describe("VMAF violin distribution", () => {
	it("draws a recognizable closed density silhouette and exposes exact measured statistics", () => {
		renderLocalized(<VmafViolinChart series={[series("HEVC 1080p")]} />);
		const figure = screen.getByLabelText(/HEVC 1080p.*1,000/);
		expect(figure.querySelector("path")?.getAttribute("d")).toMatch(/^M.+Z$/);
		expect(screen.getByText("Mean 85.0")).toBeInTheDocument();
		expect(screen.getByText("Min 40.0 · Max 90.0")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /VMAF distribution/ }),
		).toHaveAccessibleDescription(/approximate.*Gaussian.*64/s);
	});

	it("keeps missing and inconsistent distributions unavailable without inventing zero scores", () => {
		renderLocalized(
			<VmafViolinChart
				series={[
					series("missing", null),
					series("incomplete", { ...distribution, frameCount: 1001 }),
				]}
			/>,
		);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getAllByText("Distribution unavailable")).toHaveLength(2);
		expect(screen.queryByText("Mean 0.0")).not.toBeInTheDocument();
	});

	it("keeps the common score axis large enough for above-100 and negative measurements", () => {
		const extended = {
			...distribution,
			min: -10,
			max: 125,
			mean: 85,
			binWidth: 135 / 64,
			bins: distribution.bins.map((bin, i) => ({
				...bin,
				score: -10 + ((i + 0.5) * 135) / 64,
			})),
		};
		renderLocalized(
			<VmafViolinChart series={[series("wide", extended), series("normal")]} />,
		);
		expect(screen.getByText("125.0")).toBeInTheDocument();
		expect(screen.getByText("-10.0")).toBeInTheDocument();
		for (const path of document.querySelectorAll("path[data-violin]"))
			expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
	});

	it("draws constant values at a single score, without a fabricated vertical spread", () => {
		const flat = {
			frameCount: 3,
			min: 110,
			max: 110,
			mean: 110,
			binWidth: 0,
			bins: [{ score: 110, count: 3 }],
		};
		renderLocalized(<VmafViolinChart series={[series("constant", flat)]} />);
		const figure = screen.getByLabelText(/constant.*3 measured/);
		expect(figure.querySelector("path")).toBeNull();
		expect(figure.querySelector("line")?.getAttribute("y1")).toEqual(
			figure.querySelector("line")?.getAttribute("y2"),
		);
	});

	it("preserves finite extreme score coordinates without broken SVG geometry", () => {
		const wide = {
			frameCount: 2,
			min: -1e308,
			max: 1e308,
			mean: 0,
			binWidth: 3.125e306,
			bins: [
				{ score: -9e307, count: 1 },
				{ score: 9e307, count: 1 },
			],
		};
		renderLocalized(<VmafViolinChart series={[series("extreme", wide)]} />);
		expect(
			screen
				.getByLabelText(/extreme/)
				.querySelector("path")
				?.getAttribute("d"),
		).not.toMatch(/NaN|Infinity/);
	});

	it("labels subsampled measured frames explicitly and keeps Japanese copy localized", () => {
		renderLocalized(
			<VmafViolinChart series={[{ ...series("AV1 720p"), subsample: 5 }]} />,
			"ja",
		);
		expect(screen.getByText("VMAF 分布")).toBeInTheDocument();
		expect(
			screen.getByText("計測済み 1,000 サンプル（5 フレーム間隔）"),
		).toBeInTheDocument();
	});
});
