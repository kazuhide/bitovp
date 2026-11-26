import type { OperationKind, StepLogEntry } from "@bitovp/core";
import { configurations } from "./families/configurations";
import { encodings } from "./families/encodings";
import { filters } from "./families/filters";
import { heAac } from "./families/he-aac";
import { inputs } from "./families/inputs";
import { manifests } from "./families/manifests";
import { outputs } from "./families/outputs";
import { protectedManifests } from "./families/protected-manifests";
import { authoredDrm } from "./families/recorded-drm";
import type { ResourceFamily } from "./family";

const families: Partial<Record<OperationKind, ResourceFamily>> = {
	...configurations,
	...encodings,
	...filters,
	...heAac,
	...inputs,
	...manifests,
	...outputs,
};
export function resourceFamilyForStep(
	entry: StepLogEntry,
): ResourceFamily | undefined {
	if (
		(entry.kind === "CREATE_MANIFEST_DASH" ||
			entry.kind === "CREATE_MANIFEST_HLS") &&
		entry.payload.generationMode === "DEFAULT"
	)
		return;
	if (entry.kind === "CREATE_DASH_REPRESENTATION_FMP4" && entry.refs.drmId)
		return protectedManifests.FMP4_REP;
	if (entry.kind === "CREATE_DASH_REPRESENTATION_MP4" && entry.refs.drmId)
		return protectedManifests.MP4_REP;
	if (entry.kind === "CREATE_SMOOTH_CONTENT_PROTECTION")
		return protectedManifests.SMOOTH;
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
	return families[entry.kind];
}
