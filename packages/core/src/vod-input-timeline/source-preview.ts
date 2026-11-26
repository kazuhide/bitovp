import {
	type VodInputPreviewRequest,
	type VodInputTimelinePlacedClip,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineV2Document,
	vodInputPreviewRequestSchema,
	vodInputTimelineV2DocumentSchema,
} from "./contracts";
import { type VodInputTimelineIssue, validateVodInputTimeline } from "./model";

export type VodInputSourcePreviewIds = {
	documentId: string;
	clipId: string;
};

/** Preserve a source's natural stream lengths, including audio beyond video. */
export function buildVodInputSourcePreviewDocument(
	source: VodInputTimelineSourceFacts,
	ids: VodInputSourcePreviewIds,
): VodInputTimelineV2Document {
	const clip = {
		id: ids.clipId,
		sourceKey: source.key,
		startMs: 0,
		inMs: 0,
	};
	return vodInputTimelineV2DocumentSchema.parse({
		schemaVersion: 2,
		id: ids.documentId,
		audioEnabled: source.audio !== null,
		durationMs: Math.max(
			source.durationMs,
			source.video?.durationMs ?? 0,
			source.audio?.durationMs ?? 0,
		),
		videoClips: source.video
			? [{ ...clip, outMs: source.video.durationMs ?? source.durationMs }]
			: [],
		audioClips: source.audio
			? [{ ...clip, outMs: source.audio.durationMs ?? source.durationMs }]
			: [],
	});
}

function sameNaturalTrack(
	actual: VodInputTimelinePlacedClip[],
	expected: VodInputTimelinePlacedClip[],
): boolean {
	return (
		actual.length === expected.length &&
		actual.every((clip, index) => {
			const natural = expected[index];
			return (
				natural !== undefined &&
				clip.sourceKey === natural.sourceKey &&
				clip.startMs === natural.startMs &&
				clip.inMs === natural.inMs &&
				clip.outMs === natural.outMs
			);
		})
	);
}

/** Only unedited source audition may exceed native concatenation's gap limit. */
export function validateVodInputPreview(
	request: Extract<VodInputPreviewRequest, { kind: "PREVIEW" }>,
	facts: readonly VodInputTimelineSourceFacts[],
): VodInputTimelineIssue[] {
	if (request.sourcePreviewKey === undefined)
		return validateVodInputTimeline(request.document, facts);

	// IDs and placement/caps remain subject to the full wire schema even though
	// natural-source comparison deliberately ignores UUID identity.
	const parsed = vodInputPreviewRequestSchema.safeParse(request);
	if (!parsed.success || parsed.data.kind !== "PREVIEW")
		return [{ code: "SOURCE_PREVIEW_INVALID" }];
	const input = parsed.data;
	const issues = validateVodInputTimeline(input.document, facts);
	const invalid: VodInputTimelineIssue = { code: "SOURCE_PREVIEW_INVALID" };
	const source = facts.find((fact) => fact.key === input.sourcePreviewKey);
	if (!source || input.document.schemaVersion !== 2)
		return [invalid, ...issues];
	const document = input.document;
	const natural = buildVodInputSourcePreviewDocument(source, {
		documentId: document.id,
		clipId: document.id,
	});
	if (
		document.durationMs !== natural.durationMs ||
		document.audioEnabled !== natural.audioEnabled ||
		!sameNaturalTrack(document.videoClips, natural.videoClips) ||
		!sameNaturalTrack(document.audioClips, natural.audioClips)
	)
		return [invalid, ...issues];
	return issues.filter((issue) => issue.code !== "TIMELINE_GAP_TOO_LONG");
}
