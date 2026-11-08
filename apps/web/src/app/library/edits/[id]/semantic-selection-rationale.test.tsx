import type { SemanticEvidence } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { SemanticSelectionRationale } from "./semantic-selection-rationale";

const evidence: SemanticEvidence = {
	version: "aisa-content-evidence-v1",
	method: "METADATA_HEURISTIC",
	profile: "NARRATIVE",
	keyEntities: [
		{
			kind: "CHARACTER",
			label: "Rabbit",
			sceneIds: ["11111111-1111-4111-8111-111111111111"],
		},
		{
			kind: "OBJECT",
			label: "Bow and arrow",
			sceneIds: ["11111111-1111-4111-8111-111111111111"],
		},
	],
	selectedMoments: [
		{
			sceneId: "11111111-1111-4111-8111-111111111111",
			shotIndex: 0,
			label: "Rabbit completes the preparation",
			score: 780,
			reasonCodes: ["STATE_CHANGE"],
		},
	],
	selectionReason: "CONTENT_RANKED",
};
const locales = [
	{
		locale: "ja" as const,
		title: "自動選定時の根拠",
		profile: "内容の傾向（推定）",
		narrative: "物語",
		elements: "登場する主な要素",
		moments: "選んだ場面",
	},
	{
		locale: "en" as const,
		title: "Why these moments were selected",
		profile: "Inferred content type",
		narrative: "Narrative",
		elements: "Key elements",
		moments: "Selected moments",
	},
];
describe.each(locales)("automatic selection rationale ($locale)", (c) => {
	it("starts folded and shows original metadata evidence without a warning or confirmation gate", () => {
		renderLocalized(
			<SemanticSelectionRationale evidence={evidence} />,
			c.locale,
		);
		const summary = screen.getByText(c.title),
			details = summary.closest("details");
		expect(details).not.toHaveAttribute("open");
		expect(details).toHaveTextContent(c.profile);
		expect(details).toHaveTextContent(c.narrative);
		fireEvent.click(summary);
		expect(screen.getByText("Rabbit")).toBeVisible();
		expect(screen.getByText("Bow and arrow")).toBeVisible();
		expect(
			screen.getByText(evidence.selectedMoments[0]?.label ?? ""),
		).toBeVisible();
		expect(screen.getByText(c.elements)).toBeVisible();
		expect(screen.getByText(c.moments)).toBeVisible();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(details).not.toHaveTextContent(
			/780|METADATA_HEURISTIC|aisa-content-evidence|STATE_CHANGE/,
		);
	});
	it("keeps legacy projects free of an empty explanation", () => {
		const view = renderLocalized(<SemanticSelectionRationale />, c.locale);
		expect(view.container).toBeEmptyDOMElement();
	});
	it.each([
		"INSUFFICIENT_METADATA",
		"SEARCH_BUDGET",
	] as const)("presents %s as folded context", (selectionReason) => {
		renderLocalized(
			<SemanticSelectionRationale
				evidence={{
					...evidence,
					keyEntities: [],
					profile: "GENERAL",
					selectionReason,
				}}
			/>,
			c.locale,
		);
		const details = screen.getByText(c.title).closest("details");
		expect(details).not.toHaveAttribute("open");
		expect(details?.querySelector("p")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByText(c.elements)).not.toBeInTheDocument();
		expect(details).toHaveTextContent(c.moments);
	});
});
