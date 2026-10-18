/**
 * `EncodingJob.status` — our orchestration state machine (NOT Bitmovin's
 * `Status`; see `lib/bitmovin-encoding-status.ts` for the remote one).
 *
 * UI-FREE on purpose: both the client list/detail views and the SERVER runtime
 * routes gate on `isActiveJobStatus`, and a server module must not import a
 * `"use client"` component file to get it. `jobs-client.tsx` re-exports these so
 * existing call sites are unchanged.
 */

import type { EncodingJobStatus } from "@bitovp/db";

export type JobStatus =
	| "DRAFT"
	| "QUEUED"
	| "RUNNING"
	| "AWAITING_QC"
	| "FINISHED"
	| "ERROR"
	| "CANCELED"
	| "QC_FAILED";

/**
 * This exhaustive union is the compile-time fence added with  PR2:
 * it claimed to "mirror the Prisma enum" while nothing checked
 * it, so adding an enum value left the dropdown and tone map silently stale —
 * exactly what happened in review of PR #171. The two conditional types below
 * close it in BOTH directions at compile time (the steplog.ts pattern), and
 * the import is type-only, so the module stays UI-safe (no Prisma runtime in
 * client bundles).
 */
const _unionIsSubsetOfEnum: JobStatus extends EncodingJobStatus ? true : never =
	true;
const _enumIsSubsetOfUnion: EncodingJobStatus extends JobStatus ? true : never =
	true;
void _unionIsSubsetOfEnum;
void _enumIsSubsetOfUnion;

/** Runtime status list for the filter dropdown (fenced against the enum). */
export const JOB_STATUSES = [
	"DRAFT",
	"QUEUED",
	"RUNNING",
	"AWAITING_QC",
	"FINISHED",
	"ERROR",
	"CANCELED",
	"QC_FAILED",
] as const satisfies readonly JobStatus[];

/** The reverse direction: the tuple must stay EXHAUSTIVE over the union. */
const _statusesExhaustive: Exclude<
	JobStatus,
	(typeof JOB_STATUSES)[number]
> extends never
	? true
	: ["JOB_STATUSES is missing a status", JobStatus] = true;
void _statusesExhaustive;

export const STATUS_TONE: Record<JobStatus, "neutral" | "ok" | "error"> = {
	DRAFT: "neutral",
	QUEUED: "neutral",
	RUNNING: "ok",
	// Waiting on the QC verdict — a parked state, not a healthy end nor a
	// failure .
	AWAITING_QC: "neutral",
	FINISHED: "ok",
	ERROR: "error",
	CANCELED: "neutral",
	// A failed GATE, not a malfunction — but it blocked delivery, and the tone
	// exists to pull the operator's eye to exactly that.
	QC_FAILED: "error",
};

/**
 * In-flight statuses: the orchestrator owns the row (QUEUED waiting to start,
 * RUNNING mid-execution). Shared single source of truth so the DELETE/bulk
 * routes' 409 guards, the runtime actions' `requireActive` gate and the UI's
 * disabled sets can't drift (mirrors isActiveChannelStatus /
 * isActiveFeederStatus).
 *
 * AWAITING_QC is deliberately NOT active: the orchestrator's queue job has
 * completed and nothing owns the row while it waits, so delete/cancel guards
 * must not treat it as in-flight ( PR2 — cancel-while-awaiting is
 * PR4 scope alongside the override).
 */
export function isActiveJobStatus(status: JobStatus): boolean {
	return status === "QUEUED" || status === "RUNNING";
}
