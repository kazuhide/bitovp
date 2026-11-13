import "server-only";
import { createHash } from "node:crypto";
import { masterKeyFromEnv } from "@bitovp/core";
import {
	getVodInputTimelineDurationMs,
	MAX_VOD_INPUT_IMAGE_BYTES,
	VOD_INPUT_IMAGE_OUTPUT_PROVIDERS,
	type VodInputImagePrepareInput,
	type VodInputPreviewRequest,
	type VodInputPreviewTask,
	validateVodInputPreview,
	vodInputImagePrepareRequestSchema,
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
	vodInputPreviewSubmissionSchema,
	vodInputPreviewTaskSchema,
} from "@bitovp/core/vod-input-timeline";
import type { VodInputPreviewTask as TaskRow } from "@bitovp/db";
import {
	type ObjectStorageBrowser,
	UnsupportedBrowseError,
} from "@bitovp/storage";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import { getServerContext, type ServerContext } from "./context";
import { getVodInputPreviewQueue } from "./queue";
import { browserForCredentialId } from "./storage";

export class VodInputPreviewError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
	) {
		super(code);
		this.name = "VodInputPreviewError";
	}
}

async function previewContext(): Promise<ServerContext> {
	const ctx = await getServerContext();
	if (
		!ctx.tenant ||
		ctx.tenant.isImpersonating ||
		!roleAtLeast(ctx.tenant.role, "OPERATOR")
	)
		throw new AuthContextError(403, "VOD input editing requires an operator");
	return ctx;
}

export function toVodInputPreviewDto(
	row: Pick<
		TaskRow,
		| "id"
		| "kind"
		| "status"
		| "stage"
		| "requestHash"
		| "createdAt"
		| "expiresAt"
		| "result"
		| "error"
	>,
): VodInputPreviewTask {
	return vodInputPreviewTaskSchema.parse({
		id: row.id,
		kind: row.kind,
		status: row.status,
		stage: row.stage,
		requestHash: row.requestHash,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		...(row.result
			? { result: vodInputPreviewResultSchema.parse(row.result) }
			: {}),
		...(row.error ? { error: row.error } : {}),
	});
}

async function ownedRow(ctx: ServerContext, id: string): Promise<TaskRow> {
	z.uuid().parse(id);
	const row = await ctx.prisma.vodInputPreviewTask.findUnique({
		where: { id },
	});
	if (
		!row ||
		row.organizationId !== ctx.tenant?.organizationId ||
		row.expiresAt.getTime() <= Date.now()
	)
		throw new VodInputPreviewError(404, "PREVIEW_NOT_FOUND");
	return row;
}

async function sourcesForRow(ctx: ServerContext, row: TaskRow) {
	const request = vodInputPreviewRequestSchema.parse(row.request);
	if (request.kind === "PROBE") return request.sources;
	if (request.kind === "IMAGE_PREPARE") return [request.source, request.output];
	const probe = await ownedRow(ctx, request.probeId);
	const sourceRequest = vodInputPreviewRequestSchema.parse(probe.request);
	if (sourceRequest.kind !== "PROBE")
		throw new VodInputPreviewError(409, "SOURCE_PROBE_NOT_READY");
	return sourceRequest.sources;
}

function requireCurrentProbeGeometry(probe: TaskRow) {
	const parsed = vodInputPreviewResultSchema.safeParse(probe.result);
	const facts = parsed.success ? parsed.data.sources : undefined;
	if (
		probe.kind !== "PROBE" ||
		probe.status !== "SUCCEEDED" ||
		!facts?.length ||
		facts.some(
			(source) => source.video !== null && !source.video.displayAspectRatio,
		)
	) {
		throw new VodInputPreviewError(409, "SOURCE_PROBE_NOT_READY");
	}
}

async function requireCredentials(
	ctx: ServerContext,
	sources: { credentialId: string }[],
) {
	const available = [];
	for (const credentialId of new Set(
		sources.map((source) => source.credentialId),
	)) {
		const credential = await ctx.credentials.get(credentialId);
		if (!credential)
			throw new VodInputPreviewError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
		available.push(credential);
	}
	return available;
}

function requireImageOutputProvider(
	credentials: Awaited<ReturnType<typeof requireCredentials>>,
	credentialId: string,
) {
	const output = credentials.find(
		(credential) => credential.id === credentialId,
	);
	if (!output)
		throw new VodInputPreviewError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
	if (
		!(VOD_INPUT_IMAGE_OUTPUT_PROVIDERS as readonly string[]).includes(
			output.provider,
		)
	)
		throw new VodInputPreviewError(422, "IMAGE_OUTPUT_UNSUPPORTED");
}

async function sealImageSubmission(
	ctx: ServerContext,
	input: VodInputImagePrepareInput,
) {
	const credentials = await requireCredentials(ctx, [
		input.source,
		input.output,
	]);
	requireImageOutputProvider(credentials, input.output.credentialId);
	let output: ObjectStorageBrowser | null = null;
	try {
		output = await browserForCredentialId(
			ctx,
			input.output.credentialId,
			undefined,
			{ readTimeoutMs: 10_000 },
		);
		if (!output)
			throw new VodInputPreviewError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
		if (!output.headObject || !output.getObject || !output.putObject)
			throw new VodInputPreviewError(422, "IMAGE_OUTPUT_UNSUPPORTED");
	} catch (error) {
		if (error instanceof VodInputPreviewError) throw error;
		throw new VodInputPreviewError(
			error instanceof UnsupportedBrowseError ? 422 : 502,
			error instanceof UnsupportedBrowseError
				? "IMAGE_OUTPUT_UNSUPPORTED"
				: "SOURCE_ACCESS_UNAVAILABLE",
		);
	} finally {
		output?.dispose?.();
	}
	let source: ObjectStorageBrowser | null = null;
	try {
		source = await browserForCredentialId(
			ctx,
			input.source.credentialId,
			undefined,
			{ readTimeoutMs: 10_000 },
		);
		if (!source)
			throw new VodInputPreviewError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
		if (!source.headObject || !source.getObject)
			throw new VodInputPreviewError(422, "SOURCE_UNSUPPORTED");
		const head = await source.headObject({
			bucket: input.source.bucket,
			key: input.source.objectKey,
		});
		if (head.size > MAX_VOD_INPUT_IMAGE_BYTES)
			throw new VodInputPreviewError(422, "SOURCE_READ_LIMIT");
		const identity =
			vodInputImagePrepareRequestSchema.shape.sourceIdentity.safeParse({
				size: head.size,
				...(head.etag !== undefined ? { etag: head.etag } : {}),
				...(head.versionId !== undefined ? { versionId: head.versionId } : {}),
				...(head.generation !== undefined
					? { generation: head.generation }
					: {}),
			});
		if (!identity.success)
			throw new VodInputPreviewError(422, "SOURCE_UNVERIFIED");
		return vodInputImagePrepareRequestSchema.parse({
			...input,
			sourceIdentity: identity.data,
		});
	} catch (error) {
		if (error instanceof VodInputPreviewError) throw error;
		throw new VodInputPreviewError(
			error instanceof UnsupportedBrowseError ? 422 : 502,
			error instanceof UnsupportedBrowseError
				? "SOURCE_UNSUPPORTED"
				: "SOURCE_ACCESS_UNAVAILABLE",
		);
	} finally {
		source?.dispose?.();
	}
}

export async function getVodInputPreviewTaskRow(id: string) {
	const ctx = await previewContext();
	const row = await ownedRow(ctx, id);
	const credentials = await requireCredentials(
		ctx,
		await sourcesForRow(ctx, row),
	);
	const request = vodInputPreviewRequestSchema.parse(row.request);
	if (request.kind === "IMAGE_PREPARE")
		requireImageOutputProvider(credentials, request.output.credentialId);
	if (request.kind === "PREVIEW")
		requireCurrentProbeGeometry(await ownedRow(ctx, request.probeId));
	return row;
}
export async function getVodInputPreviewTask(id: string) {
	return toVodInputPreviewDto(await getVodInputPreviewTaskRow(id));
}

export async function createVodInputPreviewTask(
	value: unknown,
): Promise<VodInputPreviewTask> {
	const submission = vodInputPreviewSubmissionSchema.parse(value);
	const ctx = await previewContext();
	masterKeyFromEnv();
	const input: VodInputPreviewRequest =
		submission.kind === "IMAGE_PREPARE"
			? await sealImageSubmission(ctx, submission)
			: submission;
	let sourceExpiresAt: Date | undefined;
	if (input.kind === "PROBE") await requireCredentials(ctx, input.sources);
	else if (input.kind === "PREVIEW") {
		const probe = await ownedRow(ctx, input.probeId);
		sourceExpiresAt = probe.expiresAt;
		if (probe.kind !== "PROBE" || probe.status !== "SUCCEEDED")
			throw new VodInputPreviewError(409, "SOURCE_PROBE_NOT_READY");
		const result = vodInputPreviewResultSchema.parse(probe.result);
		const issues = validateVodInputPreview(input, result.sources ?? []);
		if (issues[0]) throw new VodInputPreviewError(422, issues[0].code);
		// Old cached previews may have lost anamorphic/rotation geometry.
		// Re-probe before cache lookup as well as before serving their content.
		requireCurrentProbeGeometry(probe);
		if (input.range.startMs >= getVodInputTimelineDurationMs(input.document))
			throw new VodInputPreviewError(422, "PREVIEW_RANGE_INVALID");
		await requireCredentials(ctx, await sourcesForRow(ctx, probe));
	}
	const now = new Date();
	const requestHash = createHash("sha256")
		.update(JSON.stringify(input))
		.digest("hex");
	const organizationId = ctx.tenant?.organizationId;
	if (!organizationId)
		throw new AuthContextError(403, "Organization is required");
	const { row, created } = await ctx.prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:vod-preview:${requestHash}`}, 0))`;
		// In-flight work belongs to its requesting editor and can be canceled there.
		// Only immutable completed previews can be shared between editor instances.
		const previous =
			input.kind === "PREVIEW"
				? await tx.vodInputPreviewTask.findFirst({
						where: {
							kind: input.kind,
							requestHash,
							expiresAt: { gt: now },
							status: "SUCCEEDED",
						},
						orderBy: { createdAt: "desc" },
					})
				: null;
		if (previous) return { row: previous, created: false };
		const task = await tx.vodInputPreviewTask.create({
			data: {
				kind: input.kind,
				status: "PENDING",
				stage: "QUEUED",
				requestHash,
				request: input,
				...(input.kind === "PREVIEW" ? { probeId: input.probeId } : {}),
				createdBy: ctx.tenant?.actorUserId,
				expiresAt: new Date(
					Math.min(
						now.getTime() + (input.kind === "PREVIEW" ? 2 : 24) * 3600_000,
						sourceExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
					),
				),
			},
		});
		return { row: task, created: true };
	});
	if (created) {
		try {
			await getVodInputPreviewQueue().add(
				"vod-input-preview",
				{ taskId: row.id },
				{
					jobId: row.id,
					attempts: 1,
					removeOnComplete: 500,
					removeOnFail: 500,
				},
			);
		} catch {
			await ctx.prisma.vodInputPreviewTask.updateMany({
				where: { id: row.id, status: "PENDING" },
				data: {
					status: "FAILED",
					stage: "FAILED",
					finishedAt: new Date(),
					error: {
						code: "PREVIEW_QUEUE_UNAVAILABLE",
						message: "Preview queue is unavailable. Try again.",
					},
				},
			});
			throw new VodInputPreviewError(503, "PREVIEW_QUEUE_UNAVAILABLE");
		}
	}
	return toVodInputPreviewDto(row);
}

export async function cancelVodInputPreviewTask(
	id: string,
): Promise<VodInputPreviewTask> {
	const ctx = await previewContext();
	const row = await ownedRow(ctx, id);
	const credentials = await requireCredentials(
		ctx,
		await sourcesForRow(ctx, row),
	);
	const request = vodInputPreviewRequestSchema.parse(row.request);
	if (request.kind === "IMAGE_PREPARE")
		requireImageOutputProvider(credentials, request.output.credentialId);
	if (["PENDING", "RUNNING"].includes(row.status)) {
		const now = new Date();
		await ctx.prisma.vodInputPreviewTask.updateMany({
			where: { id, status: { in: ["PENDING", "RUNNING"] } },
			data: {
				status: "CANCELED",
				stage: "CANCELED",
				cancelRequestedAt: now,
				finishedAt: now,
			},
		});
	}
	return toVodInputPreviewDto(await ownedRow(ctx, id));
}
