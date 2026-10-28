import { z } from "zod";
import type { SceneAnalysisDocument } from "./analysis";

export const libraryFileKindSchema = z.enum(["MP4", "WEBM"]);
export type LibraryFileKind = z.infer<typeof libraryFileKindSchema>;
export function isLibraryFileKind(kind: unknown): kind is LibraryFileKind {
	return kind === "MP4" || kind === "WEBM";
}
export function libraryFileContentType(
	kind: LibraryFileKind,
): "video/mp4" | "video/webm" {
	return kind === "WEBM" ? "video/webm" : "video/mp4";
}

export const libraryPlaybackLinkSchema = z.object({
	key: z.string(),
	kind: z.enum(["HLS", "DASH", "SMOOTH", "MP4", "WEBM"]),
	label: z.string(),
	url: z.string().nullable(),
	path: z.string(),
	via: z.string(),
	reason: z.object({ code: z.string() }).optional(),
});
export const libraryFileOutputSchema = z.object({
	key: z.string(),
	kind: libraryFileKindSchema,
	credentialId: z.string().uuid(),
	bucket: z.string().min(1),
	path: z.string().min(1),
});
export const librarySnapshotSchema = z.object({
	schemaVersion: z.literal(1),
	kind: z.literal("VOD_JOB"),
	name: z.string(),
	planHash: z.string(),
	identity: z.literal("UNVERIFIED"),
	inputs: z.array(z.object({ name: z.string(), path: z.string() })),
	playbackLinks: z.array(libraryPlaybackLinkSchema),
	/** Server-only storage coordinates for authenticated playback after job deletion. */
	fileOutputs: z.array(libraryFileOutputSchema).max(100).optional(),
	qcVerdict: z.unknown(),
	qcOverriddenAt: z.string().nullable(),
	qcEvidence: z.array(z.unknown()).max(20).optional(),
	analysisOutput: z
		.object({
			credentialId: z.string().uuid(),
			bucket: z.string().min(1),
			path: z.string(),
			filename: z.string().min(1),
		})
		.optional(),
});
export const contentEditSchema = z.object({
	title: z.string().trim().min(1).max(500),
	description: z.string().max(10000).default(""),
	tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
	locale: z
		.string()
		.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
		.max(35),
});
export const contentRegisterSchema = contentEditSchema
	.extend({
		sourceId: z.uuid(),
		contentId: z.uuid().optional(),
		expectedRevision: z.number().int().positive().optional(),
	})
	.strict();
export const contentUpdateSchema = contentEditSchema
	.partial()
	.extend({
		description: contentEditSchema.shape.description.removeDefault().optional(),
		tags: contentEditSchema.shape.tags.removeDefault().optional(),
		expectedRevision: z.number().int().positive(),
		archived: z.boolean().optional(),
	})
	.strict();
export type AnalysisJsonValue =
	| null
	| boolean
	| number
	| string
	| AnalysisJsonValue[]
	| { [key: string]: AnalysisJsonValue };
export type ProviderAnalysisView = {
	data: AnalysisJsonValue;
	source: "PROVIDER" | "NORMALIZED";
};

export type LibrarySourceView = {
	id: string;
	jobId: string | null;
	originalJobId: string;
	state: "PENDING" | "RUNNING" | "READY" | "ERROR";
	error: string | null;
	locales: string[];
	snapshot: z.infer<typeof librarySnapshotSchema>;
	analyses: {
		id: string;
		locale: string;
		createdAt: string;
		document: SceneAnalysisDocument;
		providerAnalysis?: ProviderAnalysisView;
	}[];
	contents: { id: string; title: string; archived: boolean }[];
};
export type ContentView = {
	id: string;
	title: string;
	description: string;
	tags: string[];
	locale: string;
	revision: number;
	archived: boolean;
	updatedAt: string;
	catalogPreview?: {
		kind: "HLS" | "DASH" | LibraryFileKind;
		url: string;
		time: number;
		duration?: number;
		sceneCount?: number;
	};
};
export type ContentDetail = ContentView & { source: LibrarySourceView };
