import {
	type CompositionDocument,
	hashEditingEvidence,
	isCompositionCaptionSourceEvidenceCurrent,
	type LocalCaptionCueContext,
	type SceneAnalysisDocument,
} from "@bitovp/core";

/** Context follows current source spans, never the output timeline's neighbouring scene. */
export function buildLocalCaptionSceneContexts(input: {
	document: CompositionDocument;
	analysis: SceneAnalysisDocument | undefined;
	mediaVersionId: string;
	timeMapId: string;
}): Map<string, LocalCaptionCueContext> {
	const result = new Map<string, LocalCaptionCueContext>();
	for (const caption of input.document.captions ?? []) {
		const current = isCompositionCaptionSourceEvidenceCurrent(
			caption,
			input.document,
		);
		const ids =
			current && caption.sourceEvidence
				? caption.sourceEvidence.spans.map((s) => s.clipId)
				: !caption.sourceEvidence && caption.anchorClipId
					? [caption.anchorClipId]
					: [];
		const clips = [...new Set(ids)].flatMap((id) => {
			const clip = input.document.clips.find((c) => c.id === id);
			const timeMapId =
				input.mediaVersionId === input.document.mediaVersionId
					? input.document.timeMapId
					: input.document.sources?.find(
							(s) => s.mediaVersionId === input.mediaVersionId,
						)?.timeMapId;
			return clip &&
				(clip.mediaVersionId ?? input.document.mediaVersionId) ===
					input.mediaVersionId &&
				timeMapId === input.timeMapId
				? [clip]
				: [];
		});
		const fields: LocalCaptionCueContext["fields"] = [],
			scopes: { sceneId: string; shotIndex?: number; sourceHash: string }[] =
				[];
		for (const clip of clips) {
			const scene = input.analysis?.scenes.find(
				(s) => s.id === clip.evidence?.sceneId,
			);
			if (
				!scene ||
				scene.endInSeconds * 1e6 <= clip.sourceInUs ||
				scene.startInSeconds * 1e6 >=
					clip.sourceInUs + (clip.durationFrames * 1e6) / 30
			)
				continue;
			scopes.push({
				sceneId: scene.id,
				shotIndex: clip.evidence?.shotIndex,
				sourceHash: hashEditingEvidence(scene),
			});
			const add = (
				kind: "SCENE" | "SHOT" | "CHARACTER",
				pointer: string,
				text: string,
			) => {
				if (text.trim())
					fields.push({
						kind,
						text,
						sourceHash: hashEditingEvidence({
							sceneId: scene.id,
							pointer,
							text,
						}),
					});
			};
			add("SCENE", "title", scene.title);
			for (const [index, person] of (scene.content?.characters ?? []).entries())
				add("CHARACTER", `characters/${index}/name`, person.name);
			const shot =
				clip.evidence?.shotIndex === undefined
					? undefined
					: scene.shots[clip.evidence.shotIndex];
			if (shot)
				add(
					"SHOT",
					`shots/${clip.evidence?.shotIndex}`,
					shot.detailedDescription,
				);
			add("SCENE", "summary", scene.summary);
		}
		result.set(caption.id, {
			sourceHash: hashEditingEvidence({
				caption: {
					id: caption.id,
					text: caption.text,
					fromFrame: caption.fromFrame,
					toFrame: caption.toFrame,
					anchorClipId: caption.anchorClipId,
					words: caption.words,
					sourceEvidence: caption.sourceEvidence,
				},
				sourceEvidenceCurrent: current,
				clips: clips.map((clip) => ({
					id: clip.id,
					sourceInUs: clip.sourceInUs,
					durationFrames: clip.durationFrames,
					timelineStartFrame: clip.timelineStartFrame,
					mediaVersionId: clip.mediaVersionId,
					evidence: clip.evidence,
				})),
				scopes,
			}),
			scopeHash: hashEditingEvidence(
				scopes.length && scopes.every((s) => s.shotIndex !== undefined)
					? {
							mediaVersionId: input.mediaVersionId,
							timeMapId: input.timeMapId,
							scopes,
						}
					: { unknownContext: caption.id, scopes },
			),
			fields,
		});
	}
	return result;
}
