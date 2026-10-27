import { defaultManifestSelection } from "../plan/default-manifest-selection";
import { outputFilePath, outputStorageKeys } from "../plan/output-files";
import {
	AUDIO_CODECS,
	type EncodingPlan,
	type PlanRendition,
} from "../plan/schema";
import {
	type ExpectedHlsWriterResource,
	expectedHlsWriterResource,
} from "./manifest-tracks";

type Kind = "video" | "audio" | "text";
export type DefaultHlsTrack = {
	renditionKey: string;
	kind: Kind;
	codec: PlanRendition["codec"];
	height?: number;
	width?: number;
	bitrate?: number;
	language?: string;
	perTitle: boolean;
	mode?: Extract<PlanRendition, { mode: string }>["mode"];
	resources: ExpectedHlsWriterResource[];
	textResources?: {
		outputKeys: string[];
		directory: string;
		filename: string;
	}[];
};
export type DefaultHlsSelection = {
	encodingKey: string;
	tracks: DefaultHlsTrack[];
	counts: Record<Kind, { min: number; max?: number }>;
	perTitleSelection: { renditionKey: string; optional?: true }[];
	unverified: string[];
};

/** The Default API chooses playlist identities; only the selected encoding's media is known. */
export function defaultHlsSelection(plan: EncodingPlan): DefaultHlsSelection {
	const selected = defaultManifestSelection(plan);
	const result: DefaultHlsSelection = {
		encodingKey: selected.encodingKey,
		tracks: [],
		counts: {
			video: { min: 0, max: 0 },
			audio: { min: 0, max: 0 },
			text: { min: 0, max: 0 },
		},
		perTitleSelection: [],
		unverified: [],
	};
	for (const rendition of selected.renditions) {
		const kind: Kind = AUDIO_CODECS.has(rendition.codec)
			? "audio"
			: rendition.codec === "WEBVTT" || rendition.codec === "IMSC"
				? "text"
				: "video";
		const muxings = plan.muxings.filter(
			(muxing) =>
				muxing.streamKey === rendition.key &&
				(kind === "text"
					? rendition.codec === "WEBVTT" &&
						["TEXT", "CHUNKED_TEXT"].includes(muxing.kind)
					: ["FMP4", "TS", "MP4"].includes(muxing.kind)),
		);
		const resources = muxings.flatMap((muxing) => {
			const clear = expectedHlsWriterResource(plan, muxing.key);
			return [
				...(clear ? [clear] : []),
				...plan.drm
					.filter((drm) => drm.muxingKey === muxing.key)
					.flatMap((drm) => {
						const resource = expectedHlsWriterResource(
							plan,
							muxing.key,
							drm.key,
						);
						return resource ? [resource] : [];
					}),
			];
		});
		const textResources = muxings.flatMap((muxing) => {
			if (
				(muxing.kind !== "TEXT" && muxing.kind !== "CHUNKED_TEXT") ||
				!muxing.destination
			)
				return [];
			const directory = outputFilePath(muxing.destination.path, "");
			const targets = outputStorageKeys(plan, muxing.destination.outputKey);
			return [
				{
					outputKeys: plan.outputs
						.filter((output) =>
							[
								...outputStorageKeys({ outputs: plan.outputs }, output.key),
							].some((key) => targets.has(key)),
						)
						.map((output) => output.key),
					directory: directory ? `${directory}/` : "",
					filename:
						muxing.kind === "TEXT" ? muxing.filename : muxing.segmentNaming,
				},
			];
		});
		const candidates =
			kind === "text" ? textResources.length : resources.length;
		if (!candidates) continue;
		const perTitle =
			"mode" in rendition && rendition.mode.startsWith("PER_TITLE");
		const flexible =
			"mode" in rendition && rendition.mode === "PER_TITLE_TEMPLATE";
		result.tracks.push({
			renditionKey: rendition.key,
			kind,
			codec: rendition.codec,
			perTitle,
			...("mode" in rendition ? { mode: rendition.mode } : {}),
			resources,
			...(textResources.length ? { textResources } : {}),
			...("height" in rendition && rendition.height != null
				? { height: rendition.height }
				: {}),
			...("width" in rendition && rendition.width != null
				? { width: rendition.width }
				: {}),
			...("bitrate" in rendition && rendition.bitrate != null
				? { bitrate: rendition.bitrate }
				: {}),
			...("language" in rendition && rendition.language
				? { language: rendition.language }
				: {}),
		});
		if (!flexible) result.counts[kind].min++;
		if (perTitle) {
			delete result.counts[kind].max;
			result.perTitleSelection.push({
				renditionKey: rendition.key,
				...(flexible ? { optional: true } : {}),
			});
		} else if (result.counts[kind].max !== undefined)
			result.counts[kind].max += candidates;
		if (candidates > 1)
			result.unverified.push(
				`Default selection for ${rendition.key} has multiple compatible containers or encryption outputs`,
			);
	}
	if (result.tracks.some((track) => track.kind === "video"))
		result.counts.video.min = Math.max(1, result.counts.video.min);
	return result;
}
