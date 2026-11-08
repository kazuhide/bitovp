import type { LocalStoryEvidence } from "@bitovp/core";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { LocalStoryRationale } from "./local-story-rationale";

/** Authored UI history: role mismatch deliberately represents a pre-fix draft. */
function fixture(): LocalStoryEvidence {
	return {
		version: "local-story-evidence-v1",
		method: "LOCAL_LLM_BEAT_PLAN",
		model: {
			version: "local-story-model-v1",
			provider: "LOCAL_OLLAMA",
			profile: "nvidia",
			model: "fixture:27b",
			modelDigest: "a".repeat(64),
			runtimeVersion: "0.40.14",
			promptVersion: "local-story-v1",
			schemaHash: "b".repeat(64),
			configId: "11111111-1111-4111-8111-111111111111",
			context: 8192,
			thinking: false,
		},
		inputHash: "a".repeat(64),
		artifactHash: "b".repeat(64),
		ledgerHash: "c".repeat(64),
		blueprintHash: "d".repeat(64),
		ledger: {
			version: "local-story-corpus-v1",
			summaries: ["A process starts and completes."],
			coveredRefs: ["s0", "s1"],
			events: [
				{
					id: "action",
					label: "Memory overwrite is in progress",
					role: "ACTION",
					refs: ["s0"],
					quotes: [{ ref: "s0", quote: "Memory overwrite in progress" }],
					subjects: [],
					uncertainty: "",
				},
				{
					id: "complete",
					label: "The progress reaches 100%",
					role: "OUTCOME",
					refs: ["s1"],
					quotes: [{ ref: "s1", quote: "The progress reaches 100%" }],
					subjects: [],
					uncertainty: "",
				},
			],
		},
		blueprint: {
			mode: "THEME",
			message: "Memory overwrite complete. 100%",
			uncertainty: "",
			beats: [
				{
					id: "beat",
					role: "OUTCOME",
					eventIds: ["action", "complete"],
					requires: [],
				},
			],
		},
		selection: {
			selectedBeatIds: ["beat"],
			selectedEventIds: ["action"],
			reason: "COMPLETE_BEATS",
		},
		inputCoverage: {
			totalShots: 2,
			eligibleShots: 2,
			processedShots: 2,
			excludedShots: 0,
			truncated: false,
		},
	};
}

it("describes the actually chosen event instead of an unselected completion claim", () => {
	renderLocalized(<LocalStoryRationale evidence={fixture()} />);
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
