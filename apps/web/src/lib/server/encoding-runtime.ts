import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import type { NextResponse } from "next/server";
import { isActiveJobStatus } from "@/lib/job-status";
import { bitmovinClientForAccount } from "./bitmovin";
import type { ServerContext } from "./context";
import { jsonError } from "./http";

/**
 * Resolves a VOD job into the Bitmovin encoding its RUNTIME actions
 * (transfer-retry, reprioritize, reschedule) address — the encoding-jobs
 * counterpart of `resolveLiveEncoding`.
 *
 * The encodingId comes from the job ROW (`bitmovinEncodingId`, written by the
 * orchestrator when the CREATE_ENCODING step lands), exactly like the existing
 * job-detail actions read it. The account is NOT a caller parameter here (a job
 * owns exactly one Bitmovin account) — it is read from the row, so a runtime
 * action can never be pointed at another org's key.
 *
 * FAIL CLOSED on a null account, same as the live resolver: the column is
 * `String?` with `onDelete: SetNull`, so deleting a Bitmovin account nulls it on
 * every job that referenced it. With no account there is no key to drive and no
 * id to audit under — refuse rather than guess.
 *
 * `requireActive` gates the actions that only mean something while the run is in
 * flight (reprioritize/reschedule): a terminal job's encoding is done, so those
 * would produce an upstream 4xx — and a Bitmovin 400 maps to 502 under the
 * curated error policy, which would tell the operator nothing. `isActiveJobStatus`
 * (QUEUED|RUNNING) is the shared source of truth the UI disables against.
 *
 * `stepLog` is NOT selected. It was, for the transfer-retry gate — and that
 * feature is gone (the API was removed in 1.271.1, COVERAGE C25), so every
 * remaining caller was pulling the full ordered log with its persisted
 * request/response snapshots for nothing. `schema.prisma` makes "never select
 * plan/stepLog" an explicit perf contract, and reprioritize/reschedule were
 * breaking it on every call (review catch).
 * last known BITMOVIN status without a second read.
 */
export async function resolveEncodingForRuntimeAction(options: {
	ctx: ServerContext;
	jobId: string;
	/** Noun used in the 409 messages, e.g. "Transfer retries". */
	subject: string;
	/** Refuse unless our job is still QUEUED|RUNNING (in flight). */
	requireActive?: boolean;
	/**
	 * The mirror image: refuse while the job is still in flight. The per-title
	 * RESULT backfill needs this — the results it reads only exist once the
	 * encoding has FINISHED, and writing `snapshots` on an active row would put a
	 * second writer next to the orchestrator (which owns active jobs).
	 */
	requireTerminal?: boolean;
}): Promise<
	| {
			ok: true;
			api: BitmovinApi;
			encodingId: string;
			bitmovinAccountId: string;
	  }
	| { ok: false; response: NextResponse }
> {
	const { ctx, jobId, subject } = options;
	const job = await ctx.prisma.encodingJob.findUnique({
		where: { id: jobId },
		select: {
			status: true,
			bitmovinEncodingId: true,
			bitmovinAccountId: true,
		},
	});
	if (!job) {
		return { ok: false, response: jsonError(404, "Not found") };
	}
	if (options.requireTerminal && isActiveJobStatus(job.status)) {
		return {
			ok: false,
			response: jsonError(
				409,
				`${subject} need a finished job — this one is still ${job.status}`,
			),
		};
	}
	if (options.requireActive && !isActiveJobStatus(job.status)) {
		return {
			ok: false,
			response: jsonError(
				409,
				`${subject} need a job that is still running (status: ${job.status})`,
			),
		};
	}
	if (!job.bitmovinEncodingId) {
		return {
			ok: false,
			response: jsonError(
				409,
				`${subject} need a started Bitmovin encoding — this job has no encoding id yet`,
			),
		};
	}
	if (job.bitmovinAccountId === null) {
		return {
			ok: false,
			response: jsonError(
				409,
				"Job has no Bitmovin account attached (was the account deleted?) — re-attach one before using encoding actions",
			),
		};
	}
	const api = await bitmovinClientForAccount(ctx, job.bitmovinAccountId);
	if (!api) {
		return {
			ok: false,
			response: jsonError(404, "Bitmovin account not found"),
		};
	}
	return {
		ok: true,
		api,
		encodingId: job.bitmovinEncodingId,
		bitmovinAccountId: job.bitmovinAccountId,
	};
}
