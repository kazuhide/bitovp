import type { StoryEvidence } from "@bitovp/core";

/** Authored UI evidence only; no provider or model execution is represented. */
export function storyEvidenceFixture(): StoryEvidence {
	return {
		version: "aisa-story-evidence-v1",
		method: "MODEL_EVENT_GRAPH",
		model: {
			version: "aisa-story-model-v1",
			provider: "CODEX_CLI",
			model: "gpt-6.1-sol",
			promptVersion: "aisa-story-prompt-v1",
			schemaHash: "a".repeat(64),
			configId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		},
		inputHash: "b".repeat(64),
		artifactHash: "c".repeat(64),
		graph: {
			version: "aisa-story-graph-v1",
			summary: "A rabbit tests a bow, then watches the arrow land.",
			keyEntities: [
				{
					id: "rabbit",
					label: "Rabbit",
					kind: "CHARACTER",
					refs: ["i0", "i1"],
				},
				{
					id: "bow",
					label: "Bow and arrow",
					kind: "OBJECT",
					refs: ["i0", "i1"],
				},
			],
			events: [
				{
					id: "prepares",
					label: "The rabbit prepares the bow",
					role: "SETUP",
					entityIds: ["rabbit", "bow"],
					evidence: [
						{ ref: "i0", quote: "A rabbit holds a bow and aims at a tree." },
					],
					dependsOn: [],
					importance: 4,
				},
				{
					id: "releases",
					label: "The rabbit releases the arrow",
					role: "CHANGE",
					entityIds: ["rabbit", "bow"],
					evidence: [{ ref: "i1", quote: "The rabbit releases the arrow." }],
					dependsOn: ["prepares"],
					importance: 5,
				},
				{
					id: "result",
					label: "The arrow lands in the tree",
					role: "OUTCOME",
					entityIds: ["rabbit", "bow"],
					evidence: [
						{
							ref: "i2",
							quote: "The arrow lands in the tree as the rabbit watches.",
						},
					],
					dependsOn: ["releases"],
					importance: 5,
				},
			],
			arcs: [
				{
					id: "practice",
					title: "The first attempt",
					eventIds: ["prepares", "releases", "result"],
				},
			],
		},
		selection: {
			selectedArcId: "practice",
			selectedEventIds: ["prepares", "releases", "result"],
			reason: "CONNECTED_ARC",
		},
		inputCoverage: {
			totalIntervals: 3,
			includedIntervals: 3,
			truncated: false,
		},
	};
}
