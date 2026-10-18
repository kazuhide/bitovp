import { normalizeSceneAnalysis } from "@bitovp/core";
import { act, fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { fittedVideoFrame, SubjectOverlay } from "./subject-overlay";

it("aligns observations to contained video instead of letterbox or pillarbox bars", () => {
	expect(fittedVideoFrame(400, 225, 100, 100)).toEqual({
		left: 87.5,
		top: 0,
		width: 225,
		height: 225,
	});
	expect(fittedVideoFrame(400, 225, 200, 100)).toEqual({
		left: 0,
		top: 12.5,
		width: 400,
		height: 200,
	});
	expect(fittedVideoFrame(400, 225, 0, 0)).toBeNull();
	expect(fittedVideoFrame(400, 225, 100, 100, "cover")).toEqual({
		left: 0,
		top: -87.5,
		width: 400,
		height: 400,
	});
	expect(fittedVideoFrame(400, 225, 100, 100, "fill")).toEqual({
		left: 0,
		top: 0,
		width: 400,
		height: 225,
	});
});

const document = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 10,
	scenes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			startInSeconds: 0,
			endInSeconds: 10,
			shots: [
				{
					startInSeconds: 2,
					endInSeconds: 5,
					mainSubjects: [
						{
							classification: "Person",
							description: "Observed visitor",
							appearanceTimeInSeconds: 1,
							centerX: 25,
							centerY: 75,
						},
					],
				},
			],
		},
	],
});

it("shows whole-shot observations at percent positions, clears shot gaps and remeasures video metadata", () => {
	const host = window.document.createElement("div");
	const video = window.document.createElement("video");
	host.append(video);
	Object.defineProperties(video, {
		clientWidth: { value: 400 },
		clientHeight: { value: 225 },
		videoWidth: { value: 100, configurable: true },
		videoHeight: { value: 100 },
	});
	video.style.objectFit = "contain";
	const view = renderLocalized(
		<SubjectOverlay host={host} analysis={document} time={2} />,
	);
	const marker = screen.getByTitle("Observed visitor");
	expect(marker).toHaveStyle({ left: "25%", top: "75%" });
	expect(screen.getByTestId("subject-frame")).toHaveStyle({
		left: "87.5px",
		width: "225px",
	});
	view.rerender(<SubjectOverlay host={host} analysis={document} time={5} />);
	expect(screen.queryByText("Person")).not.toBeInTheDocument();
	view.rerender(<SubjectOverlay host={host} analysis={document} time={3} />);
	Object.defineProperty(video, "videoWidth", { value: 200 });
	fireEvent(video, new Event("resize"));
	expect(screen.getByTestId("subject-frame")).toHaveStyle({
		top: "12.5px",
		width: "400px",
	});
	view.rerender(<SubjectOverlay host={host} analysis={document} time={null} />);
	expect(screen.queryByText("Person")).not.toBeInTheDocument();
});

it("discovers a Bitmovin-owned video inserted after the overlay mounts", async () => {
	const host = window.document.createElement("div");
	renderLocalized(<SubjectOverlay host={host} analysis={document} time={3} />);
	expect(screen.queryByText("Person")).not.toBeInTheDocument();
	const video = window.document.createElement("video");
	Object.defineProperties(video, {
		clientWidth: { value: 400 },
		clientHeight: { value: 225 },
		videoWidth: { value: 1920 },
		videoHeight: { value: 1080 },
	});
	await act(async () => {
		host.append(video);
	});
	expect(screen.getByText("Person")).toBeInTheDocument();
	await act(async () => {
		video.remove();
	});
	expect(screen.queryByText("Person")).not.toBeInTheDocument();
});
