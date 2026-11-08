import "server-only";
import {
	editingMediaStorageSchema,
	editingObjectSchema,
	editingOutputSchema,
	librarySourceSnapshotSchema,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import {
	listCapturedOriginalInputs,
	resolveCapturedOriginalInput,
} from "@bitovp/db";
import { describeStorageError, type ObjectIdentity } from "@bitovp/storage";
import { z } from "zod";
import {
	EXPECTED_ORGANIZATION_QUERY,
	passiveOrganizationBinding,
	requestOrganizationId,
} from "@/lib/passive-request";
import { getServerContext, type ServerContext } from "./context";
import { fixedDerivedLibraryObject } from "./library-derived-media";
import {
	loadAutomaticEditingCandidates,
	readAutomaticEditingOutputIdentity,
} from "./library-editing-candidates";
import { EditingRequestError, json, mediaView } from "./library-editing-common";
import { resolveAutomaticEditingContext } from "./library-editing-context";
import { libraryEditingHlsOutputs } from "./library-editing-hls-output";
import { libraryFileOutputsForSource } from "./library-playback";
import { serveObjectDownload } from "./object-download";
import { serveObjectPreview } from "./object-preview";
import { browserForCredentialId } from "./storage";

export async function captureEditingIdentity(
	ctx: ServerContext,
	source: { credentialId: string; bucket: string; path: string },
): Promise<ObjectIdentity> {
	const browser = await browserForCredentialId(
		ctx,
		source.credentialId,
		undefined,
		{ readTimeoutMs: 15_000 },
	);
	if (!browser?.headObject) {
		browser?.dispose?.();
		throw new EditingRequestError(422, "MEDIA_VERSION_UNVERIFIED");
	}
	try {
		const identity = await browser.headObject({
			bucket: source.bucket,
			key: source.path,
		});
		if (
			!Number.isSafeInteger(identity.size) ||
			identity.size <= 0 ||
			!(
				identity.etag ||
				(identity.versionId && identity.versionId !== "null") ||
				identity.generation
			)
		)
			throw new EditingRequestError(422, "MEDIA_VERSION_UNVERIFIED");
		return identity;
	} catch (error) {
		if (error instanceof EditingRequestError) throw error;
		const { status } = describeStorageError(error);
		throw new EditingRequestError(
			status === 404 ? 404 : 502,
			status === 404
				? "SOURCE_FILE_NOT_FOUND"
				: status === 403 || status === 401
					? "SOURCE_STORAGE_ACCESS_DENIED"
					: "SOURCE_READ_FAILED",
		);
	} finally {
		browser.dispose?.();
	}
}

async function sourceFiles(ctx: ServerContext, sourceId: string) {
	const source = await ctx.prisma.librarySource.findUnique({
		where: { id: sourceId },
	});
	if (!source) throw new EditingRequestError(404, "SOURCE_NOT_FOUND");
	const snapshot = librarySourceSnapshotSchema.parse(source.snapshot);
	const files = await libraryFileOutputsForSource(ctx.prisma, {
		jobId: source.jobId,
		planHash: snapshot.planHash,
		fileOutputs: snapshot.fileOutputs,
	});
	const progressive = files.filter(
		(file): file is (typeof files)[number] & { kind: "MP4" } =>
			file.kind === "MP4",
	);
	const hls = progressive.length
		? []
		: await libraryEditingHlsOutputs(
				ctx.prisma,
				source,
				snapshot,
				requestOrganizationId(ctx),
			);
	return {
		source,
		snapshot,
		files: [...progressive, ...hls],
	};
}
export async function editingEligibility(sourceId: string) {
	const ctx = await getServerContext();
	const { source, snapshot, files } = await sourceFiles(ctx, sourceId);
	const captured = await listCapturedOriginalInputs({
		prisma: ctx.prisma,
		organizationId: requestOrganizationId(ctx),
		sourceId,
	});
	const [media, analyses] = await Promise.all([
		ctx.prisma.libraryMediaVersion.findMany({
			where: { sourceId },
			orderBy: { createdAt: "desc" },
			take: 25,
		}),
		ctx.prisma.sceneAnalysisRevision.findMany({
			where: { sourceId },
			orderBy: { createdAt: "desc" },
			take: 25,
			select: {
				id: true,
				organizationId: true,
				sourceId: true,
				locale: true,
				rawHash: true,
				document: true,
				providerVersion: true,
				createdAt: true,
			},
		}),
	]);
	const candidates = await loadAutomaticEditingCandidates({
		prisma: ctx.prisma,
		organizationId: requestOrganizationId(ctx),
		source,
		recentAnalyses: analyses,
	});
	const automatic = await resolveAutomaticEditingContext({
		prisma: ctx.prisma,
		organizationId: requestOrganizationId(ctx),
		source,
		outputs: files,
		mediaVersions: candidates.media,
		analyses: candidates.analyses,
		candidateLimitExceeded: candidates.limitExceeded,
		readOutputIdentity: (output) =>
			readAutomaticEditingOutputIdentity(ctx, output),
	});
	const chosenMedia = candidates.media.find(
		(row) => row.id === automatic.mediaVersionId,
	);
	const chosenAnalysis = candidates.analyses.find(
		(row) => row.id === automatic.analysisRevisionId,
	);
	const displayedMedia =
		chosenMedia && !media.some((row) => row.id === chosenMedia.id)
			? [...media, chosenMedia]
			: media;
	const displayedAnalyses =
		chosenAnalysis && !analyses.some((row) => row.id === chosenAnalysis.id)
			? [...analyses, chosenAnalysis]
			: analyses;
	let localStoryAvailable = false;
	try {
		localStoryAvailable = !!readLocalSemanticConfiguration(process.env);
	} catch {
		// A partial operator configuration does not expose a selectable engine.
	}
	return {
		sourceId,
		storyAvailable: false,
		localStoryAvailable,
		captionTranslationAvailable: localStoryAvailable,
		automatic,
		files: [
			...captured.map((entry) => ({
				key: `captured:${entry.receiptId}`,
				label: `${entry.label} · ${entry.sourceFacts.fps.num}/${entry.sourceFacts.fps.den} fps`,
			})),
			...files.map((f) => ({
				key: f.key,
				label:
					snapshot.playbackLinks.find((link) => link.key === f.key)?.label ??
					f.kind,
			})),
		],
		mediaVersions: displayedMedia.map((row) => mediaView(ctx, row)),
		analyses: displayedAnalyses.map((a) => ({
			id: a.id,
			locale: a.locale,
			providerVersion: a.providerVersion,
			createdAt: a.createdAt,
			title: [
				a.providerVersion || "AISA",
				a.createdAt?.toISOString().replace("T", " ").replace(".000Z", " UTC"),
				a.id.slice(0, 8),
			]
				.filter(Boolean)
				.join(" · "),
		})),
	};
}
const prepareSchema = z.strictObject({
	fileKey: z.string().min(1).max(160),
	output: editingOutputSchema,
});
export async function requestEditingMedia(sourceId: string, value: unknown) {
	const input = prepareSchema.parse(value);
	const ctx = await getServerContext();
	const {
		source: librarySource,
		snapshot,
		files,
	} = await sourceFiles(ctx, sourceId);
	const captured = input.fileKey.startsWith("captured:")
		? await resolveCapturedOriginalInput({
				prisma: ctx.prisma,
				organizationId: requestOrganizationId(ctx),
				sourceId,
				receiptId: input.fileKey.slice(9),
			})
		: null;
	const source = captured
		? {
				credentialId: captured.storage.credentialId,
				bucket: captured.storage.bucket,
				path: captured.storage.key,
			}
		: files.find((f) => f.key === input.fileKey);
	if (!source) throw new EditingRequestError(422, "NO_EDITABLE_MP4");
	const derivedObject =
		librarySource.sourceKind === "DERIVED_RENDER" ||
		snapshot.kind === "DERIVED_RENDER"
			? await fixedDerivedLibraryObject(
					ctx,
					librarySource,
					snapshot,
					input.fileKey,
				)
			: null;
	const outputBrowser = await browserForCredentialId(
		ctx,
		input.output.credentialId,
	);
	try {
		if (
			!outputBrowser?.putObject ||
			!outputBrowser.headObject ||
			!outputBrowser.getObject
		)
			throw new EditingRequestError(422, "OUTPUT_WRITE_UNSUPPORTED");
	} finally {
		outputBrowser?.dispose?.();
	}
	const watches = await ctx.prisma.watchRule.findMany({
		where: {
			credentialId: input.output.credentialId,
			bucket: input.output.bucket,
			enabled: true,
		},
		select: { prefix: true },
	});
	const generatedPrefix =
		`${input.output.prefix.replace(/\/+$/, "")}/bitovp-editing/`.replace(
			/^\/+/,
			"",
		);
	if (
		watches.some(
			(watch) =>
				generatedPrefix.startsWith(watch.prefix) ||
				watch.prefix.startsWith(generatedPrefix),
		)
	)
		throw new EditingRequestError(422, "OUTPUT_WATCHED_INPUT");
	let pinnedSource = captured?.storage ?? derivedObject;
	if (!pinnedSource) {
		const identity = await captureEditingIdentity(ctx, source);
		pinnedSource = {
			credentialId: source.credentialId,
			bucket: source.bucket,
			key: source.path,
			size: identity.size,
			expect: {
				etag: identity.etag,
				versionId: identity.versionId,
				generation: identity.generation,
			},
		};
	}
	const storage = editingMediaStorageSchema.parse({
		source: pinnedSource,
		output: { ...input.output, prefix: generatedPrefix },
		...(!captured && "hlsRootPrefix" in source
			? { sourceFormat: "HLS", hlsRootPrefix: source.hlsRootPrefix }
			: {}),
	});
	const row = await ctx.prisma.libraryMediaVersion.create({
		data: {
			sourceId,
			credentialId: source.credentialId,
			outputCredentialId: input.output.credentialId,
			storage: json(storage),
		},
	});
	return mediaView(ctx, row);
}
export async function readEditingMedia(id: string) {
	const ctx = await getServerContext();
	const row = await ctx.prisma.libraryMediaVersion.findUnique({
		where: { id },
	});
	if (!row) throw new EditingRequestError(404, "MEDIA_NOT_FOUND");
	return mediaView(ctx, row);
}

export async function serveEditingObject(
	req: Request,
	id: string,
	kind: "MEDIA" | "ARTIFACT",
	download = false,
) {
	if (download && kind !== "ARTIFACT")
		throw new EditingRequestError(400, "INVALID_MEDIA_QUERY");
	const url = new URL(req.url);
	const binding = passiveOrganizationBinding(url, req.method);
	if (
		binding.kind === "invalid" ||
		[...url.searchParams.keys()].some(
			(key) => key !== EXPECTED_ORGANIZATION_QUERY,
		)
	)
		throw new EditingRequestError(400, "INVALID_MEDIA_QUERY");
	const ctx = await getServerContext();
	const organizationId = requestOrganizationId(ctx);
	if (url.searchParams.get(EXPECTED_ORGANIZATION_QUERY) !== organizationId)
		throw new EditingRequestError(409, "MEDIA_ORGANIZATION_CHANGED");
	let locator: unknown;
	let artifactSize: bigint | undefined;
	if (kind === "MEDIA") {
		const row = await ctx.prisma.libraryMediaVersion.findUnique({
			where: { id },
		});
		if (row?.state !== "READY")
			throw new EditingRequestError(404, "MEDIA_NOT_FOUND");
		locator = editingMediaStorageSchema.parse(row.storage).prepared;
	} else {
		const row = await ctx.prisma.renderArtifact.findUnique({
			where: { id, ...(download ? { organizationId } : {}) },
			include: { run: { select: { state: true } } },
		});
		if (
			row?.run.state !== "SUCCEEDED" ||
			(download && row.organizationId !== organizationId)
		)
			throw new EditingRequestError(404, "ARTIFACT_NOT_FOUND");
		locator = row.storage;
		artifactSize = row.size;
	}
	const target = editingObjectSchema.parse(locator);
	if (!target.size || !target.expect)
		throw new EditingRequestError(422, "MEDIA_VERSION_UNVERIFIED");
	if (download && BigInt(target.size) !== artifactSize)
		throw new EditingRequestError(422, "MEDIA_VERSION_UNVERIFIED");
	const previewTarget = {
		credentialId: target.credentialId,
		bucket: target.bucket,
		key: target.key,
		size: target.size,
		expect: { ...target.expect, size: target.size },
		contentType: "video/mp4",
	};
	return download
		? serveObjectDownload(ctx, req, previewTarget, id)
		: serveObjectPreview(ctx, req, previewTarget);
}
