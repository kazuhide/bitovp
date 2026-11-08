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
