import { mergeEncodingJobSnapshot } from "@bitovp/db";
import { NextResponse } from "next/server";
import { bitmovinClientForAccount } from "@/lib/server/bitmovin";
import type { ServerContext } from "@/lib/server/context";
import { getServerContext } from "@/lib/server/context";
import { credentialRefsForPlan } from "@/lib/server/credential-refs";
import { deleteEncodingJobLocally } from "@/lib/server/delete-jobs";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";
import { playbackLinksForPlan } from "@/lib/server/playback-links";

type RouteParams = { params: Promise<{ id: string }> };

/** The Bitmovin-side lifecycle stamps, burned into snapshots (see below). */
export type EncodingTimes = {
	queuedAt?: string;
	runningAt?: string;
	finishedAt?: string;
};

/**
 * Encoder startup as a NUMBER (owner follow-up 2026-08-24: the
 * chart hides the queue wait by design, so the wait must be readable as a
 * figure on VOD and Live alike). The VOD step log never recorded the
 * QUEUED→RUNNING transition — but Bitmovin's encoding resource carries
 * queuedAt/runningAt/finishedAt, and Bitmovin purges after ~90 days (C7), so
 * the first read that finds runningAt BURNS the stamps into the job's
 * snapshots and never asks again. Enrichment must never fail the GET: a
 * purged/unreachable encoding simply means no number, stated as absence.
 *
 * The burn goes through mergeEncodingJobSnapshot, NOT a read-modify-write
 * `update` — three recorded traps live in that difference (its docstring):
 * a stale pre-round-trip read drops a concurrent writer's key (the
 * perTitleResults race), an unconditional write lands on an ACTIVE row the
 * orchestrator owns, and a Prisma update bumps @updatedAt, silently
 * rewriting the jobs list's displayed Duration. The helper's terminal-only
 * predicate also means an in-flight job's burn simply does not apply —
 * the number still returns this response, and sticks once terminal.
 */
async function encodingTimesFor(
	ctx: ServerContext,
	row: {
		id: string;
		status: string;
		bitmovinEncodingId: string | null;
		bitmovinAccountId: string | null;
		snapshots: unknown;
	},
): Promise<EncodingTimes | undefined> {
	const snapshots = (row.snapshots ?? {}) as Record<string, unknown>;
	const burned = snapshots.encodingTimes as EncodingTimes | undefined;
	if (burned?.runningAt) {
		return burned;
	}
	// DRAFT/QUEUED-before-submit have no encoding; nothing to ask.
	if (!row.bitmovinEncodingId || !row.bitmovinAccountId) {
		return burned;
	}
	// Terminal-only (review-295 S1): the detail POLLS every 5s while a job
	// is active, and a 10-minute Akamai Osaka queue would mean ~120
	// encodings.get calls + key decrypts from one open tab. The number is
	// about a run that HAPPENED — fetching once the row is terminal
	// collapses that to ~1 and matches the merge helper's own predicate.
	if (row.status === "QUEUED" || row.status === "RUNNING") {
		return burned;
	}
	try {
		const api = await bitmovinClientForAccount(ctx, row.bitmovinAccountId);
		if (!api) {
			return burned;
		}
		const enc = await api.encoding.encodings.get(row.bitmovinEncodingId);
		const iso = (d: Date | undefined) =>
			d instanceof Date && !Number.isNaN(d.getTime())
				? d.toISOString()
				: undefined;
		const fresh: EncodingTimes = {
			...(iso(enc.queuedAt) ? { queuedAt: iso(enc.queuedAt) } : {}),
			...(iso(enc.runningAt) ? { runningAt: iso(enc.runningAt) } : {}),
			...(iso(enc.finishedAt) ? { finishedAt: iso(enc.finishedAt) } : {}),
		};
		if (!fresh.queuedAt && !fresh.runningAt) {
			return burned;
		}
		// Burn on first terminal sight, then never again (review-295 N2: the
		// previous wording described the pre-S1 flow — active rows no longer
		// fetch at all, so "keeps refetching until runningAt" was the
		// opposite of the code above it). A merge that applies 0 rows —
		// deleted in the window, or a Retry flipping the row back to QUEUED
		// (the case the predicate exists for, step-log.ts) — is deliberately
		// ignored: the GET still carries the fresh number; the next terminal
		// read burns.
		if (fresh.runningAt) {
			await mergeEncodingJobSnapshot(ctx.prisma, row.id, {
				encodingTimes: fresh,
			});
		}
		return fresh;
	} catch {
		return burned;
	}
}

/**
 * Full row incl. plan + step log (snapshots are stored redacted), plus the
 * manifest playback links derived HERE rather than in the browser
 *  — so the view never receives credential config
 * it does not need in order to render one URL.
 */
export async function GET(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.encodingJob.findUnique({
			where: { id },
			// Template provenance chip : the template's CURRENT
			// name+revision beside the row's copied presetRevision — null preset
			// with a non-null presetRevision = the template was deleted (SetNull).
			include: { preset: { select: { name: true, revision: true } } },
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		return NextResponse.json({
			...row,
			playbackLinks: await playbackLinksForPlan(ctx, row.plan),
			// Labels for the storage panel — `{id, label, provider}` for the
			// credentials this plan names, and nothing else (see credential-refs.ts).
			// Optional on the wire, so a response cached before this field existed
			// still renders: the panel falls back to the raw id.
			credentialRefs: await credentialRefsForPlan(ctx, row.plan),
			// Optional on the wire (older cached responses lack it).
			encodingTimes: await encodingTimesFor(ctx, row),
		});
	} catch (err) {
		return routeError(err);
	}
}

/**
 * Delete a terminal encoding job and ITS local dependents — LOCAL records
 * only. We never call the Bitmovin API and never touch object storage; the
 * remote encoding (if any) is left exactly as it is. The job's plan/stepLog/
 * snapshots are JSON columns on the row, so they vanish with it.
 *
 * Terminal-only: QUEUED/RUNNING jobs return 409 (cancel them first) so an
 * in-flight orchestrator never has its row pulled from under it. Terminal =
 * DRAFT/FINISHED/ERROR/CANCELED.
 *
 * The delete itself (atomic terminal guard, cascade order, audit) lives in the
 * shared `deleteEncodingJobLocally` helper, which the bulk-delete route runs per
 * id — one pipeline, two callers, so the semantics cannot drift.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const outcome = await deleteEncodingJobLocally(
			await getServerContext(),
			id,
			{
				req,
			},
		);
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
