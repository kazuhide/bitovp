import { AUDIO_CODECS } from "./schema";

type SelectionSource = {
	encodings?: readonly { key: string }[];
	renditions: readonly { key: string; encodingKey?: string }[];
};

/** Default manifests without explicit periods select the first rendition's resolved encoding. */
export function defaultManifestSelection<T extends SelectionSource>(plan: T) {
	const fallback = plan.encodings?.[0]?.key ?? "default";
	const encodingKey = plan.renditions[0]?.encodingKey ?? fallback;
	return {
		encodingKey,
		renditions: plan.renditions.filter(
			(row) => (row.encodingKey ?? fallback) === encodingKey,
		) as T["renditions"][number][],
	};
}

type ManualSelectionSource = SelectionSource & {
	renditions: readonly {
		key: string;
		codec: string;
		encodingKey?: string;
		hlsVariantUri?: string;
		hlsVariantLabel?: string;
		hlsMedia?: unknown;
		label?: string;
		groupId?: string;
		uri?: string;
	}[];
	muxings: readonly { streamKey: string; kind: string }[];
	manifests?: readonly {
		key: string;
		kind: string;
		generationMode?: string;
		videoMuxingKind?: string;
		audioMuxingKind?: string;
	}[];
};

/** Keep shared manual values only when a manual HLS manifest actually consumes their track. */
export function defaultHlsManualSelectors(
	plan: ManualSelectionSource,
	changingManifestKey?: string,
) {
	const manual = (plan.manifests ?? []).filter(
		(row) =>
			row.kind === "HLS" &&
			row.generationMode !== "DEFAULT" &&
			row.key !== changingManifestKey,
	);
	return defaultManifestSelection(plan).renditions.flatMap((rendition) => {
		const usedByManual = manual.some((manifest) =>
			plan.muxings.some((muxing) => {
				if (
					muxing.streamKey !== rendition.key ||
					!["FMP4", "MP4", "TS", "TEXT", "CHUNKED_TEXT"].includes(muxing.kind)
				)
					return false;
				if (rendition.codec === "WEBVTT")
					return ["TEXT", "CHUNKED_TEXT"].includes(muxing.kind);
				const pin = AUDIO_CODECS.has(rendition.codec)
					? manifest.audioMuxingKind
					: manifest.videoMuxingKind;
				return pin === undefined || pin === muxing.kind;
			}),
		);
		const identities = (
			["hlsVariantUri", "hlsVariantLabel", "hlsMedia"] as const
		).flatMap((field) =>
			rendition[field] === undefined
				? []
				: [{ renditionKey: rendition.key, field, usedByManual }],
		);
		const subtitles =
			rendition.codec === "WEBVTT"
				? (
						[
							["label", "english - sample"],
							["groupId", "SUBTITLE"],
							["uri", "subtitles_en.m3u8"],
						] as const
					).flatMap(([field, fallback]) =>
						rendition[field] === undefined || rendition[field] === fallback
							? []
							: [{ renditionKey: rendition.key, field, usedByManual }],
					)
				: [];
		return [...identities, ...subtitles];
	});
}
