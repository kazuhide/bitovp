import {
	encodingSupplementSchema,
	type OperationKind,
	type StepLogEntry,
} from "@bitovp/core";
import { configurations, hevcV2 } from "./families/configurations";
import { encodingSupplements } from "./families/encoding-supplements";
import { encodings } from "./families/encodings";
import { filters } from "./families/filters";
import { heAac } from "./families/he-aac";
import { hlsCustomTags } from "./families/hls-custom-tags";
import { inputs } from "./families/inputs";
import { manifests } from "./families/manifests";
import {
	recordedDeliveryMuxings,
	recordedProgressiveTsId3,
	recordedTypedDrm,
} from "./families/native-packaging";
import { outputs } from "./families/outputs";
import { protectedManifests } from "./families/protected-manifests";
import { authoredDrm } from "./families/recorded-drm";
import type { ResourceFamily } from "./family";

const families: Partial<Record<OperationKind, ResourceFamily>> = {
	...configurations,
	...encodings,
	CREATE_KANTAR_WATERMARK: encodingSupplements.KANTAR,
	CREATE_NEXGUARD_FILE_MARKER: encodingSupplements.NEXGUARD,
	...filters,
	...heAac,
	...inputs,
	...manifests,
	...recordedDeliveryMuxings,
	...outputs,
};
export function resourceFamilyForStep(
	entry: StepLogEntry,
): ResourceFamily | undefined {
	if (entry.kind === "CREATE_DRM_TYPED") {
		const { muxingKind, drmKind } = entry.payload;
		if (typeof muxingKind !== "string" || typeof drmKind !== "string") return;
		const key = `${muxingKind}.${drmKind}`;
		return Object.hasOwn(recordedTypedDrm, key)
			? recordedTypedDrm[key]
			: undefined;
	}
	if (entry.kind === "CREATE_PROGRESSIVE_TS_ID3") {
		const { format } = entry.payload;
		return typeof format === "string" &&
			Object.hasOwn(recordedProgressiveTsId3, format)
			? recordedProgressiveTsId3[format]
			: undefined;
	}
	if (
		entry.kind === "CREATE_CODEC_H265" &&
		entry.payload.internalHevcV2 === true
	)
		return hevcV2;
	if (
		(entry.kind === "CREATE_MANIFEST_DASH" ||
			entry.kind === "CREATE_MANIFEST_HLS" ||
			entry.kind === "CREATE_MANIFEST_SMOOTH") &&
		entry.payload.generationMode === "DEFAULT"
	)
		return;
	if (entry.kind === "CREATE_DASH_REPRESENTATION_FMP4" && entry.refs.drmId)
		return protectedManifests.FMP4_REP;
	if (entry.kind === "CREATE_DASH_REPRESENTATION_MP4" && entry.refs.drmId)
		return protectedManifests.MP4_REP;
	if (entry.kind === "CREATE_SMOOTH_CONTENT_PROTECTION")
		return protectedManifests.SMOOTH;
	if (entry.kind === "CREATE_HLS_CUSTOM_TAG") {
		if (entry.payload.target === "MEDIA" && !entry.refs.streamInfoId)
			return hlsCustomTags.MEDIA;
		if (entry.payload.target === "STREAM" && !entry.refs.mediaId)
			return hlsCustomTags.STREAM;
		return;
	}
	if (entry.kind === "CREATE_DASH_CONTENT_PROTECTION") {
		const kind = entry.payload.representationKind ?? "FMP4";
		if (kind === "ADAPTATION_SET")
			return entry.refs.representationId
				? undefined
				: protectedManifests.ADAPTATION_SET;
		if (kind === "FMP4" || kind === "FMP4_DRM" || kind === "WEBM")
			return protectedManifests[kind];
		return;
	}
	if (
		entry.kind === "CREATE_DRM_CENC" ||
		entry.kind === "CREATE_DRM_SPEKE" ||
		entry.kind === "CREATE_DRM_FAIRPLAY"
	) {
		if (typeof entry.payload.muxingKind !== "string") return;
		const key = `${entry.kind}.${entry.payload.muxingKind}`;
		return Object.hasOwn(authoredDrm, key) ? authoredDrm[key] : undefined;
	}
	if (entry.kind === "CREATE_ENCODING_SUPPLEMENT") {
		const parsed = encodingSupplementSchema.safeParse(entry.payload.supplement);
		if (!parsed.success || parsed.data.kind === "PSNR") return;
		return encodingSupplements[parsed.data.kind];
	}
	return families[entry.kind];
}
