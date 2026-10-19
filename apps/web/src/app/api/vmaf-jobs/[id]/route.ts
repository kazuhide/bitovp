import type { PooledMetrics } from "@bitovp/core";
import { vmafExecutionSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import type {
	LiveReportMetadata,
	RenditionRef,
	VmafJobDetail,
	VmafResultDetail,
} from "@/app/qc/vmaf-shared";
import { getServerContext } from "@/lib/server/context";
import { deleteVmafJobLocally } from "@/lib/server/delete-jobs";
import { requireQcVmafEnabled } from "@/lib/server/feature-flags";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { downsampleFrameBlob } from "@/lib/server/vmaf-frames";
import { previewDescriptor } from "@/lib/server/vmaf-preview";

/**
 * `params.subsample`, when a worker recorded it; null otherwise.
 *
 * `n_subsample=N` scores every Nth frame, so the per-frame series is sparser and
 * the `min` can miss the transient worst frame while the pooled mean barely moves.
 * Two reports can be the same scoring generation and still not be comparable on
 * their minima, so this has to reach the UI. Absent ⇒ full precision, which is
 * every report written before the worker recorded it and every run with the env
 * unset (the default).
 */
function subsampleOf(params: unknown): number | null {
	if (typeof params !== "object" || params === null) {
		return null;
	}
	const value = (params as { subsample?: unknown }).subsample;
	return typeof value === "number" && Number.isInteger(value) && value > 1
		? value
		: null;
}

/** `params.reference`, when a worker recorded it; null otherwise. */
function referenceOf(
	params: unknown,
): { width?: number; height?: number; fps?: number } | null {
	if (typeof params !== "object" || params === null) {
		return null;
	}
	const reference = (params as { reference?: unknown }).reference;
	if (typeof reference !== "object" || reference === null) {
		return null;
	}
	const num = (x: unknown): number | undefined =>
		typeof x === "number" && Number.isFinite(x) ? x : undefined;
	const r = reference as { width?: unknown; height?: unknown; fps?: unknown };
	const out = {
		...(num(r.width) !== undefined ? { width: num(r.width) as number } : {}),
		...(num(r.height) !== undefined ? { height: num(r.height) as number } : {}),
		...(num(r.fps) !== undefined ? { fps: num(r.fps) as number } : {}),
	};
	return Object.keys(out).length > 0 ? out : null;
}

import {
	publicVmafTaskSelect,
	publicVmafTasks,
} from "@/lib/server/vmaf-task-progress";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * VMAF report detail. Returns the job + each result's renditionRef + EXACT
 * pooled metrics + a DOWNSAMPLED per-frame series (gunzip framesGzip →
 * bucket-min downsample to ≤ DOWNSAMPLE_CAP, worst frame pinned). The raw
 * blob can be ~270k frames (3h clip) — only the downsampled series crosses to
 * the browser; the full data is reachable via the export route.
 */
export async function GET(req: Request, { params }: RouteParams) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const job = await ctx.prisma.vmafJob.findUnique({
			where: { id },
			select: {
				id: true,
				encodingJobId: true,
				// The linked encoding's name (plan.name) — the report's human title.
				// LIVE jobs have no encodingJob, so this resolves to null.
				encodingJob: { select: { name: true, plan: true } },
				mode: true,
				model: true,
				scoringVersion: true,
				params: true,
				status: true,
				error: true,
				totalUnits: true,
				doneUnits: true,
				cores: true,
				threads: true,
				concurrency: true,
				createdAt: true,
				updatedAt: true,
				results: {
					orderBy: { createdAt: "asc" },
					select: {
						id: true,
						renditionRef: true,
						provenance: true,
						pooled: true,
					},
				},
			},
		});
		if (!job) {
			return jsonError(404, "Not found");
		}

		const results: VmafResultDetail[] = [];
		for (const r of job.results) {
			req.signal.throwIfAborted();
			const stored = await ctx.prisma.vmafResult.findFirst({
				where: { id: r.id, vmafJobId: id },
				select: { framesGzip: true },
			});
			req.signal.throwIfAborted();
			if (!stored) throw new Error("VMAF result is no longer available");
			const series = stored.framesGzip
				? await downsampleFrameBlob(stored.framesGzip, undefined, req.signal)
				: { frames: [], frameCount: 0 };
			// LIVE results carry the PR6a alignment block in pooled.live; lift it
			// out so the report can render the live panels (VOD pooled has no live).
			const pooledRaw = r.pooled as PooledMetrics & {
				live?: LiveReportMetadata;
			};
			const { live, ...pooled } = pooledRaw;
			results.push({
				id: r.id,
				renditionRef: r.renditionRef as RenditionRef,
				pooled: pooled as PooledMetrics,
				frames: series.frames,
				frameCount: series.frameCount,
				preview: previewDescriptor(id, job, r),
				...(live ? { live } : {}),
			});
		}

		const execution =
			vmafExecutionSchema.safeParse(
				typeof job.params === "object" &&
					job.params !== null &&
					"execution" in job.params
					? job.params.execution
					: { backend: "LOCAL" },
			).data ?? null;
		const computeTasks =
			execution?.backend === "CLOUD"
				? publicVmafTasks(
						await ctx.prisma.vmafComputeTask.findMany({
							where: { vmafJobId: id },
							orderBy: [{ createdAt: "asc" }, { attempt: "asc" }],
							select: publicVmafTaskSelect,
						}),
					)
				: [];
		const payload: VmafJobDetail = {
			execution,
			computeTasks,
			id: job.id,
			encodingJobId: job.encodingJobId,
			encodingName: job.encodingJob?.name ?? null,
			mode: job.mode,
			model: job.model,
			scoringVersion: job.scoringVersion,
			subsample: subsampleOf(job.params),
			status: job.status,
			error: job.error,
			totalUnits: job.totalUnits,
			doneUnits: job.doneUnits,
			cores: job.cores,
			threads: job.threads,
			concurrency: job.concurrency,
			createdAt: job.createdAt.toISOString(),
			updatedAt: job.updatedAt.toISOString(),
			// The worker records the SOURCE geometry in `params.reference` (no migration:
			// the column already existed and was empty). Read defensively — jobs written
			// before that existed carry `{}`, and the report says so rather than guessing
			// an upscale factor.
			reference: referenceOf(job.params),
			results,
		};
		return NextResponse.json(payload);
	} catch (err) {
		return routeError(err);
	}
}

/**
 * Delete a finished VMAF report (its frame report). LOCAL records only — VMAF
 * is entirely our own libvmaf pipeline, so there is no Bitmovin resource and
 * nothing in object storage to touch.
 *
 * Terminal-only: only FINISHED and ERROR are deletable. PENDING / RUNNING
 * return 409 (the worker is still scoring) so an in-flight run never loses its
 * row mid-write.
 *
 * The delete itself (atomic terminal guard, FK cascade, audit) lives in the
 * shared `deleteVmafJobLocally` helper, which the bulk-delete route runs per id.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	// : OFF means this surface does not exist for the deployment.
	// The recovery pair (qc-override, qc-report) is deliberately NOT gated.
	const disabled = await requireQcVmafEnabled();
	if (disabled) {
		return disabled;
	}
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const outcome = await deleteVmafJobLocally(await getServerContext(), id, {
			req,
		});
		if (!outcome.ok) {
			return jsonError(
				outcome.code === "NOT_FOUND" ? 404 : 409,
				outcome.message,
			);
		}
		return NextResponse.json({ id, deleted: true });
	} catch (err) {
		return routeError(err);
	}
}
