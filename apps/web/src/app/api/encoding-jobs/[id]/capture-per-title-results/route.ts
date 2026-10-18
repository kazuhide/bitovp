import {
	bitmovinCapturePort,
	capturePerTitleResults,
	encodingPlanSchema,
	perTitleTemplates,
	planHasPerTitle,
} from "@bitovp/core";
import { mergeEncodingJobSnapshot } from "@bitovp/db";
import { NextResponse } from "next/server";
import { bitmovinProxyError } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { resolveEncodingForRuntimeAction } from "@/lib/server/encoding-runtime";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST — capture this job's `PER_TITLE_RESULT` streams NOW, for a job whose run
 * predates the `CAPTURE_PER_TITLE_RESULTS` step (design §4a, path 2).
 *
 * Reads only, and runs the SAME core capture the orchestrator step runs — one
 * implementation, two callers, so the two can never disagree about what a
 * per-title result is. What differs is only the I/O adapter: the worker has its
 * SDK-ops facade, this route drives `BitmovinApi` directly, and both are built
 * from the shared `CODEC_CONFIG_API_PATH` / `SCAN_PAGE_CAP` in core.
 *
 * TERMINAL-ONLY. The results exist only once the encoding has FINISHED, and
 * `snapshots` on an ACTIVE row belongs to the orchestrator — writing it here
 * would put a second writer beside it. `requireTerminal` returns 409 instead.
 *
 * IDEMPOTENT OVERWRITE: two concurrent clicks converge on the same data, because
 * the capture is a read of state that no longer changes. A capture that fails
 * upstream (Bitmovin purges encodings after ~90 days — C7) writes NOTHING and
 * surfaces the upstream error, so a stale-but-real snapshot is never replaced by
 * an empty one.
 */
export async function POST(_req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const resolved = await resolveEncodingForRuntimeAction({
			ctx,
			jobId: id,
			subject: "Capturing per-title results",
			requireTerminal: true,
		});
		if (!resolved.ok) {
			return resolved.response;
		}
		const { api, encodingId } = resolved;

		// The plan is needed for the template list (attribution is plan knowledge),
		// and it also tells us whether the question even applies to this job.
		const row = await ctx.prisma.encodingJob.findUnique({
			where: { id },
			select: { plan: true },
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		const plan = encodingPlanSchema.safeParse(row.plan);
		if (!plan.success) {
			return jsonError(409, "Job plan is not readable");
		}
		if (!planHasPerTitle(plan.data)) {
			// Not a failure of ours, and not something a retry fixes.
			return jsonError(
				409,
				"This job does not use per-title encoding, so it has no per-title results",
			);
		}

		// NOT `auditedBitmovinCall`: that helper is for MUTATIONS (its `method` is
		// POST|PATCH|DELETE and it writes a 201/200 audit row). This is a read, and
		// mislabelling a read as a POST in the audit log would be worse than not
		// auditing it. Errors go through the same curated mapper the other read
		// routes use.
		let snapshot: Awaited<ReturnType<typeof capturePerTitleResults>>;
		try {
			snapshot = await capturePerTitleResults(bitmovinCapturePort(api), {
				encodingId,
				capturedAt: new Date().toISOString(),
				templates: perTitleTemplates(plan.data),
			});
		} catch (err) {
			// Bitmovin purges encodings after ~90 days (C7), so "gone" is a normal
			// outcome here and it must reach the operator as the upstream error —
			// never as an empty results table, and never overwriting a snapshot we
			// already hold.
			return bitmovinProxyError(err);
		}

		// Merged with `jsonb ||`, not read-modify-write: `snapshots` is a SHARED
		// column, and a read here would be taken before a network round-trip to
		// Bitmovin, so a stale copy could drop another writer's key. Same rationale
		// as the live step-log append — a Prisma `$transaction` would not fix it
		// under Read Committed. The helper also serialises, which drops the
		// `undefined` fields that SDK codec-config CLASS INSTANCES carry and that
		// Prisma rejects at runtime; no cast or typecheck would have shown that
		// before the first sparse config.
		const updated = await mergeEncodingJobSnapshot(ctx.prisma, id, {
			perTitleResults: snapshot,
		});
		if (updated === 0) {
			// Deleted while we were reading Bitmovin. Reporting success would claim a
			// snapshot that is not stored anywhere.
			return jsonError(404, "Not found");
		}
		return NextResponse.json({ id, encodingId, snapshot });
	} catch (err) {
		return routeError(err);
	}
}
