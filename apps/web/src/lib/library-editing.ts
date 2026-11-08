import type {
	AnyEditDocument,
	CfrTimeMap,
	CompositionFrame,
	CompositionSourceFacts,
	EditDocument,
	SceneAnalysisDocument,
} from "@bitovp/core";

export type EditingMediaView = {
	id: string;
	sourceId: string;
	state: string;
	error: string | null;
	durationUs: number | null;
	width: number | null;
	height: number | null;
	timeMap: CfrTimeMap | null;
	url: string | null;
};
export type AutomaticEditingContext = {
	encodingId: string | null;
	status:
		| "READY"
		| "PREPARING"
		| "ANALYSIS_PENDING"
		| "NEEDS_PREPARATION"
		| "NEEDS_CONFIRMATION"
		| "UNAVAILABLE";
	analysisRevisionId: string | null;
	mediaVersionId: string | null;
	hasAudio: boolean | null;
	preparation: {
		fileKey: string;
		output: { credentialId: string; bucket: string; prefix: string };
	} | null;
	reason: string | null;
};
export type EditingRenderView = {
	id: string;
	revisionId: string;
	kind: "PREVIEW" | "EXPORT";
	state: string;
	generation: number;
	error: string | null;
	durationFrames?: number;
	requestKey?: string;
	artifact: {
		id: string;
		url: string;
		downloadUrl: string;
		derivedContentId: string | null;
	} | null;
};
export type EditingProjectExportSummary = {
	id: string;
	revisionId: string;
	generation: number;
	state: string;
	durationFrames: number | null;
	finishedAt: string | null;
	matchesCurrentDraft: boolean;
	artifact: EditingRenderView["artifact"];
};
export type EditingProjectSummary = {
	id: string;
	title: string;
	variant: string;
	updatedAt: string;
	contentId: string;
	archived: boolean;
	draftRevision: number;
	currentRevisionId: string | null;
	currentRevisionMatchesDraft: boolean;
	durationFrames: number | null;
	fps: { num: 30; den: 1 } | null;
	thumbnail?: EditingThumbnailReference | null;
	latestExport: EditingProjectExportSummary | null;
	latestSuccessfulExport:
		| (EditingProjectExportSummary & {
				state: "SUCCEEDED";
				artifact: NonNullable<EditingProjectExportSummary["artifact"]>;
		  })
		| null;
};
export type EditingThumbnailReference = {
	url: string;
	cacheKey: string;
	draftRevision: number;
	width: number;
	height: number;
};
export type EditingThumbnailFrameView = {
	cacheKey: string;
	draftRevision: number;
	frame: CompositionFrame | null;
	video: { clipId: string; mediaVersionId: string; url: string } | null;
	images: { id: string; url: string }[];
};
export type EditingProjectPage = {
	items: EditingProjectSummary[];
	offset: number;
	total: number;
};
export type EditingProjectView = {
	id: string;
	contentId: string;
	title: string;
	variant: string;
	draftRevision: number;
	draft: EditDocument;
	currentRevisionId: string | null;
	currentRevisionMatchesDraft: boolean;
	media: EditingMediaView;
	analysis: {
		id: string;
		locale: string;
		document: SceneAnalysisDocument;
	} | null;
	renders: EditingRenderView[];
};

export type AnyEditingProjectView = Omit<EditingProjectView, "draft"> & {
	draft: AnyEditDocument;
	additionalMedia?: EditingMediaView[];
	compositionSources?: CompositionSourceFacts[];
	imageAssets?: { id: string; url: string; width: number; height: number }[];
};
