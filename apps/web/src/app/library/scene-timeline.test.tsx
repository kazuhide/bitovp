import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { AnalysisView } from "./analysis-view";
import { SceneTimeline } from "./scene-timeline";

const document = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 40,
	scenes: [0, 0.5, 0.8, undefined].map((score, i) => ({
		id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		title: `Scene ${i}`,
		startInSeconds: i * 10,
		endInSeconds: i * 10 + 8,
		adOpportunityInformation: { score, reason: "Natural break" },
		content: { dynamics: { tension: "HIGH", pacing: "FAST" } },
		shots: [
			{
				startInSeconds: i * 10,
				endInSeconds: i * 10 + 2,
				detailedDescription: "First shot",
			},
		],
	})),
});
it("bounds a 5000-scene timeline to 20 and searches beyond the visible page", () => {
	const large = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 5000,
		scenes: Array.from({ length: 5000 }, (_, i) => ({
			id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
			title: `Scene ${i}`,
			startInSeconds: i,
			endInSeconds: i + 1,
		})),
	});
	const onSeek = vi.fn();
	renderLocalized(
		<SceneTimeline document={large} time={null} onSeek={onSeek} />,
	);
	expect(
		screen.getAllByRole("button", { name: /Scene \d+ · Ad Opportunity/ }),
	).toHaveLength(20);
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByRole("button", { name: /Scene 20 ·/ })).toBeVisible();
	expect(screen.queryByRole("button", { name: /Scene 0 ·/ })).toBeNull();
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Scene 4999" },
	});
	fireEvent.click(screen.getByRole("button", { name: /Scene 4999 ·/ }));
	expect(onSeek).toHaveBeenCalledWith(4999);
	expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});

it("highlights only reported ad scores above 0.5 and seeks without editing", () => {
	const onSeek = vi.fn();
	renderLocalized(
		<SceneTimeline document={document} time={20} onSeek={onSeek} />,
	);
	const high = screen.getByRole("button", { name: /Scene 2/ });
	expect(high).toHaveAttribute("data-ad-opportunity", "true");
	expect(high).toHaveAttribute("aria-current", "true");
	expect(screen.getByRole("button", { name: /Scene 1/ })).toHaveAttribute(
		"data-ad-opportunity",
		"false",
	);
	expect(screen.getByRole("button", { name: /Scene 3/ })).toHaveTextContent(
		"Not reported",
	);
	fireEvent.click(high);
	expect(onSeek).toHaveBeenCalledWith(20);
});
it("follows current scene with score and reason, clearing gaps rather than stale metadata", () => {
	const view = renderLocalized(
		<AnalysisView document={document} currentTime={20} mode="current" />,
	);
	expect(screen.getByText("0.8")).toBeVisible();
	expect(screen.getByText("Natural break")).toBeVisible();
	expect(screen.getByText("HIGH · FAST")).toBeVisible();
	expect(screen.queryByRole("searchbox")).toBeNull();
	view.rerender(
		<AnalysisView document={document} currentTime={28} mode="current" />,
	);
	expect(
		screen.getByText("No scene at the current playback position."),
	).toBeVisible();
	expect(screen.queryByText("Natural break")).toBeNull();
});
it("keeps zero distinct from missing observations and collapses secondary metadata", () => {
	const view = renderLocalized(
		<AnalysisView document={document} currentTime={0} mode="current" />,
	);
	const score = screen.getByText("Ad Opportunity Score").closest("dl");
	expect(score?.querySelector("dd")).toHaveTextContent("0");
	expect(
		screen.getByText("Classification").closest("details"),
	).not.toHaveAttribute("open");
	view.rerender(
		<AnalysisView document={document} currentTime={30} mode="current" />,
	);
	expect(
		screen.getByText("Ad Opportunity Score").closest("dl")?.querySelector("dd"),
	).toHaveTextContent("Not reported");
});

it("follows overlapping shots inside their owning scene and seeks to the exact provider start", () => {
	const overlapping = normalizeSceneAnalysis({
		metadata: { version: "1.79.0" },
		duration: 653.83,
		scenes: [
			{
				id: "61cd7f2b-4057-4d21-9475-0bc5bfd78413",
				startInSeconds: 151.3125,
				endInSeconds: 238.875,
				shots: [
					{
						startInSeconds: 149.875,
						endInSeconds: 152.916667,
						detailedDescription: "Boundary shot",
					},
				],
			},
		],
	});
	const onSeek = vi.fn();
	renderLocalized(
		<SceneTimeline document={overlapping} time={151.5} onSeek={onSeek} />,
	);
	const shot = screen.getByRole("button", { name: /Boundary shot/ });
	expect(shot).toHaveAttribute("aria-current", "true");
	fireEvent.click(shot);
	expect(onSeek).toHaveBeenCalledWith(149.875);
});
