import { dashAudioLegSelected, dashVideoLegSelected } from "./dash-legs";
import { defaultHlsManualSelectors } from "./default-manifest-selection";
import { hlsLegSelected } from "./hls-legs";
import {
	hlsAudioLegsByRendition,
	hlsChildEntries,
	hlsSubtitleGroups,
} from "./hls-media-defaults";
import {
	additionalPlaylistWriterIssues,
	manifestMediaReachable,
} from "./manifest-reference-validation";
import {
	staticManifestOutputFiles,
	staticMuxingOutputFiles,
} from "./output-files";
import type { EncodingPlan } from "./schema";
import { AUDIO_CODECS } from "./schema";
import type { PlanIssue } from "./validate";

export function validateManifestDetails(plan: EncodingPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	issues.push(
		...additionalPlaylistWriterIssues(
			plan,
			[
				...staticManifestOutputFiles(plan),
				...staticMuxingOutputFiles(plan),
				...plan.manifests.flatMap((manifest, mi) =>
					manifest.kind === "HLS"
						? hlsChildEntries(plan, manifest).map((entry) => ({
								destination: manifest.destination,
								filename: entry.uri,
								owner: `manifest:${manifest.key}:child:${entry.muxingKey}:${entry.uri}`,
								path: `manifests[${mi}]`,
							}))
						: [],
				),
			],
			plan.manifests.flatMap((manifest, mi) =>
				manifest.kind === "HLS"
					? (manifest.detailed?.additionalMedia ?? []).flatMap((media, ri) =>
							media.type === "CLOSED_CAPTIONS"
								? []
								: [
										{
											destination: manifest.destination,
											filename: media.uri,
											owner: `manifest:${manifest.key}:additional:${ri}`,
											path: `manifests[${mi}].detailed.additionalMedia[${ri}].uri`,
										},
									],
						)
					: [],
			),
		),
	);

	const error = (path: string, message: string) =>
		issues.push({
			level: "error",
			code: "PLAN_MANIFEST_DETAIL_INVALID",
			path,
			message,
		});
	const muxings = new Map(plan.muxings.map((m) => [m.key, m]));
	const keyframes = new Set(plan.keyframes.map((k) => k.key));
	const renditionFor = (muxingKey: string) =>
		plan.renditions.find((r) => r.key === muxings.get(muxingKey)?.streamKey);
	const encodingOf = (encodingKey?: string) =>
		encodingKey ?? plan.encodings?.[0]?.key ?? "default";
	const keyframeOwner = (key: string, muxingKey: string, path: string) => {
		const frame = plan.keyframes.find((k) => k.key === key);
		const rendition = renditionFor(muxingKey);
		if (
			frame &&
			rendition &&
			encodingOf(frame.encodingKey) !== encodingOf(rendition.encodingKey)
		)
			error(
				path,
				"The keyframe must belong to the same encoding as the selected muxing",
			);
	};
	const sprites = new Set(plan.sprites.map((s) => s.key));
	const encodings = new Set(plan.encodings?.map((e) => e.key) ?? ["default"]);
	const range = (
		value: {
			startSegmentNumber?: number;
			endSegmentNumber?: number;
			startKeyframeKey?: string;
			endKeyframeKey?: string;
		},
		path: string,
	) => {
		if (
			value.startSegmentNumber !== undefined &&
			value.endSegmentNumber !== undefined &&
			value.startSegmentNumber > value.endSegmentNumber
		)
			error(path, "The final segment must not precede the first segment");
		for (const field of ["startKeyframeKey", "endKeyframeKey"] as const)
			if (value[field] && !keyframes.has(value[field]))
				error(`${path}.${field}`, `Unknown keyframe ${value[field]}`);
	};
	for (const [index, muxing] of plan.muxings.entries())
		if (muxing.kind === "WEBM" && muxing.progressive) {
			const rendition = renditionFor(muxing.key);
			if (!muxing.destination)
				error(
					`muxings[${index}].destination`,
					"Progressive WebM requires an output destination",
				);
			if (rendition && "mode" in rendition && rendition.mode !== "STANDARD")
				error(
					`muxings[${index}]`,
					"Progressive WebM requires a standard video stream",
				);
			if (plan.drm.some((drm) => drm.muxingKey === muxing.key))
				error(
					`muxings[${index}]`,
					"Progressive WebM encryption is not supported by this output path",
				);
			if (muxing.filename && !/^[^/\\?#]+\.webm$/i.test(muxing.filename))
				error(
					`muxings[${index}].filename`,
					"Use a WebM filename without directories or URL suffixes",
				);
		}
	for (const [index, manifest] of plan.manifests.entries()) {
		if (manifest.kind === "SMOOTH") continue;
		const path = `manifests[${index}]`;
		if (manifest.generationMode === "DEFAULT") {
			if (manifest.kind === "HLS")
				for (const selector of defaultHlsManualSelectors(plan)) {
					const renditionIndex = plan.renditions.findIndex(
						(row) => row.key === selector.renditionKey,
					);
					if (!selector.usedByManual)
						error(
							`renditions[${renditionIndex}].${selector.field}`,
							"Default HLS chooses playlist names and media groups. Remove this unused manual HLS setting or use manual generation; saved values are not discarded automatically",
						);
				}
			if (plan.generation.timing !== "POST_ENCODING")
				error(
					`${path}.generationMode`,
					"Default manifests must be generated after encoding (POST_ENCODING)",
				);
			if (
				manifest.kind === "HLS" &&
				manifest.detailed &&
				[
					manifest.detailed.additionalMedia,
					manifest.detailed.audioMedia,
					manifest.detailed.subtitleMedia,
					manifest.detailed.streams,
					manifest.detailed.streamCustomTags,
					manifest.detailed.mediaCustomTags,
				].some((x) => x !== undefined)
			)
				error(
					`${path}.detailed`,
					"Default HLS supports global options; media, variants and tags require manual generation",
				);
			if (
				manifest.kind === "DASH" &&
				manifest.detailed &&
				[
					manifest.detailed.period,
					manifest.detailed.videoAdaptationSet,
					manifest.detailed.audioAdaptationSet,
					manifest.detailed.subtitleAdaptationSet,
					manifest.detailed.representations,
					manifest.detailed.additionalRepresentations,
				].some((x) => x !== undefined)
			)
				error(
					`${path}.detailed`,
					"Default DASH uses defaultPeriods; manual period, adaptation and representation options require manual generation",
				);
			if (
				manifest.kind === "HLS" &&
				(manifest.audioGroupId !== "audio" ||
					manifest.audioLanguage !== "en" ||
					manifest.closedCaptions !== "NONE" ||
					manifest.videoMuxingKind ||
					manifest.audioMuxingKind ||
					manifest.audioMediaUri ||
					manifest.perTitleVariantUri !== "AVG_BITRATE" ||
					manifest.drmKind ||
					manifest.variantsPerAudioGroup ||
					manifest.iframePlaylists ||
					manifest.audioVariantStreams)
			)
				error(
					path,
					"Default HLS selects its own tracks; use manual generation for media and variant settings",
				);
			if (
				manifest.kind === "DASH" &&
				(manifest.audioLanguage !== "en" ||
					manifest.representationType !== "TEMPLATE" ||
					manifest.videoMuxingKind ||
					manifest.audioMuxingKind ||
					manifest.drmKind ||
					manifest.adaptationSets?.length)
			)
				error(
					path,
					"Default DASH selects its own tracks; use default period conditions or manual generation for track settings",
				);

			if (manifest.kind === "DASH")
				for (const [pi, period] of (manifest.defaultPeriods ?? []).entries())
					for (const key of period.encodingKeys)
						if (!encodings.has(key))
							error(
								`${path}.defaultPeriods[${pi}].encodingKeys`,
								`Unknown encoding ${key}`,
							);
		} else if (manifest.kind === "DASH" && manifest.defaultPeriods)
			error(
				`${path}.defaultPeriods`,
				"Default periods require DEFAULT generation",
			);
		if (manifest.kind === "HLS") {
			const detail = manifest.detailed;
			if (!detail) continue;
			for (const [field, value] of [
				["audioMedia", detail.audioMedia],
				["subtitleMedia", detail.subtitleMedia],
				["streams", detail.streams],
			] as const)
				if (value) range(value, `${path}.detailed.${field}`);
			const subtitleGroups = new Set([
				...hlsSubtitleGroups(plan),
				...(detail.additionalMedia ?? []).flatMap((media) =>
					media.type === "VTT" ? [media.groupId] : [],
				),
			]);
			if (subtitleGroups.size > 1)
				error(
					`${path}.detailed.additionalMedia`,
					"HLS variants support one subtitle group; use the same groupId for all subtitle languages",
				);
			const videoGroups = new Set(
				detail.additionalMedia
					?.filter((m) => m.type === "VIDEO")
					.map((m) => m.groupId),
			);
			if (detail.streams?.video && !videoGroups.has(detail.streams.video))
				error(
					`${path}.detailed.streams.video`,
					"The variant video group must reference a configured video media group",
				);
			const selectedAudio = hlsAudioLegsByRendition(plan, manifest);
			const audioGroups = new Set(
				plan.renditions
					.filter((r) => selectedAudio.has(r.key))
					.filter((r) => AUDIO_CODECS.has(r.codec))
					.map((r) => r.hlsMedia?.groupId ?? manifest.audioGroupId),
			);
			for (const group of detail.streams?.audioGroups?.groups ?? [])
				if (!audioGroups.has(group.name))
					error(
						`${path}.detailed.streams.audioGroups`,
						`Unknown audio group ${group.name}`,
					);
			for (const [mi, media] of (detail.additionalMedia ?? []).entries()) {
				range(media, `${path}.detailed.additionalMedia[${mi}]`);
				if (media.type !== "VTT") {
					const muxing = muxings.get(media.muxingKey);
					if (!muxing || !["TS", "FMP4", "MP4"].includes(muxing.kind))
						error(
							`${path}.detailed.additionalMedia[${mi}].muxingKey`,
							"HLS media requires a TS, fMP4 or MP4 muxing",
						);
					for (const tag of [
						...(media.customTags ?? []),
						...(detail.mediaCustomTags ?? []),
					])
						if (tag.positionMode === "KEYFRAME")
							keyframeOwner(
								tag.keyframeKey,
								media.muxingKey,
								`${path}.detailed.additionalMedia[${mi}].customTags`,
							);
					const rendition = renditionFor(media.muxingKey);
					if (rendition && AUDIO_CODECS.has(rendition.codec))
						error(
							`${path}.detailed.additionalMedia[${mi}].muxingKey`,
							"Video and closed-caption media require a video container",
						);
					const drm = media.drmKey
						? plan.drm.find((d) => d.key === media.drmKey)
						: manifest.drmKind
							? plan.drm.find(
									(d) =>
										d.muxingKey === media.muxingKey &&
										d.kind === manifest.drmKind,
								)
							: undefined;
					if (
						!manifestMediaReachable(
							plan,
							drm?.destination ?? muxing?.destination,
							manifest.destination,
						)
					)
						error(
							`${path}.detailed.additionalMedia[${mi}]`,
							"The selected media output must be reachable from every manifest output",
						);

					if (!media.drmKey && manifest.drmKind && !drm)
						error(
							`${path}.detailed.additionalMedia[${mi}]`,
							"The selected media has no encryption matching this manifest",
						);
					if (
						media.drmKey &&
						!plan.drm.some(
							(drm) =>
								drm.key === media.drmKey && drm.muxingKey === media.muxingKey,
						)
					)
						error(
							`${path}.detailed.additionalMedia[${mi}].drmKey`,
							"The selected encryption must belong to this muxing",
						);
				}
			}
			const entries = hlsChildEntries(plan, manifest);
			for (const tag of detail.mediaCustomTags ?? [])
				if (tag.positionMode === "KEYFRAME")
					for (const entry of entries.filter(
						(e) => e.kind === "audio" || e.kind === "text",
					))
						keyframeOwner(
							tag.keyframeKey,
							entry.muxingKey,
							`${path}.detailed.mediaCustomTags`,
						);
			const dynamicVideoMuxings = plan.muxings.filter((muxing) => {
				const rendition = renditionFor(muxing.key);
				return (
					rendition &&
					"mode" in rendition &&
					rendition.mode.startsWith("PER_TITLE") &&
					hlsLegSelected(muxing.kind, manifest.videoMuxingKind)
				);
			});
			for (const tag of detail.streamCustomTags ?? [])
				if (tag.positionMode === "KEYFRAME") {
					for (const muxing of dynamicVideoMuxings)
						keyframeOwner(
							tag.keyframeKey,
							muxing.key,
							`${path}.detailed.streamCustomTags`,
						);
					for (const entry of entries.filter(
						(e) =>
							e.kind === "video" ||
							(manifest.audioVariantStreams && e.kind === "audio"),
					))
						keyframeOwner(
							tag.keyframeKey,
							entry.muxingKey,
							`${path}.detailed.streamCustomTags`,
						);
				}
			const tags = [
				...(detail.streamCustomTags ?? []),
				...(detail.mediaCustomTags ?? []),
				...(detail.additionalMedia ?? []).flatMap(
					(media) => media.customTags ?? [],
				),
			];
			for (const tag of tags) {
				if (tag.positionMode === "KEYFRAME" && !keyframes.has(tag.keyframeKey))
					error(
						`${path}.detailed`,
						`Unknown custom tag keyframe ${tag.keyframeKey}`,
					);
				if (
					plan.aiSceneAnalysis?.automaticAdPlacement?.allSceneBoundaries
						?.insertCueTags &&
					/#EXT-X-(?:CUE|DATERANGE)/.test(tag.data)
				)
					error(
						`${path}.detailed`,
						"Custom ad tags cannot be combined with automatic ad marker generation",
					);
				if (!tag.data.startsWith("#") || /[\r\n]/.test(tag.data))
					error(
						`${path}.detailed`,
						"A custom tag must contain one HLS tag line beginning with #",
					);
			}
			continue;
		}
		const detail = manifest.detailed;
		if (!detail) continue;
		const emitted = (key: string) => {
			const muxing = muxings.get(key);
			const rendition = renditionFor(key);
			if (
				!muxing ||
				!rendition ||
				("mode" in rendition && rendition.mode.startsWith("PER_TITLE"))
			)
				return false;
			if (muxing.kind === "CHUNKED_TEXT") return rendition.codec === "WEBVTT";
			if (muxing.kind === "TEXT") return false;
			if (muxing.kind === "WEBM" && muxing.progressive) return false;
			if (
				manifest.adaptationSets?.length &&
				!manifest.adaptationSets.some((set) => set.key === rendition.dashSetKey)
			)
				return false;
			return AUDIO_CODECS.has(rendition.codec)
				? dashAudioLegSelected(
						muxing,
						manifest,
						manifest.profile === "ON_DEMAND",
					)
				: dashVideoLegSelected(
						muxing,
						manifest,
						manifest.profile === "ON_DEMAND",
					);
		};
		const dependencies = new Map<string, string>();
		const overridden = new Set<string>();
		for (const [ri, rep] of (detail.representations ?? []).entries()) {
			const rp = `${path}.detailed.representations[${ri}]`;
			if (overridden.has(rep.muxingKey))
				error(
					`${rp}.muxingKey`,
					"Use only one override for each representation",
				);
			overridden.add(rep.muxingKey);
			const muxing = muxings.get(rep.muxingKey);
			if (!muxing || !emitted(rep.muxingKey))
				error(
					`${rp}.muxingKey`,
					`No static representation for muxing ${rep.muxingKey} is selected by this manifest`,
				);
			const rendition = muxing
				? plan.renditions.find((r) => r.key === muxing.streamKey)
				: undefined;
			if (
				rendition &&
				"mode" in rendition &&
				rendition.mode.startsWith("PER_TITLE")
			)
				error(
					rp,
					"Per-Title creates representation IDs at runtime; per-muxing overrides require standard streams",
				);
			range(rep, rp);
			for (const field of ["startKeyframeKey", "endKeyframeKey"] as const)
				if (rep[field])
					keyframeOwner(rep[field], rep.muxingKey, `${rp}.${field}`);
			if (rep.startKeyframeKey && rep.endKeyframeKey) {
				const start = plan.keyframes.find(
					(k) => k.key === rep.startKeyframeKey,
				);
				const end = plan.keyframes.find((k) => k.key === rep.endKeyframeKey);
				if (start && end && start.time >= end.time)
					error(rp, "The final keyframe must be after the first keyframe");
			}
			if (
				muxing?.kind === "MP4" &&
				[
					rep.startSegmentNumber,
					rep.endSegmentNumber,
					rep.startKeyframeKey,
					rep.endKeyframeKey,
				].some((value) => value !== undefined)
			)
				error(
					rp,
					"Progressive MP4 representations do not support segment or keyframe ranges",
				);
			if (rep.mode && muxing?.kind === "MP4")
				error(
					`${rp}.mode`,
					"Segmented representation mode cannot be set on an MP4 representation",
				);
			if (rep.drmRepresentation) {
				const matches = plan.drm.filter(
					(drm) =>
						drm.muxingKey === rep.muxingKey &&
						(!manifest.drmKind || drm.kind === manifest.drmKind),
				);
				if (matches.length > 1)
					error(
						rp,
						"Select the manifest DRM kind before choosing a DRM representation with multiple encrypted outputs",
					);
				if (
					matches[0] &&
					!manifestMediaReachable(
						plan,
						matches[0].destination,
						manifest.destination,
					)
				)
					error(
						rp,
						"The selected encrypted output must be reachable from every manifest output",
					);
			}
			if (rep.contentProtection && !rep.drmRepresentation && !manifest.drmKind)
				error(
					`${rp}.contentProtection`,
					"Select a manifest DRM kind or an encrypted fMP4 representation before configuring content protection",
				);
			if (rep.drmRepresentation && muxing?.kind !== "FMP4")
				error(
					`${rp}.drmRepresentation`,
					"DRM representation mode requires fMP4",
				);
			if (
				rep.drmRepresentation &&
				!plan.drm.some(
					(drm) =>
						drm.muxingKey === rep.muxingKey &&
						(!manifest.drmKind || drm.kind === manifest.drmKind),
				)
			)
				error(
					rp,
					"DRM representation requires encryption on the selected muxing",
				);
			if (rep.dependencyMuxingKey) {
				if (!emitted(rep.dependencyMuxingKey))
					error(
						`${rp}.dependencyMuxingKey`,
						`No static dependency representation for muxing ${rep.dependencyMuxingKey} is selected by this manifest`,
					);
				dependencies.set(rep.muxingKey, rep.dependencyMuxingKey);
			}
		}
		for (const start of dependencies.keys()) {
			const visited = new Set<string>();
			let next: string | undefined = start;
			while (next) {
				if (visited.has(next)) {
					error(
						`${path}.detailed.representations`,
						"Representation dependencies contain a cycle",
					);
					break;
				}
				visited.add(next);
				next = dependencies.get(next);
			}
		}
		for (const [ri, rep] of (
			detail.additionalRepresentations ?? []
		).entries()) {
			const rp = `${path}.detailed.additionalRepresentations[${ri}]`;
			if (rep.type === "SPRITE") {
				const sprite = plan.sprites.find((row) => row.key === rep.spriteKey);
				if (!sprites.has(rep.spriteKey))
					error(`${rp}.spriteKey`, `Unknown sprite ${rep.spriteKey}`);
				else if (
					!manifestMediaReachable(
						plan,
						sprite?.destination,
						manifest.destination,
					)
				)
					error(
						rp,
						"The sprite output must be reachable from every manifest output",
					);
			}
			if (rep.type === "PROGRESSIVE_WEBM") {
				const muxing = muxings.get(rep.muxingKey);
				if (
					muxing &&
					!manifestMediaReachable(
						plan,
						muxing.destination,
						manifest.destination,
					)
				)
					error(
						rp,
						"The progressive WebM output must be reachable from every manifest output",
					);
				if (muxing?.kind !== "WEBM" || !muxing.progressive)
					error(
						`${rp}.muxingKey`,
						"Progressive WebM representation requires a progressive WebM muxing",
					);
				if (rep.dependencyMuxingKey && !emitted(rep.dependencyMuxingKey))
					error(
						`${rp}.dependencyMuxingKey`,
						"The dependency must be a static representation selected by this manifest",
					);
			}
		}
		for (const xml of detail.period?.customXmlElements ?? [])
			if (/<!DOCTYPE|<!ENTITY/i.test(xml))
				error(
					`${path}.detailed.period.customXmlElements`,
					"XML entity and document type declarations are not allowed",
				);
	}
	return issues;
}
