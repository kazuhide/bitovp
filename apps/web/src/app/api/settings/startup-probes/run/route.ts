import { randomUUID } from "node:crypto";
import {
	BITMOVIN_CLOUD_REGIONS,
	PROBE_FUSE_MINUTES,
	PROBE_STOP_WAIT_MINUTES,
	probeBatchJobSchema,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getStartupProbeQueue } from "@/lib/server/queue";
import { PROBE_SETTING_KEY } from "../route";

/**
 * Launch a probe batch . Probes BILL — the client sends an
 * explicit worst-case acknowledgement (N × abandon deadline × rate, quoted
 * in the confirm), and the route refuses without it. The batch job is
 * serial-per-region in the worker; the request only enqueues.
 */
const bodySchema = z.strictObject({
	// review-pr34 m4: membership in the SDK-derived catalogue, not just
	// non-empty — a typo'd region would otherwise travel to the worker and
	// die at Bitmovin CREATE, half-way through a billed batch.
	regions: z
		.array(
			z
				.string()
				.refine(
					(r) => (BITMOVIN_CLOUD_REGIONS as readonly string[]).includes(r),
					{
						message: "unknown cloud region",
					},
				),
		)
		.min(1)
		.max(10),
	perRegion: z.number().int().min(1).max(10),
	/** literal(true): absence or false is a 400, not a default. */
	acknowledgeWorstCase: z.literal(true),
});

export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const designation = await ctx.prisma.appSetting.findUnique({
			where: { key: PROBE_SETTING_KEY },
		});
		if (!designation) {
			return jsonError(
				422,
				"designate a probe destination (credential + Bitmovin account + bucket + prefix) before running probes",
			);
		}
		// review-287 B1: a designation SAVED BEFORE the account requirement
		// (a legacy row) exists but carries no bitmovinAccountId — the row
		// exists, so the truthiness check above passes, and the batch would
		// enqueue a 202 with a billing-consent audit row for a probe that then
		// dies at provision ("Plan carries no Bitmovin account id") with no
		// retry. Refuse HERE, before the audit row, naming the missing field.
		const value = designation.value as { bitmovinAccountId?: unknown } | null;
		if (
			typeof value?.bitmovinAccountId !== "string" ||
			value.bitmovinAccountId.length === 0
		) {
			return jsonError(
				422,
				"the saved probe destination predates the Bitmovin-account requirement — re-save it in Settings → Live → Startup profiles, picking the account probes run under",
			);
		}
		const job = probeBatchJobSchema.parse({
			requestId: randomUUID(),
			regions: parsed.data.regions,
			perRegion: parsed.data.perRegion,
		});
		await getStartupProbeQueue().add("probe-batch", job, {
			jobId: `probe-batch-${job.requestId}`,
			removeOnComplete: 100,
			removeOnFail: 100,
		});
		// review-pr34 n2: the acknowledgement is a BILLING consent — it gets
		// an audit row like every other side-effectful settings action, so
		// "who launched 20 probes on the 14th" has an answer.
		const designationValue = designation.value as {
			abandonDeadlineMinutes?: number;
		} | null;
		const deadlineMinutes = designationValue?.abandonDeadlineMinutes ?? 8;
		await writeAuditLog(
			ctx,
			{
				method: "POST",
				path: "/api/settings/startup-probes/run",
				statusCode: 202,
				request: {
					requestId: job.requestId,
					regions: job.regions,
					perRegion: job.perRegion,
					acknowledgeWorstCase: true,
					// review-161-162 n1: the NUMBER the operator acknowledged,
					// as the designation stood at launch — regions × perRegion
					// × per-probe worst case.
					// review-288 N1: per-probe worst case is max(deadline + stop
					// wait, encoder-side fuse) — a stranded probe bills to the
					// fuse (30), which now exceeds the 13-min default deadline+tail.
					worstCaseMinutes:
						job.regions.length *
						job.perRegion *
						Math.max(
							deadlineMinutes + PROBE_STOP_WAIT_MINUTES,
							PROBE_FUSE_MINUTES,
						),
				},
			},
			req,
		);
		return NextResponse.json(
			{ requestId: job.requestId, enqueued: true },
			{ status: 202 },
		);
	} catch (err) {
		return routeError(err);
	}
}
