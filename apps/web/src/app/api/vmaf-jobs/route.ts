import type { PooledMetrics } from "@bitovp/core";
import {
	encodingPlanSchema,
	enumerateExistingMp4Targets,
	enumerateFrameIndexQcTargets,
	VMAF_FRAME_INDEX_SCORING_VERSION,
	VMAF_SCORING_VERSION,
	type VmafCloudProfile,
	vmafExecutionSchema,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import {
	autoTriggerKey,
	labManualTriggerKey,
	labManualTriggerPrefix,
	listVmafCloudProfiles,
} from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type RenditionRef,
	renditionLabel,
	type VmafJobListItem,
} from "@/app/qc/vmaf-shared";
import { getServerContext } from "@/lib/server/context";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { jsonError, routeError, validationError } from "@/lib/server/http";
import { getVmafQueue } from "@/lib/server/queue";

import {
	publicVmafTaskSelect,
	publicVmafTasks,
} from "@/lib/server/vmaf-task-progress";

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	/** Optional: only reports for this encoding job (drives the job-detail link). */
	encodingJobId: z.uuid().optional(),
});

/**
 * Lean VMAF Lab index. Selects the job columns + each result's renditionRef
 * and pooled JSON (cheap), but NEVER `framesGzip` (the per-frame blob is
 * detail/export-only). Per-rendition mean VMAF is lifted from pooled so the
 * index can show a quality-at-a-glance summary without decoding frames.
 */
export async function GET(req: Request) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		encodingJobId: url.searchParams.get("encodingJobId") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor, encodingJobId } = parsed.data;
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.vmafJob.findMany({
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(encodingJobId ? { where: { encodingJobId } } : {}),
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: {
				id: true,
				encodingJobId: true,
				// The linked encoding's name (plan.name) — the human label for the
				// report. LIVE jobs have no encodingJob, so this resolves to null.
				encodingJob: { select: { name: true } },
				mode: true,
				model: true,
				scoringVersion: true,
				params: true,
				triggerKey: true,
				status: true,
				error: true,
				createdAt: true,
				results: {
					orderBy: { createdAt: "asc" },
					select: { renditionRef: true, pooled: true },
				},
			},
		});
		const page = rows.slice(0, limit);
		const cloudIds = page
			.filter((job) => {
				if (job.status !== "PENDING" && job.status !== "RUNNING") return false;
				const params = job.params as { execution?: unknown } | null;
				return (
					vmafExecutionSchema.safeParse(params?.execution).data?.backend ===
					"CLOUD"
				);
			})
			.map((job) => job.id);
		const tasks = cloudIds.length
			? await ctx.prisma.vmafComputeTask.findMany({
					where: { vmafJobId: { in: cloudIds } },
					orderBy: [{ createdAt: "asc" }, { attempt: "asc" }],
					select: publicVmafTaskSelect,
				})
			: [];
		const items: VmafJobListItem[] = page.map((job) => ({
			id: job.id,
			localRetryAvailable:
				job.mode === "VOD" &&
				job.status === "ERROR" &&
				!!job.encodingJobId &&
				(job.triggerKey === autoTriggerKey(job.encodingJobId) ||
					job.triggerKey?.startsWith(
						labManualTriggerPrefix(job.encodingJobId),
					)) &&
				vmafExecutionSchema.safeParse(
					(job.params as { execution?: unknown } | null)?.execution ?? {
						backend: "LOCAL",
					},
				).data?.backend === "LOCAL",

			...(cloudIds.includes(job.id)
				? {
						computeTasks: publicVmafTasks(
							tasks.filter((task) => task.vmafJobId === job.id),
						).filter((task) => task.current),
					}
				: {}),
			encodingJobId: job.encodingJobId,
			encodingName: job.encodingJob?.name ?? null,
			mode: job.mode,
			model: job.model,
			scoringVersion: job.scoringVersion,
			status: job.status,
			error: job.error,
			createdAt: job.createdAt.toISOString(),
			renditionMeans: job.results.map((r, i) => ({
				label: renditionLabel(r.renditionRef as RenditionRef, i),
				mean: (r.pooled as PooledMetrics).mean,
			})),
		}));
		return NextResponse.json({
			items,
			nextCursor: rows.length > limit ? page[page.length - 1]?.id : undefined,
		});
	} catch (err) {
		return routeError(err);
	}
}

/** Measure an existing finished VOD job using its QC mirror, or its original
 * clear progressive MP4 outputs when no mirror was requested. Manual reports
 * never alter the original encoding's automatic QC decision.
 */
const measureExistingSchema = z.object({
	encodingJobId: z.uuid(),
	model: z.string().min(1).optional(),
	execution: vmafExecutionSchema.optional(),
	source: z.enum(["QC_MIRROR", "OUTPUT_MP4"]).optional(),
	psnr: z.boolean().optional(),
	measurementMethod: z.literal("FRAME_INDEX_BT709_10BIT").optional(),
});

export async function POST(req: Request) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const ctx = await getServerContext();
	if (ctx instanceof NextResponse) {
		return ctx;
	}
	try {
		const parsed = measureExistingSchema.safeParse(await req.json());
		if (!parsed.success) {
			return validationError(parsed.error);
		}
		const { encodingJobId } = parsed.data;
		const execution = parsed.data.execution ?? { backend: "LOCAL" as const };
		if (parsed.data.measurementMethod && execution.backend !== "CLOUD")
			return jsonError(
				400,
				"Frame-index measurement requires cloud validation",
			);
		let executionProfile: VmafCloudProfile | undefined;
		if (execution.backend === "CLOUD") {
			let profiles: VmafCloudProfile[];
			try {
				profiles = await listVmafCloudProfiles(
					ctx.prisma,
					process.env.VMAF_COMPUTE_PROFILES,
				);
			} catch {
				return jsonError(503, "Cloud compute profiles are unavailable");
			}
			executionProfile = profiles.find(
				(profile) => profile.id === execution.profileId,
			);
			if (!executionProfile) {
				return jsonError(400, "Unknown cloud compute profile");
			}
		}
		const job = await ctx.prisma.encodingJob.findUnique({
			where: { id: encodingJobId },
			select: { id: true, status: true, plan: true },
		});
		if (!job) {
			return jsonError(404, "Not found");
		}
		if (job.status !== "FINISHED") {
			return jsonError(
				409,
				`VMAF needs a FINISHED encode (status: ${job.status})`,
			);
		}
		const plan = encodingPlanSchema.safeParse(job.plan);
		if (!plan.success) {
			return jsonError(409, "The stored plan no longer parses");
		}
		const source =
			parsed.data.source ??
			(plan.data.qc?.vmaf || plan.data.qc?.psnr ? "QC_MIRROR" : "OUTPUT_MP4");
		if (
			source === "OUTPUT_MP4"
				? enumerateExistingMp4Targets(plan.data).length === 0
				: !(plan.data.qc?.vmaf || plan.data.qc?.psnr)
		) {
			return jsonError(
				409,
				"This job has no usable QC mirror or complete clear fixed-ladder MP4 outputs with a direct full-length source",
			);
		}
		if (
			parsed.data.measurementMethod &&
			source === "QC_MIRROR" &&
			enumerateFrameIndexQcTargets(plan.data).length === 0
		)
			return jsonError(
				409,
				"Frame-index measurement requires complete QC mirrors with a direct full-length source",
			);
		const model = parsed.data.model ?? plan.data.qc?.model ?? "vmaf_v0.6.1";
		let created: { id: string };
		try {
			created = await ctx.prisma.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${encodingJobId}::uuid FOR UPDATE`;
					const active = await tx.vmafJob.count({
						where: { encodingJobId, status: { in: ["PENDING", "RUNNING"] } },
					});
					if (active) throw new Error("VMAF_ALREADY_ACTIVE");
					const current = await tx.encodingJob.findUnique({
						where: { id: encodingJobId },
						select: { status: true },
					});
					if (current?.status !== "FINISHED")
						throw new Error("VMAF_ENCODING_CHANGED");
					const priorLabRuns = await tx.vmafJob.count({
						where: {
							triggerKey: { startsWith: labManualTriggerPrefix(encodingJobId) },
						},
					});
					return tx.vmafJob.create({
						data: {
							encodingJobId,
							mode: "VOD",
							model,
							scoringVersion: parsed.data.measurementMethod
								? VMAF_FRAME_INDEX_SCORING_VERSION
								: VMAF_SCORING_VERSION,
							status: "PENDING",
							params: {
								execution,
								source,
								...(parsed.data.psnr !== undefined
									? { psnr: parsed.data.psnr }
									: {}),
								...(parsed.data.measurementMethod
									? { measurementMethod: parsed.data.measurementMethod }
									: {}),
								...(executionProfile ? { executionProfile } : {}),
							} as Prisma.InputJsonValue,
							// One row per (job, model, ordinal): a re-measure with the same
							// model is a NEW row, deliberately — model comparisons need both.
							triggerKey: labManualTriggerKey(
								encodingJobId,
								model,
								priorLabRuns + 1,
							),
						},
						select: { id: true },
					});
				},
				{ isolationLevel: "Serializable" },
			);
		} catch (err) {
			if (
				err instanceof Error &&
				["VMAF_ALREADY_ACTIVE", "VMAF_ENCODING_CHANGED"].includes(err.message)
			)
				return jsonError(
					409,
					"A measurement is active or the encoding state has changed; refresh before measuring again",
				);
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				err.code === "P2034"
			)
				return jsonError(409, "A measurement for this job is already starting");
			// review-258 122-A1: two concurrent POSTs for the same (job, model)
			// both read N and both write N+1 — the loser's P2002 is a clean
			// "already starting", not a 500 (the auto trigger's sibling pattern).
			if (
				typeof err === "object" &&
				err !== null &&
				(err as { code?: string }).code === "P2002"
			) {
				return jsonError(409, "A measurement for this job is already starting");
			}
			throw err;
		}
		try {
			await getVmafQueue().add(
				"vmaf",
				{ vmafJobId: created.id },
				{ jobId: created.id, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		} catch (enqueueErr) {
			await ctx.prisma.vmafJob.update({
				where: { id: created.id },
				data: { status: "ERROR", error: "Enqueue failed — measure again" },
			});
			throw enqueueErr;
		}
		return NextResponse.json(
			{ id: created.id, mode: "VOD", status: "PENDING", model },
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
