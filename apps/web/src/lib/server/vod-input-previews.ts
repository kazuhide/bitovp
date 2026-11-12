import "server-only";
import { createHash } from "node:crypto";
import { masterKeyFromEnv } from "@bitovp/core";
import {
	getVodInputTimelineDurationMs,
	type VodInputPreviewTask,
	validateVodInputTimeline,
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
	vodInputPreviewTaskSchema,
} from "@bitovp/core/vod-input-timeline";
import type { VodInputPreviewTask as TaskRow } from "@bitovp/db";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import { getServerContext, type ServerContext } from "./context";
import { getVodInputPreviewQueue } from "./queue";

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
		facts.some((source) => !source.video.displayAspectRatio)
	) {
		throw new VodInputPreviewError(409, "SOURCE_PROBE_NOT_READY");
	}
}

async function requireCredentials(
	ctx: ServerContext,
	sources: { credentialId: string }[],
) {
	for (const credentialId of new Set(
		sources.map((source) => source.credentialId),
	)) {
		const credential = await ctx.credentials.get(credentialId);
		if (!credential)
			throw new VodInputPreviewError(404, "SOURCE_CREDENTIAL_NOT_FOUND");
	}
}

export async function getVodInputPreviewTaskRow(id: string) {
	const ctx = await previewContext();
	const row = await ownedRow(ctx, id);
	await requireCredentials(ctx, await sourcesForRow(ctx, row));
	const request = vodInputPreviewRequestSchema.parse(row.request);
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
	const input = vodInputPreviewRequestSchema.parse(value);
	const ctx = await previewContext();
	masterKeyFromEnv();
	let sourceExpiresAt: Date | undefined;
	if (input.kind === "PROBE") await requireCredentials(ctx, input.sources);
	else {
		const probe = await ownedRow(ctx, input.probeId);
		sourceExpiresAt = probe.expiresAt;
		if (probe.kind !== "PROBE" || probe.status !== "SUCCEEDED")
			throw new VodInputPreviewError(409, "SOURCE_PROBE_NOT_READY");
		const result = vodInputPreviewResultSchema.parse(probe.result);
		const issues = validateVodInputTimeline(
			input.document,
			result.sources ?? [],
		);
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
						now.getTime() + (input.kind === "PROBE" ? 24 : 2) * 3600_000,
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
	await requireCredentials(ctx, await sourcesForRow(ctx, row));
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
