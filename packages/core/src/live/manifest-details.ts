import type { CompiledOperation } from "../plan/compiler";
import {
	applyManifestDetails,
	type DetailedManifest,
} from "../plan/manifest-detail-compiler";
import { manifestMediaReachable } from "../plan/manifest-reference-validation";
import { AUDIO_CODECS } from "../plan/schema";
import type { PlanIssue } from "../plan/validate";
import { liveHlsEntryUris, selectLiveManifestMuxings } from "./compiler";
import { liveManifestDrm } from "./protection";
import type { LiveChannelPlan, LiveManifestPlan } from "./schema";

export function compileLiveManifestDetails(
	plan: LiveChannelPlan,
	manifest: LiveManifestPlan,
	operations: CompiledOperation[],
): CompiledOperation[] {
	if (!manifest.detailed) return operations;
	const common = {
		key: manifest.key,
		name: manifest.name,
		manifestName: manifest.manifestName,
		destination: manifest.destination,
		audioLanguage: manifest.audioLanguage,
		drmKind: manifest.drmKind,
	};
	const selection: DetailedManifest =
		manifest.kind === "HLS"
			? {
					...common,
					kind: "HLS",
					detailed: manifest.detailed,
					audioGroupId: manifest.audioGroupId,
					closedCaptions: manifest.closedCaptions,
					videoMuxingKind: manifest.videoMuxingKind,
					audioMuxingKind: manifest.audioMuxingKind,
					perTitleVariantUri: "AVG_BITRATE",
				}
			: {
					...common,
					kind: "DASH",
					detailed: manifest.detailed,
					representationType: manifest.representationType,
					videoMuxingKind: manifest.videoMuxingKind,
					audioMuxingKind: manifest.audioMuxingKind,
				};
	return applyManifestDetails(
		{
			renditions: plan.renditions,
			muxings: plan.muxings,
			drm: plan.drm ?? [],
			sprites: [],
		},
		selection,
		operations,
		() => "encoding",
	);
}

export function liveManifestDetailIssues(plan: LiveChannelPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const add = (path: string, message: string) =>
		issues.push({
			code: "LIVE_MANIFEST_DETAIL_INVALID",
			level: "error",
			path,
			message,
		});
	for (const [index, manifest] of plan.liveManifests.entries()) {
		const detail = manifest.detailed;
		if (!detail) continue;
		const path = `liveManifests[${index}].detailed`;
		const selected = selectLiveManifestMuxings(plan, manifest);
		const selectedKeys = new Set(selected.map((row) => row.muxing.key));
		const range = (
			row: { startSegmentNumber?: number; endSegmentNumber?: number },
			at: string,
		) => {
			if (
				row.startSegmentNumber !== undefined &&
				row.endSegmentNumber !== undefined &&
				row.startSegmentNumber > row.endSegmentNumber
			)
				add(at, "The final segment must not precede the first segment");
		};
		if (manifest.kind === "HLS") {
			const d = manifest.detailed;
			if (!d) continue;
			for (const [field, row] of [
				["streams", d.streams],
				["audioMedia", d.audioMedia],
			] as const)
				if (row) range(row, `${path}.${field}`);
			const videoGroups = new Set(
				d.additionalMedia
					?.filter((media) => media.type === "VIDEO")
					.map((media) => media.groupId),
			);
			if (d.streams?.video && !videoGroups.has(d.streams.video))
				add(
					`${path}.streams.video`,
					"The variant video group must reference a configured video media group",
				);
			const audioGroups = new Set(
				selected
					.filter(({ rendition }) => AUDIO_CODECS.has(rendition.codec))
					.map(() => manifest.audioGroupId),
			);
			for (const group of d.streams?.audioGroups?.groups ?? [])
				if (!audioGroups.has(group.name))
					add(
						`${path}.streams.audioGroups`,
						`Unknown selected audio group ${group.name}`,
					);
			const subtitleGroups = new Set(
				d.additionalMedia
					?.filter((media) => media.type === "VTT")
					.map((media) => media.groupId),
			);
			if (subtitleGroups.size > 1)
				add(
					`${path}.additionalMedia`,
					"HLS variants support one subtitle group; use the same groupId for all subtitle languages",
				);
			const uris = new Set(
				selected.map(({ rendition }) =>
					liveHlsEntryUris(plan).get(rendition.key),
				),
			);
			uris.add(manifest.manifestName);
			for (const [mi, media] of (d.additionalMedia ?? []).entries()) {
				const at = `${path}.additionalMedia[${mi}]`;
				range(media, at);
				if (media.type !== "CLOSED_CAPTIONS") {
					if (uris.has(media.uri))
						add(`${at}.uri`, `Duplicate child playlist ${media.uri}`);
					uris.add(media.uri);
				}
				if (media.type === "VTT") continue;
				const muxing = plan.muxings.find((m) => m.key === media.muxingKey);
				const rendition = plan.renditions.find(
					(r) => r.key === muxing?.streamKey,
				);
				if (
					!muxing ||
					!["FMP4", "TS"].includes(muxing.kind) ||
					!rendition ||
					AUDIO_CODECS.has(rendition.codec)
				)
					add(
						`${at}.muxingKey`,
						"Video and closed-caption media require a segmented Live video container",
					);
				const drm = media.drmKey
					? plan.drm?.find(
							(drm) =>
								drm.key === media.drmKey && drm.muxingKey === media.muxingKey,
						)
					: muxing
						? liveManifestDrm(plan, muxing, manifest)
						: undefined;
				if (
					!manifestMediaReachable(
						plan,
						drm?.destination ?? muxing?.destination,
						manifest.destination,
					)
				)
					add(
						at,
						"The selected media output must be reachable from every manifest output",
					);
				if (
					media.drmKey &&
					!plan.drm?.some(
						(drm) =>
							drm.key === media.drmKey && drm.muxingKey === media.muxingKey,
					)
				)
					add(
						`${at}.drmKey`,
						"The selected encryption must belong to this muxing",
					);
				if (
					muxing &&
					!media.drmKey &&
					manifest.drmKind &&
					!liveManifestDrm(plan, muxing, manifest)
				)
					add(
						at,
						"The selected media has no encryption matching this manifest",
					);
			}
			const tags = [
				...(d.mediaCustomTags ?? []),
				...(d.streamCustomTags ?? []),
				...(d.additionalMedia ?? []).flatMap((media) => media.customTags ?? []),
			];
			for (const tag of tags) {
				if (!tag.data.startsWith("#") || /[\r\n]/.test(tag.data))
					add(
						path,
						"A custom tag must contain one HLS tag line beginning with #",
					);
				if (
					(plan.adMarkers?.scte35 ||
						plan.start.adInsertion?.enableEsamMediaPointInsertion) &&
					/#EXT-X-(?:CUE|DATERANGE|SCTE35|SPLICEPOINT)|#EXT-OATCLS-SCTE35/.test(
						tag.data,
					)
				)
					add(
						path,
						"Custom ad tags cannot be combined with automatic Live ad marker generation",
					);
			}
			continue;
		}
		const d = manifest.detailed;
		if (!d) continue;
		for (const xml of d.period?.customXmlElements ?? [])
			if (/<!DOCTYPE|<!ENTITY/i.test(xml))
				add(
					`${path}.period.customXmlElements`,
					"XML entity and document type declarations are not allowed",
				);
		const dependencies = new Map<string, string>();
		const overridden = new Set<string>();
		for (const [ri, rep] of (d.representations ?? []).entries()) {
			const at = `${path}.representations[${ri}]`;
			range(rep, at);
			if (overridden.has(rep.muxingKey))
				add(`${at}.muxingKey`, "Use only one override for each representation");
			overridden.add(rep.muxingKey);
			if (!selectedKeys.has(rep.muxingKey))
				add(
					`${at}.muxingKey`,
					"The representation must select a container included by this Live manifest",
				);
			if (rep.dependencyMuxingKey) {
				if (!selectedKeys.has(rep.dependencyMuxingKey))
					add(
						`${at}.dependencyMuxingKey`,
						"The dependency must be another representation included by this Live manifest",
					);
				dependencies.set(rep.muxingKey, rep.dependencyMuxingKey);
			}
			if (rep.contentProtection && !rep.drmRepresentation && !manifest.drmKind)
				add(
					`${at}.contentProtection`,
					"Select a manifest DRM kind or an encrypted fMP4 representation before configuring content protection",
				);
			if (rep.drmRepresentation) {
				const matches = (plan.drm ?? []).filter(
					(drm) =>
						drm.muxingKey === rep.muxingKey &&
						(!manifest.drmKind || drm.kind === manifest.drmKind),
				);
				if (matches.length > 1)
					add(
						at,
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
					add(
						at,
						"The selected encrypted output must be reachable from every manifest output",
					);
				const muxing = plan.muxings.find((m) => m.key === rep.muxingKey);
				if (
					muxing?.kind !== "FMP4" ||
					!(plan.drm ?? []).some(
						(drm) =>
							drm.muxingKey === rep.muxingKey &&
							(!manifest.drmKind || drm.kind === manifest.drmKind),
					)
				)
					add(at, "DRM representations require an encrypted fMP4 container");
			}
		}
		for (const start of dependencies.keys()) {
			const visited = new Set<string>();
			let next: string | undefined = start;
			while (next) {
				if (visited.has(next)) {
					add(
						`${path}.representations`,
						"Representation dependencies contain a cycle",
					);
					break;
				}
				visited.add(next);
				next = dependencies.get(next);
			}
		}
	}
	return issues;
}
