import type { LocalStoryEvidence } from "@bitovp/core";
import type { EditingProjectView } from "@/lib/library-editing";

export const editingIds = {
	project: "11111111-1111-4111-8111-111111111111",
	media: "22222222-2222-4222-8222-222222222222",
	content: "33333333-3333-4333-8333-333333333333",
	clip: "44444444-4444-4444-8444-444444444444",
	revision: "55555555-5555-4555-8555-555555555555",
	source: "66666666-6666-4666-8666-666666666666",
};
export function editingProjectFixture(): EditingProjectView {
	return {
		id: editingIds.project,
		contentId: editingIds.content,
		title: "Interview highlights",
		variant: "PORTRAIT",
		draftRevision: 1,
		currentRevisionId: null,
		currentRevisionMatchesDraft: false,
		draft: {
			schemaVersion: 1,
			mediaVersionId: editingIds.media,
			analysisRevisionId: null,
			locale: "en",
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			timeMapId: editingIds.media,
			canvas: { width: 1080, height: 1920 },
			fps: { num: 30, den: 1 },
			clips: [
				{
					id: editingIds.clip,
					sourceInUs: 0,
					durationFrames: 300,
					timelineStartFrame: 0,
					framing: [
						{ fromFrame: 0, toFrame: 300, mode: "FIT", origin: "MANUAL" },
					],
					audio: { mode: "SOURCE" },
				},
			],
		},
		media: {
			id: editingIds.media,
			sourceId: editingIds.source,
			state: "READY",
			error: null,
			durationUs: 60_000_000,
			width: 1920,
			height: 1080,
			url: "/api/library/media-versions/example/media",
			timeMap: {
				id: editingIds.media,
				mediaVersionId: editingIds.media,
				kind: "CFR",
				sourceStartUs: 0,
				sourceEndUs: 60_000_000,
				editingStartFrame: 0,
				editingEndFrame: 1800,
				fps: { num: 30, den: 1 },
			},
		},
		analysis: null,
		renders: [],
	};
}

/** Authored UI history: role mismatch deliberately represents a pre-fix draft. */
export function localStoryEvidenceFixture(): LocalStoryEvidence {
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
