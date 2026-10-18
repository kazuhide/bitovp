import { type StartupProfile, startupProfile } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { routeError } from "@/lib/server/http";

/**
 * Startup-time profiles per region bucket ( PR1,
 * ). Aggregated on read from the persisted
 * samples — no stats table to drift. The honesty rules (refuse percentile
 * labels below PERCENTILE_MIN_N, count FAILED/CENSORED beside the numbers)
 * live in core's startupProfile so this route cannot fork them.
 */

const querySchema = z.object({
	windowDays: z.coerce.number().int().min(1).max(365).default(30),
});

/** Newest samples the aggregation reads per request — a read cap, not a
 * window: the window filter runs in core over these. */
const SAMPLE_READ_CAP = 5000;

export type StartupProfileRow = {
	region: string;
	source: string;
	profile: StartupProfile;
};

export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		windowDays: url.searchParams.get("windowDays") ?? undefined,
	});
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid windowDays" }, { status: 400 });
	}
	const { windowDays } = parsed.data;
	try {
		const ctx = await getServerContext();
		const now = new Date();
		const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
		const samples = await ctx.prisma.startupSample.findMany({
			where: { observedAt: { gte: cutoff } },
			orderBy: { observedAt: "desc" },
			select: {
				cloudRegion: true,
				source: true,
				outcome: true,
				queueSeconds: true,
				observedAt: true,
			},
			take: SAMPLE_READ_CAP,
		});
		// CHANNEL and PROBE stay separate buckets by design : a probe's
		// synthetic minimal ladder must never launder a real channel's tail.
		// The tuple rides IN the value — encoding it into
		// a delimited key invited a region containing the delimiter to
		// mis-split and invert exactly that invariant; the string key is Map
		// identity only and is never parsed back.
		const byBucket = new Map<
			string,
			{ region: string; source: string; list: typeof samples }
		>();
		for (const sample of samples) {
			const key = JSON.stringify([sample.cloudRegion, sample.source]);
			const bucket = byBucket.get(key);
			if (bucket) {
				bucket.list.push(sample);
			} else {
				byBucket.set(key, {
					region: sample.cloudRegion,
					source: sample.source,
					list: [sample],
				});
			}
		}
		const rows: StartupProfileRow[] = [...byBucket.values()]
			.map(({ region, source, list }) => {
				return {
					region,
					source,
					profile: startupProfile(
						list.map((s) => ({
							outcome: s.outcome as "RUNNING" | "FAILED" | "CENSORED",
							queueSeconds: s.queueSeconds,
							observedAt: s.observedAt,
						})),
						windowDays,
						now,
					),
				};
			})
			.sort(
				(a, b) =>
					b.profile.n + b.profile.failures - (a.profile.n + a.profile.failures),
			);
		return NextResponse.json({ windowDays, rows });
	} catch (err) {
		return routeError(err);
	}
}
