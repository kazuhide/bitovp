"use client";

import {
	DEFAULT_VOD_INPUT_PREVIEW_DURATION_MS,
	MAX_VOD_INPUT_PREVIEW_DURATION_MS,
	type VodInputPreviewRequest,
	type VodInputTimelineDocument,
	type VodInputTimelineSource,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineV2Document,
	vodInputTimelineSourceSchema,
} from "@bitovp/core/vod-input-timeline";
import { useMemo } from "react";
import type { WizardInputFile } from "../build-plan";
import {
	normalizeTimeline,
	timelineDuration,
	timelineProblem,
} from "./timeline-state";
import { usePreviewTask } from "./use-preview-task";

const noFacts: VodInputTimelineSourceFacts[] = [];

export function useInputTimelinePreview({
	document,
	sources,
	sourceKey,
	anchorMs,
	whole,
	disabled,
}: {
	document: VodInputTimelineDocument;
	sources: WizardInputFile[];
	sourceKey: string | null;
	anchorMs: number;
	whole: boolean;
	disabled: boolean;
}) {
	const references: VodInputTimelineSource[] = [];
	for (const source of sources) {
		const parsed = vodInputTimelineSourceSchema.safeParse({
			key: source.key,
			credentialId: source.credentialId,
			bucket: source.bucket,
			objectKey: source.path,
		});
		if (parsed.success) references.push(parsed.data);
	}
	const probe = usePreviewTask(
		!disabled && references.length
			? { kind: "PROBE", sources: references }
			: null,
		{ debounceMs: 100 },
	);
	const result = probe.ready?.result?.sources ?? noFacts;
	const matching =
		!!probe.ready &&
		result.length === references.length &&
		new Set(result.map((source) => source.key)).size === references.length &&
		references.every((source) =>
			result.some((fact) => fact.key === source.key),
		);
	const facts = matching ? result : noFacts;
	const probeError =
		probe.error ?? (probe.ready && !matching ? "invalidResponse" : null);
	const problem = timelineProblem(document, facts);
	const source = sourceKey
		? facts.find((item) => item.key === sourceKey)
		: null;
	const sourceDocument = useMemo<VodInputTimelineV2Document | null>(() => {
		if (!source) return null;
		const id = crypto.randomUUID();
		const clip = {
			id: crypto.randomUUID(),
			sourceKey: source.key,
			startMs: 0,
			inMs: 0,
		};
		return {
			schemaVersion: 2,
			id,
			audioEnabled: source.audio !== null,
			durationMs: source.durationMs,
			videoClips: source.video
				? [{ ...clip, outMs: source.video.durationMs ?? source.durationMs }]
				: [],
			audioClips: source.audio
				? [{ ...clip, outMs: source.audio.durationMs ?? source.durationMs }]
				: [],
		};
	}, [source]);
	const previewDocument = sourceKey
		? sourceDocument
		: !problem
			? normalizeTimeline(document)
			: null;
	const durationMs = previewDocument ? timelineDuration(previewDocument) : 0;
	const fullAllowed =
		durationMs > 0 && durationMs <= MAX_VOD_INPUT_PREVIEW_DURATION_MS;
	const length =
		whole && fullAllowed
			? durationMs
			: Math.min(DEFAULT_VOD_INPUT_PREVIEW_DURATION_MS, durationMs);
	const startMs =
		whole && fullAllowed
			? 0
			: Math.max(0, Math.min(Math.round(anchorMs), durationMs - length));
	const request: VodInputPreviewRequest | null =
		!disabled && probe.ready && previewDocument && length > 0
			? {
					kind: "PREVIEW",
					probeId: probe.ready.id,
					document: previewDocument,
					range: { startMs, durationMs: length },
				}
			: null;
	const preview = usePreviewTask(request);
	return {
		probe,
		preview,
		facts,
		probeError,
		problem,
		fullAllowed,
		ready: matching && !problem && !probeError,
		probeId: matching ? (probe.ready?.id ?? null) : null,
	};
}
