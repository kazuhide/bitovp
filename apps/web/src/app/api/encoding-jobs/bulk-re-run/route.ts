import { masterKeyFromEnv } from "@bitovp/core";
import { NextResponse } from "next/server";
import { bulkIdsSchema, dedupeIds } from "@/lib/bulk-ops";
import { actorFrom } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getOrchestratorQueue } from "@/lib/server/queue";
import { clientKey, createFixedWindowLimiter } from "@/lib/server/rate-limit";
import { ReRunPlanError, reRunJob } from "@/lib/server/rerun-job";

/**
 * The most expensive primitive in the app: every accepted id becomes a REAL,
 * BILLABLE Bitmovin encoding, and nothing else caps the total number of QUEUED
 * jobs. `MAX_BULK_IDS` bounds one request (50); this bounds the loop.
 *
 * 5/min is ~5× what the UI can produce — re-running a list selection is one
 * click per batch, and an operator reviews results between batches — while
 * capping an unattended `curl` loop at 250 encodings/min instead of unbounded.
 * Per-process, and per-client-IP ONLY when `TRUSTED_PROXY_HOPS` is set — see
 * rate-limit.ts. Unset, which is what `.env.example` ships, every caller shares one
 * bucket, so read this as **5 bulk re-runs per minute for the whole install**.
 *
 * 5 was sized as a per-client budget and was not revisited when the key collapsed
 * to a shared one, which a reviewer flagged with a scenario needing no attacker:
 * operator A does five bulk re-runs, an ordinary afternoon, and operator B gets 429
 * for the rest of the window. It is the tightest of the five (bulk-cancel 30,
 * bulk-delete 30, vmaf bulk-delete 30, storage-inspections 20) and the only one
 * where that bites in normal use.
 *
 * Deliberately NOT raised here. This limit is the only thing bounding BILLABLE
 * re-runs — each call can enqueue up to 50 encodings — so the number is the owner's
 * call, not a side effect of a security fix, and a 429 is recoverable within the
 * minute. Recorded in STATUS #33 as a decision to make, with the two options
 * (raise it, or set TRUSTED_PROXY_HOPS and keep per-client accounting).
 */
const limiter = createFixedWindowLimiter({ limit: 5, windowMs: 60_000 });

/**
 * Re-runs N jobs as new QUEUED jobs (shared reRunJob helper). Partial-failure
 * isolated: one bad/missing/invalid-plan id is reported in `failed` and does
 * NOT abort the rest. Source jobs are never mutated. Deduplicates input ids so
 * a doubled selection re-runs each source once.
 */
export async function POST(req: Request) {
	if (!limiter.check(clientKey(req))) {
		return jsonError(429, "Too many requests");
	}
	const body = bulkIdsSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const ids = dedupeIds(body.data.ids);
	try {
		// Fail fast before creating any QUEUED rows: a broken MASTER_KEY means
		// the worker cannot process the new jobs.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		const deps = {
			prisma: ctx.prisma,
			bitmovinAccounts: ctx.bitmovinAccounts,
			credentials: ctx.credentials,
			queue: getOrchestratorQueue(),
			actor: actorFrom(req),
		};

		const created: { sourceId: string; newId: string }[] = [];
		const failed: { sourceId: string; error: string }[] = [];
		for (const id of ids) {
			try {
				const source = await ctx.prisma.encodingJob.findUnique({
					where: { id },
					select: { id: true, plan: true },
				});
				if (!source) {
					failed.push({ sourceId: id, error: "Not found" });
					continue;
				}
				created.push(await reRunJob(deps, source));
			} catch (reRunErr) {
				// A single failure (bad plan, missing account, even an enqueue
				// error) is isolated so the remaining ids still run.
				if (!(reRunErr instanceof ReRunPlanError)) {
					console.error(
						`[api] bulk-re-run failed for job ${id}:`,
						reRunErr instanceof Error
							? `${reRunErr.name}: ${reRunErr.message}`
							: reRunErr,
					);
				}
				const message =
					reRunErr instanceof ReRunPlanError
						? reRunErr.message
						: "Re-run failed";
				failed.push({ sourceId: id, error: message });
			}
		}
		return NextResponse.json({ created, failed }, { status: 201 });
	} catch (err) {
		return routeError(err);
	}
}
