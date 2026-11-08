import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { storyEvidenceFixture } from "@/test/story-evidence";
import { StorySelectionRationale } from "./story-selection-rationale";

it.each([
	{
		locale: "ja" as const,
		title: "物語に基づく選定理由",
		details: "根拠の記述と使用モデル",
		context: "作成時",
	},
	{
		locale: "en" as const,
		title: "Why this story passage was selected",
		details: "Source descriptions and model",
		context: "created",
	},
])("keeps inferred story context folded and shows quotes and model only in additional details ($locale)", (copy) => {
	const evidence = storyEvidenceFixture();
	renderLocalized(<StorySelectionRationale evidence={evidence} />, copy.locale);
	const summary = screen.getByText(copy.title, { selector: "summary" });
	expect(summary.closest("details")).not.toHaveAttribute("open");
	fireEvent.click(summary);
	expect(screen.getByText(evidence.graph.summary)).toBeVisible();
	expect(screen.getByText("Rabbit")).toBeVisible();
	expect(screen.getByText("Bow and arrow")).toBeVisible();
	for (const event of evidence.graph.events)
		expect(screen.getByText(event.label, { selector: "li p" })).toBeVisible();
	const additional = screen.getByText(copy.details, { selector: "summary" });
	expect(additional.closest("details")).not.toHaveAttribute("open");
	expect(screen.getByText("gpt-6.1-sol")).not.toBeVisible();
	fireEvent.click(additional);
	expect(screen.getByText("gpt-6.1-sol")).toBeVisible();
	expect(
		screen.getByText(evidence.graph.events[0]?.evidence[0]?.quote ?? ""),
	).toBeVisible();
	expect(summary.closest("details")).toHaveTextContent(copy.context);
	expect(summary.closest("details")).not.toHaveTextContent(
		/importance|MODEL_EVENT_GRAPH|100%|probability/,
	);
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it.each([
	"PARTIAL_ARC",
	"METADATA_INSUFFICIENT",
	"SEARCH_BUDGET",
] as const)("describes %s and partial input coverage as folded information", (reason) => {
	const evidence = storyEvidenceFixture();
	evidence.selection.reason = reason;
	evidence.inputCoverage = {
		totalIntervals: 200,
		includedIntervals: 192,
		truncated: true,
	};
	renderLocalized(<StorySelectionRationale evidence={evidence} />, "ja");
	const details = screen
		.getByText("物語に基づく選定理由", { selector: "summary" })
		.closest("details");
	expect(details).not.toHaveAttribute("open");
	expect(details).toHaveTextContent("192 / 200");
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("leaves older projects without an empty story explanation", () => {
	const view = renderLocalized(<StorySelectionRationale />);
	expect(view.container).toBeEmptyDOMElement();
});
