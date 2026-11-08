import { toCompositionDocument } from "./composition-schema";

export const compositionIds = {
	media: "11111111-1111-4111-8111-111111111111",
	map: "22222222-2222-4222-8222-222222222222",
	clip: "33333333-3333-4333-8333-333333333333",
	other: "44444444-4444-4444-8444-444444444444",
	otherMap: "55555555-5555-4555-8555-555555555555",
	item: "66666666-6666-4666-8666-666666666666",
};
export function compositionFixture() {
	const document = toCompositionDocument({
		schemaVersion: 1,
		mediaVersionId: compositionIds.media,
		timeMapId: compositionIds.map,
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: compositionIds.clip,
				sourceInUs: 1_033_334,
				durationFrames: 90,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 90, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "SOURCE" },
			},
		],
	});
	const source = {
		mediaVersionId: compositionIds.media,
		width: 1920,
		height: 1080,
		hasAudio: true,
		timeMap: {
			id: compositionIds.map,
			mediaVersionId: compositionIds.media,
			kind: "CFR" as const,
			sourceStartUs: 1_000_000,
			sourceEndUs: 11_000_000,
			editingStartFrame: 90,
			editingEndFrame: 390,
			fps: { num: 30 as const, den: 1 as const },
		},
	};
	return { document, source };
}
