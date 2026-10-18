import "server-only";
import { createHash } from "node:crypto";
import type { AppPrismaClient } from "@bitovp/db";
import {
	isActiveVmafStatus,
	VMAF_STATUSES,
	type VmafStatus,
} from "@/app/qc/vmaf-shared";
import { isActiveJobStatus, JOB_STATUSES, type JobStatus } from "../job-status";
import { writeAuditLog } from "./audit";
import type { ServerContext } from "./context";

/**
 * The single LOCAL-delete implementation for VOD jobs and VMAF reports, shared
 * by the per-id DELETE routes and the bulk-delete routes — the same
 * one-pipeline-two-callers arrangement `reRunJob` gives bulk-re-run, so the
 * bulk path cannot drift from the single path's terminal guard, cascade order or
 * audit record.
 *
 * LOCAL records only: no Bitmovin call and nothing in object storage is touched.
 * A remote encoding (if any) is left exactly as it is; VMAF is entirely our own
 * libvmaf pipeline, so a report has no remote counterpart at all.
 *
 * The terminal check is enforced ATOMICALLY inside the transaction (a
 * status-guarded `deleteMany` whose count is asserted), mirroring the
 * atomic-claim convention of the cancel/retry routes. The up-front `findUnique`
 * only serves the clean NOT_FOUND / ACTIVE outcomes — it does NOT gate the
 * delete, so a row that leaves the terminal set between the read and the write
 * (e.g. /retry claiming ERROR→QUEUED and enqueuing concurrently) is not deleted
 * out from under the orchestrator: the guard matches 0 rows, the whole
 * transaction rolls back (dependents restored) and the caller gets RACED.
 */

/** Sentinel: the atomic terminal-guard matched 0 rows → roll back the tx. */
class NotDeletable extends Error {}

/** Sentinel: a dependent VMAF report is still scoring → roll back the tx. */
/** Exported so the live-channel delete shares the sentinel, not a copy. */
export class VmafStillScoring extends Error {}

export class AisaSnapshotRequired extends Error {
	constructor(readonly jobId: string) {
		super(
			`Capture AI Scene Analysis from job ${jobId} into the Library before deleting or resetting its history.`,
		);
	}
}

/** A captured source owns the durable plan/playback/QC snapshot, even before ingestion. */
export async function assertAisaSnapshotCaptured(
	prisma: Pick<AppPrismaClient, "encodingJob" | "librarySource">,
	jobIds?: string[],
) {
	const jobs = await prisma.encodingJob.findMany({
		where: { status: "FINISHED", ...(jobIds ? { id: { in: jobIds } } : {}) },
		select: { id: true, plan: true, bitmovinEncodingId: true },
	});
	for (const job of jobs) {
		if (
			!job.plan ||
			typeof job.plan !== "object" ||
			Array.isArray(job.plan) ||
			!job.plan.aiSceneAnalysis
		)
			continue;
		const hash = (value: unknown) =>
			createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const sourceKey = hash([job.id, job.bitmovinEncodingId, hash(job.plan)]);
		const captured = await prisma.librarySource.findUnique({
			where: { sourceKey },
			select: { id: true },
		});
		if (!captured) throw new AisaSnapshotRequired(job.id);
	}
}

export type LocalDeleteOutcome =
	| { ok: true; deletedVmafJobs: number }
	| { ok: false; code: "NOT_FOUND" | "ACTIVE" | "RACED"; message: string };

/** Statuses the orchestrator owns — never deletable (cancel them first). */
/**
 * Derived from the shared predicate rather than re-listed, because
 * `job-status.ts` DOCUMENTS itself as the single source of truth for this and
 * STATUS.md repeats the claim — and this file was quietly the counter-example,
 * with a local array here AND a hand-written `=== "QUEUED" || === "RUNNING"` at
 * the pre-check (review catch). Three spellings meant adding a status to the
 * predicate would hide the UI's delete button while this route still deleted the
 * row out from under the orchestrator.
 */
const JOB_ACTIVE_STATUSES = JOB_STATUSES.filter(isActiveJobStatus);
/** VMAF terminal set (the worker is still scoring in PENDING/RUNNING). */
/**
 * Derived from `isActiveVmafStatus`, which already documents itself as the
 * single source of truth for exactly this — "so the DELETE/bulk-delete routes'
 * 409 guards and the UI's disabled sets can't drift".
 *
 * The previous commit fixed that duplication for the JOB status one line above
 * and then RE-CREATED it for the VMAF status, exporting the copy to a third
 * file. Worse, behind `server-only`, so the UI could never converge on it
 * (review catch). Adding `CANCELED` to `VmafStatus` would have enabled the QC
 * UI's Delete while these guards read the row as still-scoring, making the
 * parent job and its channel permanently undeletable.
 */
export const VMAF_TERMINAL_STATUSES = VMAF_STATUSES.filter(
	(status) => !isActiveVmafStatus(status),
);

/**
 * Deletes a terminal encoding job and ITS local dependents.
 *
 * Cascade: ManifestJob is FK `onDelete: Cascade`, so it goes automatically.
 * VmafJob's FK is `onDelete: SetNull` (a report can outlive its job), so it is
 * NOT cascaded by the FK — this job's VmafJobs are deleted explicitly FIRST
 * (each cascading its VmafResults by FK). Doing the dependents before the
 * guarded parent delete means a rollback (guard miss) restores them too.
 *
 * A NON-TERMINAL VMAF report BLOCKS the delete (ACTIVE), rather than being
 * destroyed with the job. Three reasons, and the first is the decisive one:
 *  - `deleteVmafJobLocally` right below refuses exactly the same row ("VMAF
 *    report is still {status} — wait for it to finish"). A report that cannot
 *    be deleted directly must not be deletable through its parent;
 *  - the VMAF worker is mid-write on a PENDING/RUNNING report, so deleting it
 *    races an active scoring run;
 *  - the alternative reading of `onDelete: SetNull` — orphan it and let it
 *    finish — does not survive contact with the pipeline: the scorer resolves
 *    its distorted keys THROUGH the encoding job, so an orphaned in-flight
 *    report is a guaranteed failure, not a report that outlives its job. The
 *    FK's "a report can outlive its job" intent is about FINISHED reports,
 *    which this path still deletes.
 * The encoding job only has to be terminal, and a VMAF run triggered on a
 * just-finished encode sits PENDING/RUNNING for minutes, so this is the happy
 * path, not a corner case — and bulk-delete amplifies it 50× per request.
 *
 * `via` records the calling endpoint in the audit request snapshot; the audit
 * `path` stays the RESOURCE path either way, because the audited operation is
 * "this job was deleted".
 */
export async function deleteEncodingJobLocally(
	ctx: ServerContext,
	id: string,
	options: { via?: string; req: Request },
): Promise<LocalDeleteOutcome> {
	const row = await ctx.prisma.encodingJob.findUnique({
		where: { id },
		select: { id: true, status: true, bitmovinAccountId: true },
	});
	if (!row) {
		return { ok: false, code: "NOT_FOUND", message: "Not found" };
	}
	if (isActiveJobStatus(row.status as JobStatus)) {
		return {
			ok: false,
			code: "ACTIVE",
			message: `Job is still ${row.status} — cancel it before deleting`,
		};
	}
	// Clean ACTIVE outcome for the ordinary case; the transaction re-asserts it
	// atomically below, so this read is not what gates the delete.
	const scoring = await ctx.prisma.vmafJob.findFirst({
		where: {
			encodingJobId: id,
			status: { notIn: [...VMAF_TERMINAL_STATUSES] },
		},
		select: { status: true },
	});
	if (scoring) {
		return {
			ok: false,
			code: "ACTIVE",
			message: `A VMAF report for this job is still ${scoring.status} — wait for it to finish before deleting`,
		};
	}
	let deletedVmafJobs: number;
	try {
		deletedVmafJobs = await ctx.prisma.$transaction(async (tx) => {
			// Same row lock as requestLibrarySource: capture and delete cannot cross.
			await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE id = ${id}::uuid FOR UPDATE`;
			await assertAisaSnapshotCaptured(tx, [id]);
			// Re-assert inside the tx: a report that entered PENDING between the
			// read above and here must not be deleted out from under the scorer.
			const stillScoring = await tx.vmafJob.count({
				where: {
					encodingJobId: id,
					status: { notIn: [...VMAF_TERMINAL_STATUSES] },
				},
			});
			if (stillScoring > 0) {
				throw new VmafStillScoring();
			}
			// Status-guarded, matching the assertion above: never a bare
			// deleteMany, so the two can not drift.
			const vmafJobs = await tx.vmafJob.deleteMany({
				where: {
					encodingJobId: id,
					status: { in: [...VMAF_TERMINAL_STATUSES] },
				},
			});
			const { count } = await tx.encodingJob.deleteMany({
				where: { id, status: { notIn: [...JOB_ACTIVE_STATUSES] } },
			});
			if (count === 0) {
				throw new NotDeletable();
			}
			return vmafJobs.count;
		});
	} catch (err) {
		if (err instanceof AisaSnapshotRequired) {
			return { ok: false, code: "ACTIVE", message: err.message };
		}
		if (err instanceof VmafStillScoring) {
			return {
				ok: false,
				code: "ACTIVE",
				message:
					"A VMAF report for this job started scoring — wait for it to finish before deleting",
			};
		}
		if (err instanceof NotDeletable) {
			return {
				ok: false,
				code: "RACED",
				message: "Job changed state and was not deleted — refresh and retry",
			};
		}
		throw err;
	}
	// The row is GONE by here — the transaction committed. `writeAuditLog`
	// swallows its own failures (packages/db), but wrapping it anyway states the
	// contract: an audit problem must never be reported as "not deleted". The
	// bulk routes turn a throw here into `skipped`, so the operator would read
	// "4 deleted, 1 skipped" about a job that no longer exists, and a retry would
	// answer "Not found" (review catch).
	await writeAuditLog(
		ctx,
		{
			method: "DELETE",
			path: `/api/encoding-jobs/${id}`,
			statusCode: 200,
			...(row.bitmovinAccountId
				? { bitmovinAccountId: row.bitmovinAccountId }
				: {}),
			...(options.via ? { request: { via: options.via } } : {}),
			response: { id, deletedVmafJobs },
		},
		options.req,
	);
	return { ok: true, deletedVmafJobs };
}

/**
 * Deletes a finished/errored VMAF report (its frame results cascade by FK
 * `onDelete: Cascade`). Kept in `$transaction` form even though it is a single
 * guarded delete, for a uniform throw-on-0 across every DELETE path.
 */
export async function deleteVmafJobLocally(
	ctx: ServerContext,
	id: string,
	options: { via?: string; req: Request },
): Promise<LocalDeleteOutcome> {
	const row = await ctx.prisma.vmafJob.findUnique({
		where: { id },
		select: { id: true, status: true },
	});
	if (!row) {
		return { ok: false, code: "NOT_FOUND", message: "Not found" };
	}
	// NOT `isActiveVmafStatus(...)`: that permits an UNRECOGNISED status, and the
	// cast silences the type error that would have told me. The old
	// `!isVmafTerminalStatus(...)` refused anything it did not recognise, which is
	// the direction this guard has to fail. Bounded either way — the atomic guard
	// below matches 0 rows and answers RACED — but the operator gets the wrong
	// reason (review catch).
	if (!VMAF_TERMINAL_STATUSES.includes(row.status as VmafStatus)) {
		return {
			ok: false,
			code: "ACTIVE",
			message: `VMAF report is still ${row.status} — wait for it to finish before deleting`,
		};
	}
	try {
		await ctx.prisma.$transaction(async (tx) => {
			const { count } = await tx.vmafJob.deleteMany({
				where: { id, status: { in: [...VMAF_TERMINAL_STATUSES] } },
			});
			if (count === 0) {
				throw new NotDeletable();
			}
		});
	} catch (err) {
		if (err instanceof NotDeletable) {
			return {
				ok: false,
				code: "RACED",
				message:
					"VMAF report changed state and was not deleted — refresh and retry",
			};
		}
		throw err;
	}
	await writeAuditLog(
		ctx,
		{
			method: "DELETE",
			path: `/api/vmaf-jobs/${id}`,
			statusCode: 200,
			...(options.via ? { request: { via: options.via } } : {}),
			response: { id },
		},
		options.req,
	);
	return { ok: true, deletedVmafJobs: 0 };
}
