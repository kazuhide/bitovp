import { MAX_VOD_TIMELINE_SOURCES } from "../vod-input-timeline/contracts";
import type { VodInputFavoriteWire } from "../vod-input-timeline/favorites";
import type { WizardFilter, WizardInputFile, WizardState } from "./build-plan";

/** Import a value snapshot. A later registry edit never updates project inputs. */
export function applyVodInputFavorite(
	state: WizardState,
	favorite: VodInputFavoriteWire,
	nextKey: () => string,
): { state: WizardState; sourceKey: string; usage: "MEDIA" | "LOGO" } {
	if (favorite.availability !== "AVAILABLE" || !favorite.inputKind)
		throw new Error("FAVORITE_UNAVAILABLE");
	const image = favorite.kind === "IMAGE";
	if (
		image &&
		(!state.videos.length ||
			!state.inputFiles.some(
				(file) => file.path && file.purpose !== "FILTER_IMAGE",
			))
	)
		throw new Error("LOGO_NEEDS_VIDEO");
	const existing = state.inputFiles.find(
		(file) =>
			file.credentialId === favorite.credentialId &&
			file.bucket === favorite.bucket &&
			file.path === favorite.objectKey &&
			file.kind === favorite.inputKind &&
			(file.purpose === "FILTER_IMAGE") === image,
	);
	const empty = !image
		? state.inputFiles.find(
				(candidate) => !candidate.path && candidate.purpose !== "FILTER_IMAGE",
			)
		: undefined;
	if (
		!image &&
		!existing &&
		state.inputFiles.filter(
			(candidate) => candidate.path && candidate.purpose !== "FILTER_IMAGE",
		).length >= MAX_VOD_TIMELINE_SOURCES
	)
		throw new Error("FAVORITE_SOURCE_LIMIT");
	const inputKey =
		existing?.inputKey ??
		state.inputFiles.find(
			(file) =>
				file.credentialId === favorite.credentialId &&
				file.bucket === favorite.bucket &&
				file.kind === favorite.inputKind,
		)?.inputKey;
	const file: WizardInputFile = existing ?? {
		key: empty?.key ?? `fav_source_${nextKey()}`,
		inputKey: inputKey ?? empty?.inputKey ?? `fav_input_${nextKey()}`,
		kind: favorite.inputKind,
		credentialId: favorite.credentialId,
		bucket: favorite.bucket,
		path: favorite.objectKey,
		name: favorite.label,
		...(image ? { purpose: "FILTER_IMAGE" as const } : {}),
	};
	const inputFiles = existing
		? state.inputFiles
		: empty
			? state.inputFiles.map((candidate) =>
					candidate === empty ? file : candidate,
				)
			: [...state.inputFiles, file];
	if (!image)
		return {
			state: existing ? state : { ...state, inputFiles },
			sourceKey: file.key,
			usage: "MEDIA",
		};
	const prior = state.filters?.find(
		(filter) =>
			filter.kind === "WATERMARK" &&
			filter.inputKey === file.inputKey &&
			filter.imagePath === file.path,
	);
	const filter: WizardFilter = prior ?? {
		key: `fav_filter_${nextKey()}`,
		kind: "WATERMARK",
		inputKey: file.inputKey,
		imagePath: file.path,
		left: 0,
		top: 0,
	};
	return {
		state: {
			...state,
			inputFiles,
			filters: prior ? state.filters : [...(state.filters ?? []), filter],
			videos: state.videos.map((video) => {
				const attachments = video.extras?.filters ?? [];
				if (attachments.some((item) => item.filterKey === filter.key))
					return video;
				return {
					...video,
					extras: {
						...video.extras,
						filters: [
							...attachments,
							{
								filterKey: filter.key,
								position:
									Math.max(-1, ...attachments.map((item) => item.position)) + 1,
							},
						],
					},
				};
			}),
		},
		sourceKey: file.key,
		usage: "LOGO",
	};
}
