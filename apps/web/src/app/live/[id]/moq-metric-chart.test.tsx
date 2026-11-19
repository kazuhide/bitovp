import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { MoqMetricChart } from "./moq-metric-chart";

vi.mock("recharts", async (importOriginal) => {
	const recharts = await importOriginal<typeof import("recharts")>();
	return {
		...recharts,
		ResponsiveContainer: ({ children }: { children: ReactNode }) => (
			<recharts.ResponsiveContainer width={400} height={84}>
				{children}
			</recharts.ResponsiveContainer>
		),
	};
});

describe("MoQ metric chart", () => {
	it("marks isolated measurements across source switches and keeps the remaining line gaps", () => {
		const videoColor = "var(--color-sky-400)";
		const canvasColor = "var(--color-amber-400)";
		const { container } = renderLocalized(
			<MoqMetricChart
				id="fps"
				label="Frame observations"
				points={[
					{ timestamp: 1000, video: 25, canvas: null },
					{ timestamp: 2000, video: null, canvas: 0 },
					{ timestamp: 3000, video: 29, canvas: null },
					{ timestamp: 4000, video: null, canvas: 4 },
					{ timestamp: 5000, video: 26, canvas: null },
					{ timestamp: 6000, video: 27, canvas: null },
				]}
				lines={[
					{ field: "video", label: "Video FPS", color: videoColor },
					{ field: "canvas", label: "Canvas changes", color: canvasColor },
				]}
				unit="/s"
			/>,
		);
		const colors = Array.from(
			container.querySelectorAll(".recharts-line-dots circle"),
			(dot) => dot.getAttribute("fill"),
		);
		expect(colors.filter((color) => color === videoColor)).toHaveLength(2);
		expect(colors.filter((color) => color === canvasColor)).toHaveLength(2);
		expect(colors).toHaveLength(4);

		const curves = Array.from(
			container.querySelectorAll("path.recharts-line-curve"),
		);
		const curve = (color: string) =>
			curves
				.find((path) => path.getAttribute("stroke") === color)
				?.getAttribute("d");
		expect(curve(videoColor)?.match(/L/g)).toHaveLength(1);
		expect(curve(canvasColor)).toBeTruthy();
		expect(curve(canvasColor)).not.toContain("L");
	});
});
