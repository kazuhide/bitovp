import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { renderLocalized } from "@/test/render";
import { AnalysisView } from "./analysis-view";

it("shows asset credits before scene details without labeling all people as cast", () => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1.79.0" },
		duration: 10,
		credits: {
			persons: [
				{ name: "Person A", role: "Director", department: "Production" },
			],
			songs: [{ name: "Song A", artist: "Artist A" }],
			copyright: "Example copyright",
		},
	});
	renderLocalized(<AnalysisView document={document} />);
	const region = screen.getByRole("region", { name: "Content credits" });
	for (const summary of region.querySelectorAll("summary"))
		fireEvent.click(summary);
	for (const value of [
		"Person A",
		"Director",
		"Production",
		"Song A",
		"Artist A",
		"Example copyright",
	])
		expect(within(region).getByText(value)).toBeInTheDocument();
	expect(
		region.compareDocumentPosition(
			screen.getByRole("heading", { name: /Scenes/ }),
		) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});
it.each([
	undefined,
	{ persons: [], songs: [], copyright: "" },
])("explains missing or empty content credits", (credits) => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 10,
		credits,
	});
	renderLocalized(<AnalysisView document={document} />);
	expect(
		within(screen.getByRole("region", { name: "Content credits" })).getByText(
			en.library.unreported,
		),
	).toBeInTheDocument();
});
it("keeps overall credits out of current-scene mode", () => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 10,
	});
	renderLocalized(<AnalysisView document={document} mode="current" />);
	expect(
		screen.queryByRole("region", { name: "Content credits" }),
	).not.toBeInTheDocument();
});
