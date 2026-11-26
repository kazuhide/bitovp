import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { localStoryEvidenceFixture } from "../editing-fixtures";
import { LocalStoryRationale } from "./local-story-rationale";

it("identifies the original source windows from a saved trailer proposal", () => {
	const evidence = localStoryEvidenceFixture();
	evidence.blueprint.mode = "FLOW";
	const opening = evidence.ledger.events[0];
	if (!opening) throw new Error("Fixture requires an opening event");
	opening.role = "CONTEXT";
	evidence.blueprint.beats[0] = {
		id: "beat",
		role: "CONTEXT",
		eventIds: ["action"],
		requires: [],
	};
	evidence.trailer = {
		intent: { durationMode: "TARGET", disclosure: "SETUP_AND_QUESTION" },
		windows: [{ sourceInUs: 2_500_000, durationFrames: 60 }],
	};
	renderLocalized(<LocalStoryRationale evidence={evidence} />);
	expect(screen.getByText("Trailer selection")).toBeInTheDocument();
	expect(screen.getByText("2.50–4.50 s")).toBeInTheDocument();
});

it("describes the actually chosen event instead of an unselected completion claim", () => {
	renderLocalized(
		<LocalStoryRationale evidence={localStoryEvidenceFixture()} />,
	);
	const details = screen
		.getByText("Moments selected for this story", { selector: "summary" })
		.closest("details");
	expect(details).not.toHaveAttribute("open");
	expect(
		screen.getByText("Memory overwrite is in progress"),
	).toBeInTheDocument();
	expect(screen.getByText("Action")).toBeInTheDocument();
	expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
	expect(
		screen.getByText(
			"This moment has a different role from the original proposal.",
		),
	).toBeInTheDocument();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("adds no story panel to a manual project", () => {
	const view = renderLocalized(<LocalStoryRationale />);
	expect(view.container).toBeEmptyDOMElement();
});
