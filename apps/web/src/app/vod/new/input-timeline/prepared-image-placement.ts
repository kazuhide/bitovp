import {
	appendVodInputTimelineSource,
	MAX_VOD_TIMELINE_SOURCES,
	overwriteVodInputTimelineTrack,
	type VodInputPreviewResult,
	type VodInputTimelineSourceFacts,
	type VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import type { WizardInputFile } from "../build-plan";

export type PreparedImage = NonNullable<VodInputPreviewResult["prepared"]>;
export type ImagePlacement = { mode: "append" | "overwrite"; atMs: number };
export function buildPreparedImagePlacement(
	document: VodInputTimelineV2Document,
	prepared: PreparedImage,
	placement: ImagePlacement,
	facts: VodInputTimelineSourceFacts[],
	nextId: () => string,
) {
	const id = nextId();
	const evidence = [
		...facts.filter((item) => item.key !== prepared.facts.key),
		prepared.facts,
	];
	const startMs =
		placement.mode === "append" ? document.durationMs : placement.atMs;
	const range = {
		sourceKey: prepared.source.key,
		inMs: 0,
		outMs: prepared.requestedDurationMs,
		id,
	};
	const next =
		placement.mode === "append"
			? appendVodInputTimelineSource(
					document,
					{ ...range, target: "both" },
					evidence,
				)
			: overwriteVodInputTimelineTrack(
					document,
					{ ...range, track: "video", atMs: startMs, splitId: nextId() },
					evidence,
				);
	return { document: next, id, startMs };
}

export function preparedImageFile(
	sources: WizardInputFile[],
	prepared: PreparedImage,
	kind: WizardInputFile["kind"],
	label: string,
): WizardInputFile {
	if (sources.some((source) => source.key === prepared.source.key))
		throw new Error("IMAGE_SOURCE_CONFLICT");
	if (
		sources.filter((source) => source.path && source.purpose !== "FILTER_IMAGE")
			.length >= MAX_VOD_TIMELINE_SOURCES
	)
		throw new Error("FAVORITE_SOURCE_LIMIT");
	const shared = sources.find(
		(source) =>
			source.kind === kind &&
			source.credentialId === prepared.source.credentialId &&
			source.bucket === prepared.source.bucket,
	);
	return {
		key: prepared.source.key,
		inputKey: shared?.inputKey ?? prepared.source.key,
		kind,
		credentialId: prepared.source.credentialId,
		bucket: prepared.source.bucket,
		path: prepared.source.objectKey,
		displayName: label,
	};
}

/** Reuse the initial empty slot without leaving a credential-less main input behind. */
export function importPreparedImageFile(
	sources: WizardInputFile[],
	file: WizardInputFile,
) {
	const empty = sources.findIndex(
		(source) => !source.path && !source.credentialId,
	);
	return empty < 0
		? [...sources, file]
		: sources.map((source, index) => (index === empty ? file : source));
}
