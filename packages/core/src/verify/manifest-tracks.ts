import { outputFilePath, outputStorageKeys } from "../plan/output-files";
import type { EncodingPlan } from "../plan/schema";

/** Stable identities of explicitly configured HLS rendition-group entries. */
export type ExpectedHlsAudioGroups = {
	droppingMode: "STREAM" | "AUDIO";
	groups: { name: string; priority: number }[];
};

export type ExpectedHlsAdditionalMedia = {
	type: "VIDEO" | "SUBTITLES" | "CLOSED-CAPTIONS";
	groupId: string;
	name: string;
	language?: string;
	uri?: string;
	vttUrl?: string;
	muxingKey?: string;
	drmKey?: string;
	instreamId?: string;
	requiresInit?: true;
	startSegmentNumber?: number;
	endSegmentNumber?: number;
	resource?: {
		muxingKey: string;
		drmKey?: string;
		drmKind?: "CENC" | "FAIRPLAY" | "SPEKE";
		container: "FMP4" | "CMAF" | "TS" | "MP4";
		outputKey: string;
		/** Logical aliases and mirrors that actually receive this writer's files. */
		outputKeys: string[];
		directory: string;
		segmentNaming?: string;
		segmentNamingIsTemplate?: true;
		initSegment?: string;
		initSegmentNameTemplate?: string;
		filename?: string;
	};
};

type SourcePlan = Pick<EncodingPlan, "outputs" | "deliveryMirrors"> & {
	muxings: readonly {
		key: string;
		kind: string;
		destination?: { outputKey: string; path: string };
		segmentNaming?: string;
		segmentNamingTemplate?: string;
		initSegmentName?: string;
		initSegmentNameTemplate?: string;
		filename?: string;
	}[];
	drm?: readonly {
		key: string;
		muxingKey: string;
		kind: "CENC" | "FAIRPLAY" | "SPEKE";
		destination: { outputKey: string; path: string };
	}[];
};

export type ExpectedHlsWriterResource = NonNullable<
	ExpectedHlsAdditionalMedia["resource"]
>;

/** The physical output contract shared by configured and provider-selected HLS tracks. */
export function expectedHlsWriterResource(
	plan: SourcePlan,
	muxingKey: string | undefined,
	drmKey?: string,
	drmKind?: "CENC" | "FAIRPLAY" | "SPEKE",
): ExpectedHlsAdditionalMedia["resource"] {
	const muxing = plan.muxings.find((row) => row.key === muxingKey);
	const drm = drmKey
		? plan.drm?.find((row) => row.key === drmKey && row.muxingKey === muxingKey)
		: drmKind
			? plan.drm?.find(
					(row) => row.kind === drmKind && row.muxingKey === muxingKey,
				)
			: undefined;
	const destination =
		drmKey || drmKind ? drm?.destination : muxing?.destination;
	let resource: ExpectedHlsAdditionalMedia["resource"];
	if (
		muxing &&
		destination &&
		["FMP4", "CMAF", "TS", "MP4"].includes(muxing.kind)
	) {
		const targets = outputStorageKeys(plan, destination.outputKey);
		const directory = outputFilePath(destination.path, "");
		resource = {
			muxingKey: muxing.key,
			...(drm ? { drmKey: drm.key, drmKind: drm.kind } : {}),
			container: muxing.kind as NonNullable<
				ExpectedHlsAdditionalMedia["resource"]
			>["container"],
			outputKey: destination.outputKey,
			outputKeys: plan.outputs
				.filter((output) =>
					[...outputStorageKeys({ outputs: plan.outputs }, output.key)].some(
						(target) => targets.has(target),
					),
				)
				.map((output) => output.key),
			directory: directory ? `${directory}/` : "",
			...(muxing.segmentNaming !== undefined
				? {
						segmentNaming: muxing.segmentNamingTemplate || muxing.segmentNaming,
					}
				: {}),
			...(muxing.segmentNamingTemplate
				? { segmentNamingIsTemplate: true as const }
				: {}),
			...(muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
				? { initSegmentNameTemplate: muxing.initSegmentNameTemplate }
				: muxing.initSegmentName !== undefined
					? { initSegment: muxing.initSegmentName }
					: {}),
			...(muxing.filename !== undefined ? { filename: muxing.filename } : {}),
		};
	}
	return resource;
}

export function expectedHlsAdditionalMedia(
	media: readonly {
		type: "VIDEO" | "VTT" | "CLOSED_CAPTIONS";
		groupId: string;
		name: string;
		language?: string;
		uri?: string;
		vttUrl?: string;
		muxingKey?: string;
		drmKey?: string;
		instreamId?: string;
		startSegmentNumber?: number;
		endSegmentNumber?: number;
	}[],
	plan: SourcePlan,
	manifestDrmKind?: "CENC" | "FAIRPLAY" | "SPEKE",
): ExpectedHlsAdditionalMedia[] {
	return media.map((entry) => {
		const resource =
			entry.type === "VIDEO"
				? expectedHlsWriterResource(
						plan,
						entry.muxingKey,
						entry.drmKey,
						manifestDrmKind,
					)
				: undefined;
		const drm = entry.drmKey
			? plan.drm?.find(
					(row) =>
						row.key === entry.drmKey && row.muxingKey === entry.muxingKey,
				)
			: manifestDrmKind
				? plan.drm?.find(
						(row) =>
							row.kind === manifestDrmKind && row.muxingKey === entry.muxingKey,
					)
				: undefined;
		return {
			type:
				entry.type === "VTT"
					? "SUBTITLES"
					: entry.type === "CLOSED_CAPTIONS"
						? "CLOSED-CAPTIONS"
						: "VIDEO",
			groupId: entry.groupId,
			name: entry.name,
			...(entry.language !== undefined ? { language: entry.language } : {}),
			...(entry.uri !== undefined ? { uri: entry.uri } : {}),
			...(entry.vttUrl !== undefined ? { vttUrl: entry.vttUrl } : {}),
			...(entry.muxingKey !== undefined ? { muxingKey: entry.muxingKey } : {}),
			...(drm
				? { drmKey: drm.key }
				: entry.drmKey !== undefined
					? { drmKey: entry.drmKey }
					: {}),
			...(entry.instreamId !== undefined
				? { instreamId: entry.instreamId }
				: {}),
			...(entry.type === "VIDEO" &&
			plan.muxings.some(
				(muxing) =>
					muxing.key === entry.muxingKey &&
					["FMP4", "CMAF", "MP4"].includes(muxing.kind),
			)
				? { requiresInit: true as const }
				: {}),
			...(entry.startSegmentNumber !== undefined
				? { startSegmentNumber: entry.startSegmentNumber }
				: {}),
			...(entry.endSegmentNumber !== undefined
				? { endSegmentNumber: entry.endSegmentNumber }
				: {}),
			...(resource ? { resource } : {}),
		};
	});
}
