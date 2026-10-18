import {
	type EncodingPlan,
	VMAF_FRAME_INDEX_SCORING_VERSION,
	VMAF_SCORING_VERSION,
	type VmafCloudProfile,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { autoTriggerKey, listVmafCloudProfiles } from "@bitovp/db";
import { qcVmafEnabled } from "../settings/feature-flags";

/**
 * VOD → VMAF trigger (P4-PR3). The orchestrator calls this once a VOD
 * encoding reaches FINISHED (its onVodFinished hook). When the plan asked
 * for VMAF, it creates a VmafJob row (mode VOD, model from plan.qc.model)
 * and enqueues `{ vmafJobId }` on the vmaf-runner queue.
 *
 * IDEMPOTENT — this is the riskiest part, so it guards three ways:
 *  1. A pre-check: if a VmafJob already exists for the encodingJob, do
 *     nothing (a retried/duplicated FINISHED must not spawn a second run).
 *  2. The create carries `triggerKey = "vod-auto:<encodingJobId>"`, which is
 *     UNIQUE in the DB  — two FINISHED deliveries racing past the
 *     pre-check on different workers cannot both insert; the loser sees the
 *     unique violation and returns. Manual captures / future re-runs leave
 *     triggerKey null (Postgres unique ignores nulls), so only the AUTO
 *     trigger is deduped.
 *  3. The enqueue uses jobId = vmafJobId, so a redelivered enqueue of the
 *     same row dedupes at the queue.
 *
 * The create + enqueue are intentionally NOT a single transaction: a
 * created-but-not-enqueued row is recoverable (a PENDING VmafJob with no
 * queued job can be re-enqueued), whereas an enqueued-but-uncreated job
 * would 404 in the runner. So we create first, then enqueue.
 */

/**
 * Prisma unique-constraint violation (P2002) ON THE triggerKey CONSTRAINT,
 * matched structurally so this file keeps its type-only dependency on
 * @bitovp/db (no runtime error-class import; `code`/`meta` are public fields
 * of PrismaClientKnownRequestError). The constraint is named so a future
 * second unique on VmafJob can never be silently swallowed as "lost the
 * race" — an unrecognized P2002 rethrows like any other error.
 */
function isTriggerKeyUniqueViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const e = err as { code?: unknown; meta?: { target?: unknown } };
	if (e.code !== "P2002") {
		return false;
	}
	// Postgres reports meta.target as string[]; String flattens both that
	// and the plain-string shape some adapters use.
	return String(e.meta?.target ?? "").includes("triggerKey");
}

/** Structural vmaf queue surface — bullmq's Queue satisfies it. */
export type VmafQueueLike = {
	add(
		name: string,
		data: { vmafJobId: string },
		opts: { jobId: string; removeOnComplete: number; removeOnFail: number },
	): Promise<unknown>;
};

export type VmafTriggerDeps = {
	prisma: AppPrismaClient;
	queue: VmafQueueLike;
	allowNewWork?: () => Promise<boolean>;
};

export function createVmafTrigger(deps: VmafTriggerDeps) {
	return async function onVodFinished(args: {
		encodingJobId: string;
		plan: EncodingPlan;
	}): Promise<void> {
		if (deps.allowNewWork && !(await deps.allowNewWork())) return;
		// Gate in lockstep with the compiler/enumerateQcTargets QC-mirror gate:
		// PSNR rides the same libvmaf pass, so a psnr-only plan must enqueue too
		// (the runner computes VMAF unconditionally and adds PSNR when asked).
		if (!(args.plan.qc?.vmaf || args.plan.qc?.psnr)) {
			return; // plan requested neither VMAF nor PSNR — nothing to do
		}
		// : read the flag AT FIRE TIME, not at worker start — the
		// operator can flip it mid-run and the next FINISHED encode must obey
		// the current setting. OFF stops NEW work only; the vmaf-runner
		// consumer stays registered so rows that already exist still drain.
		// Not `!enabled`: null (unreadable) creates nothing here, which is the
		// safe direction for a CREATOR — review-265 131-B1.
		if ((await qcVmafEnabled(deps.prisma)) !== true) {
			console.info(
				`[vmaf-trigger] ${args.encodingJobId}: QC/VMAF is off for this deployment — no measurement created`,
			);
			return;
		}
		// Idempotency guard: never create a second VMAF job for an encoding
		// that already has one (a re-delivered FINISHED, a manual re-run).
		const existing =
			(await deps.prisma.vmafJob.findFirst({
				where: {
					encodingJobId: args.encodingJobId,
					triggerKey: autoTriggerKey(args.encodingJobId),
				},
				select: { id: true, status: true },
			})) ??
			(await deps.prisma.vmafJob.findFirst({
				where: { encodingJobId: args.encodingJobId },
				select: { id: true, status: true },
			}));
		if (existing) {
			// review-201 C1: a PENDING row is re-ENQUEUED, not just tolerated.
			// The create→enqueue gap is deliberately non-transactional (see
			// above), and this pre-check used to short-circuit on the row a
			// crashed/failed attempt had already created — so the recovery
			// this comment promised ("a PENDING VmafJob with no queued job can
			// be re-enqueued") had NO code performing it: the AWAITING_QC
			// boundary re-fires this trigger on every pass, and every pass
			// returned here. jobId dedupe makes the re-add free when the job
			// IS queued, and the wedge exit when it is not.
			if (existing.status === "PENDING") {
				await deps.queue.add(
					"vmaf",
					{ vmafJobId: existing.id },
					{ jobId: existing.id, removeOnComplete: 1000, removeOnFail: 1000 },
				);
			}
			return;
		}
		// Existing reports own their execution snapshot; only NEW reports resolve
		// current tenant profiles. Profile changes never mutate a queued retry.
		const execution = args.plan.qc.execution ?? { backend: "LOCAL" as const };
		let executionProfile: VmafCloudProfile | undefined;
		let profileError: string | undefined;
		if (execution.backend === "CLOUD") {
			try {
				executionProfile = (
					await listVmafCloudProfiles(
						deps.prisma,
						process.env.VMAF_COMPUTE_PROFILES,
					)
				).find((profile) => profile.id === execution.profileId);
				if (!executionProfile)
					profileError = "Unknown or disabled cloud compute profile";
			} catch {
				// Never persist raw configuration/database errors or silently use Local.
				profileError = "Cloud compute profiles are unavailable";
			}
		}
		let created: { id: string };
		try {
			created = await deps.prisma.vmafJob.create({
				data: {
					encodingJobId: args.encodingJobId,
					mode: "VOD",
					model: args.plan.qc.model,
					// Explicit, not the column default: the default is 1 so the
					// migration labels historical rows correctly, which means a new
					// row that relied on it would claim to be pre-fix.
					scoringVersion: args.plan.qc.measurementMethod
						? VMAF_FRAME_INDEX_SCORING_VERSION
						: VMAF_SCORING_VERSION,
					status: profileError ? "ERROR" : "PENDING",
					...(profileError
						? { error: profileError, finishedAt: new Date() }
						: {}),
					params: {
						execution,
						...(args.plan.qc.measurementMethod
							? {
									source: "QC_MIRROR",
									measurementMethod: args.plan.qc.measurementMethod,
								}
							: {}),
						...(executionProfile ? { executionProfile } : {}),
					} as Prisma.InputJsonValue,
					triggerKey: autoTriggerKey(args.encodingJobId),
				},
				select: { id: true },
			});
		} catch (err) {
			if (isTriggerKeyUniqueViolation(err)) {
				// Lost the cross-worker race — the winner owns create + enqueue.
				console.info(
					`[vmaf-trigger] lost auto-create race for encoding ${args.encodingJobId} — another worker enqueues`,
				);
				return;
			}
			throw err;
		}
		// Retain a failed report for the FINISHED best-effort tail. At the
		// AWAITING_QC boundary the orchestrator catches this and persists ERROR,
		// so a disabled/removed profile cannot leave the encoding parked forever.
		if (profileError) throw new Error(profileError);
		// jobId = vmafJobId dedupes any retry/redelivery at the queue too.
		await deps.queue.add(
			"vmaf",
			{ vmafJobId: created.id },
			{ jobId: created.id, removeOnComplete: 1000, removeOnFail: 1000 },
		);
	};
}

export type VmafTrigger = ReturnType<typeof createVmafTrigger>;
