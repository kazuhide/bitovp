import "server-only";
import {
	encodingPlanSchema,
	planHasErrors,
	submitEncodingJob,
	validatePlan,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { listVmafCloudProfiles } from "@bitovp/db";
import type { ServerContext } from "@/lib/server/context";
import {
	recordUnrestrictedEgress,
	submitterValidationOptions,
} from "@/lib/server/plan-validation";
import type { getOrchestratorQueue } from "@/lib/server/queue";
import { readFeatureFlags } from "./feature-flags";

/**
 * Dependencies the re-run helper needs — passed in (not imported) so routes
 * and tests share one create pipeline without re-resolving the context.
 */
export type ReRunDeps = {
	prisma: ServerContext["prisma"];
	bitmovinAccounts: ServerContext["bitmovinAccounts"];
	/** Rail 3b's resolver  — a re-run is a submitter like any
	 * other, and the door that forgets it is the one that stays quiet. */
	credentials: ServerContext["credentials"];
	queue: ReturnType<typeof getOrchestratorQueue>;
	/**
	 * Who asked for the re-run . Required so a caller states it:
	 * this path reaches the shared egress recorder, which has no Request of
	 * its own, and `null` is the honest value when there is no verified actor.
	 */
	actor: string | null;
};

/** A source-plan parse/validation failure (caller maps to a 400/409). */
export class ReRunPlanError extends Error {
	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ReRunPlanError";
	}
}

/**
 * Re-runs a finished/errored job through CORE's submitEncodingJob — the
 * SAME pipeline as POST /api/encoding-jobs ( PR1; this file was
 * the second near-copy the extraction folded). The source job is NEVER
 * mutated — each call mints a distinct id.
 *
 * Kept behavior: plan problems throw ReRunPlanError with the messages the
 * re-run route has always mapped; enqueue failures mark the new row ERROR
 * then rethrow. ONE recorded change: the egress POLICY row is now filed
 * AFTER the account-id check (the route's order — pipeline comment), so a
 * validated source plan with no account id no longer writes one.
 *
 * Caller is responsible for any MASTER_KEY fail-fast (masterKeyFromEnv)
 * before invoking, same as the POST route.
 */
export async function reRunJob(
	deps: ReRunDeps,
	sourceJob: { id: string; plan: unknown },
): Promise<{ sourceId: string; newId: string }> {
	// Pre-parse for the re-run-specific error MESSAGES (the pipeline's own
	// refusals are phrased for the create route).
	const parsedPlan = encodingPlanSchema.safeParse(sourceJob.plan);
	if (!parsedPlan.success) {
		throw new ReRunPlanError(
			"Source job plan is invalid",
			parsedPlan.error.flatten(),
		);
	}
	// The SUBMITTER options, with the resolved credential-provider map — the
	// same helper the create door uses (AKR-E57-005).
	//
	// Re-runs use the same server validation context as newly submitted jobs.
	const validationOptions = await submitterValidationOptions(
		deps.prisma,
		deps.credentials,
	);
	//  (review finding 3), the `skipDeliveryCommitment` precedent
	// applied to the same shape: a QC-readability rail added later must not
	// retroactively make a FINISHED job un-re-runnable. The job already
	// encoded and delivered; only its measurement failed, and there is no
	// in-app way to strip `qc` from a persisted plan. Passed to BOTH doors
	// below — the pre-validation and the submit pipeline — because passing it
	// to one refuses late instead of early, which is the same defect wearing a
	// different timestamp (the comment above says so for the egress option).
	const rerunValidationOptions = {
		...validationOptions,
		demoteQcIoReadable: true,
		// #192 (review): a job that FINISHED before the unpackaged-audio rail
		// existed must stay re-runnable. History is not re-litigated — the same
		// rule `skipDeliveryCommitment` below follows, and the same demote-don't-
		// skip shape as `demoteQcIoReadable` above, so the operator still sees
		// the warning that their delivery is silent.
		demoteUnmuxedAudio: true,
	};
	const preIssues = validatePlan(parsedPlan.data, rerunValidationOptions);
	if (planHasErrors(preIssues)) {
		throw new ReRunPlanError("Source job plan failed validation", {
			issues: preIssues,
		});
	}
	const outcome = await submitEncodingJob(sourceJob.plan, {
		internalHevcV2AccountId: process.env.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
		//  (review-265 131-A2): a re-run hands us a plan authored
		// when QC may have been ON. Without this, one click on an old QC'd job
		// minted a permanently-parked one.
		qcVmafEnabled: async () => (await readFeatureFlags(deps.prisma)).qcVmaf,
		cloudVmafProfileAvailable: async (profileId) =>
			(
				await listVmafCloudProfiles(
					deps.prisma,
					process.env.VMAF_COMPUTE_PROFILES,
				)
			).some((profile) => profile.id === profileId),
		validationOptions: rerunValidationOptions,
		// A delivery commitment recorded when this job was FIRST submitted is
		// not re-litigated: the spec is ordinary code and may have been
		// tightened since, and there is no in-app way to strip the field from
		// a persisted plan .
		skipDeliveryCommitment: true,
		recordEgress: (issues, bitmovinAccountId) =>
			recordUnrestrictedEgress(deps.prisma, issues, {
				path: "/api/encoding-jobs/[id]/re-run",
				bitmovinAccountId,
				actor: deps.actor,
			}),
		loadAccountDefaults: (accountId) => deps.bitmovinAccounts.get(accountId),
		createJob: async (data) =>
			deps.prisma.encodingJob.create({
				data: {
					...data,
					// #32 §5: the re-runner is the acting user/token, not the
					// original job's creator — a re-run is a new act.
					createdBy: deps.actor,
					plan: data.plan as unknown as Prisma.InputJsonValue,
					stepLog: data.stepLog as unknown as Prisma.InputJsonValue,
				},
				select: { id: true },
			}),
		enqueue: async (jobId) => {
			await deps.queue.add(
				"orchestrate",
				{ encodingJobId: jobId },
				{ jobId, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		},
		markEnqueueFailed: async (jobId) => {
			await deps.prisma.encodingJob.update({
				where: { id: jobId },
				data: { status: "ERROR", error: "Enqueue failed — retry the job" },
			});
		},
	});
	if (!outcome.ok) {
		// PARSE/VALIDATION were pre-checked above; these are the two the
		// pre-check cannot see.
		throw new ReRunPlanError(
			outcome.code === "NO_ACCOUNT_ID"
				? "Source job plan carries no Bitmovin account id"
				: outcome.code === "ACCOUNT_MISSING"
					? "Bitmovin account no longer exists"
					: outcome.message,
		);
	}
	return { sourceId: sourceJob.id, newId: outcome.id };
}
