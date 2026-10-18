import "server-only";
import {
	type AnalysisJsonValue,
	type ContentView,
	contentEditSchema,
	type contentRegisterSchema,
	type contentUpdateSchema,
	type LibrarySourceView,
	librarySnapshotSchema,
	MAX_SCENE_ANALYSIS_BYTES,
	normalizeSceneAnalysis,
	type ProviderAnalysisView,
	redactSecrets,
	sceneAnalysisDocumentSchema,
} from "@bitovp/core";
import { type AppPrismaClient, LibrarySourceError } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "./context";
import { jsonError, routeError, validationError } from "./http";
import { enrichLibraryPlayback } from "./library-playback";

function analysisDisplayData(value: unknown): AnalysisJsonValue {
	const serialized = JSON.stringify(value);
	if (
		!serialized ||
		Buffer.byteLength(serialized, "utf8") > MAX_SCENE_ANALYSIS_BYTES
	)
		throw new Error("Analysis exceeds 8 MiB");
	const data = redactSecrets(JSON.parse(serialized)) as AnalysisJsonValue;
	if (
		Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_SCENE_ANALYSIS_BYTES
	)
		throw new Error("Redacted analysis exceeds 8 MiB");
	return data;
}

export async function libraryRoute(
	action: () => Promise<Response>,
): Promise<Response> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof z.ZodError) return validationError(error);
		if (error instanceof LibrarySourceError)
			return jsonError(error.status, error.publicMessage);
		return routeError(error);
	}
}

export function contentView(row: {
	id: string;
	title: string;
	description: string;
	tags: string[];
	locale: string;
	revision: number;
	archived: boolean;
	updatedAt: Date;
}): ContentView {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		tags: row.tags,
		locale: row.locale,
		revision: row.revision,
		archived: row.archived,
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function sourceView(
	prisma: AppPrismaClient,
	id: string,
): Promise<LibrarySourceView> {
	const source = await prisma.librarySource.findUnique({ where: { id } });
	if (!source) throw new LibrarySourceError(404, "Source not found");
	const analyses = await Promise.all(
		source.locales.map((locale) =>
			prisma.sceneAnalysisRevision.findFirst({
				where: { sourceId: id, locale },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				select: {
					id: true,
					locale: true,
					createdAt: true,
					document: true,
					raw: true,
				},
			}),
		),
	);
	const links = await prisma.contentRevision.findMany({
		where: { sourceId: id },
		distinct: ["contentId"],
		take: 100,
		select: { content: { select: { id: true, title: true, archived: true } } },
	});
	const {
		analysisOutput: _privateLocator,
		fileOutputs,
		...snapshot
	} = librarySnapshotSchema.parse(source.snapshot);
	const [playbackLinks] = await enrichLibraryPlayback(prisma, [
		{
			sourceId: source.id,
			jobId: source.jobId,
			planHash: snapshot.planHash,
			fileOutputs,
			playbackLinks: snapshot.playbackLinks,
		},
	]);
	return {
		id: source.id,
		jobId: source.jobId,
		originalJobId: source.originalJobId,
		state: z.enum(["PENDING", "RUNNING", "READY", "ERROR"]).parse(source.state),
		error: source.error,
		locales: source.locales,
		snapshot: {
			...snapshot,
			playbackLinks: playbackLinks ?? snapshot.playbackLinks,
		},
		analyses: analyses.flatMap((row) => {
			if (!row) return [];
			let document: ReturnType<typeof normalizeSceneAnalysis>;
			let providerAnalysis: ProviderAnalysisView;
			try {
				// Re-project retained provider data on detail reads without rewriting history.
				document = normalizeSceneAnalysis(row.raw);
				providerAnalysis = {
					source: "PROVIDER",
					data: analysisDisplayData(row.raw),
				};
			} catch {
				// Older/imported revisions may have no usable raw data; keep validated evidence.
				document = sceneAnalysisDocumentSchema.parse(row.document);
				providerAnalysis = {
					source: "NORMALIZED",
					data: analysisDisplayData(document),
				};
			}
			return [
				{
					id: row.id,
					locale: row.locale,
					createdAt: row.createdAt.toISOString(),
					document,
					providerAnalysis,
				},
			];
		}),
		contents: links.map((link) => link.content),
	};
}

export const contentSelect = {
	id: true,
	title: true,
	description: true,
	tags: true,
	locale: true,
	revision: true,
	archived: true,
	updatedAt: true,
} as const;
export { catalogPreview, listContents, listQuery } from "./library-catalog";

export async function readContent(id: string) {
	const prisma = (await getServerContext()).prisma;
	const row = await prisma.content.findUnique({
		where: { id },
		select: contentSelect,
	});
	if (!row) return jsonError(404, "Content not found");
	const revision = await prisma.contentRevision.findUnique({
		where: { contentId_revision: { contentId: id, revision: row.revision } },
	});
	if (!revision) throw new Error("Content revision missing");
	return NextResponse.json({
		...contentView(row),
		source: await sourceView(prisma, revision.sourceId),
	});
}

type Tx = Omit<
	AppPrismaClient,
	"$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;
type Metadata = z.infer<typeof contentEditSchema>;
async function requireSourceLocale(tx: Tx, sourceId: string, locale: string) {
	const source = await tx.librarySource.findUnique({
		where: { id: sourceId },
		select: { id: true, locales: true },
	});
	if (!source) throw new LibrarySourceError(404, "Source not found");
	if (!(source.locales.length ? source.locales : ["und"]).includes(locale))
		throw new LibrarySourceError(400, "Locale not present in source");
}
async function appendRevision(
	tx: Tx,
	contentId: string,
	sourceId: string,
	revision: number,
	metadata: Metadata,
	actor: string | null,
) {
	await tx.contentRevision.create({
		data: { contentId, sourceId, revision, ...metadata, createdBy: actor },
	});
}

export async function registerContent(
	prisma: AppPrismaClient,
	input: z.infer<typeof contentRegisterSchema>,
	actor: string | null,
): Promise<string> {
	const metadata = contentEditSchema.parse(input);
	return prisma.$transaction(async (tx) => {
		// Serialize the stable registration key, including concurrent first inserts.
		await tx.$queryRaw`SELECT id FROM "LibrarySource" WHERE id = ${input.sourceId}::uuid FOR UPDATE`;
		await requireSourceLocale(tx, input.sourceId, input.locale);
		if (input.contentId) {
			const content = await tx.content.findUnique({
				where: { id: input.contentId },
			});
			if (!content) throw new LibrarySourceError(404, "Content not found");
			if (content.archived || content.revision !== input.expectedRevision)
				throw new LibrarySourceError(
					409,
					"Content is archived or revision changed; reload before saving",
				);
			const revision = content.revision + 1;
			const changed = await tx.content.updateMany({
				where: { id: content.id, revision: content.revision, archived: false },
				data: { ...metadata, revision },
			});
			if (!changed.count)
				throw new LibrarySourceError(
					409,
					"Revision changed; reload before saving",
				);
			await appendRevision(
				tx,
				content.id,
				input.sourceId,
				revision,
				metadata,
				actor,
			);
			return content.id;
		}
		const existing = await tx.content.findUnique({
			where: { registrationKey: input.sourceId },
		});
		if (existing) {
			if (
				existing.archived ||
				JSON.stringify(contentEditSchema.parse(existing)) !==
					JSON.stringify(metadata)
			)
				throw new LibrarySourceError(
					409,
					"Source is already registered; open its content to edit",
				);
			return existing.id;
		}
		const content = await tx.content.create({
			data: { registrationKey: input.sourceId, ...metadata },
		});
		await appendRevision(tx, content.id, input.sourceId, 1, metadata, actor);
		return content.id;
	});
}

export async function updateContent(
	prisma: AppPrismaClient,
	id: string,
	input: z.infer<typeof contentUpdateSchema>,
	actor: string | null,
): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const content = await tx.content.findUnique({ where: { id } });
		if (!content) throw new LibrarySourceError(404, "Content not found");
		if (content.revision !== input.expectedRevision)
			throw new LibrarySourceError(
				409,
				"Revision changed; reload before saving",
			);
		const previous = await tx.contentRevision.findUnique({
			where: {
				contentId_revision: { contentId: id, revision: content.revision },
			},
		});
		if (!previous) throw new Error("Content revision missing");
		const metadata = contentEditSchema.parse({ ...content, ...input });
		await requireSourceLocale(tx, previous.sourceId, metadata.locale);
		const revision = content.revision + 1;
		const changed = await tx.content.updateMany({
			where: { id, revision: content.revision },
			data: {
				...metadata,
				archived: input.archived ?? content.archived,
				revision,
			},
		});
		if (!changed.count)
			throw new LibrarySourceError(
				409,
				"Revision changed; reload before saving",
			);
		await appendRevision(tx, id, previous.sourceId, revision, metadata, actor);
	});
}
