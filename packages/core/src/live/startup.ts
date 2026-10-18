import type { LiveChannelPlan } from "./schema";

/**
 * Startup-time profiles .
 *
 * Pure aggregation over persisted samples — computed on read, no stats table
 * to drift. The honesty rules live HERE so every consumer shares them:
 * below `PERCENTILE_MIN_N` samples the profile refuses to name a "P90"
 * (at n=5 a "P90" is the largest observation wearing a lab coat) and the
 * UI shows max + n + the raw list instead; CENSORED samples are counted
 * beside the percentile, never silently dropped — a percentile over
 * completed samples alone is biased low in exactly the tail that matters.
 */

/**
 * Aggregate (non-datacenter) regions — AUTO plus the continent/provider
 * groups. Hoisted here (the ledgered nit the startup design's review
 * re-surfaced): core's static-IP validator and the web's pool/static-IP
 * lists each carried their own copy, deliberately disagreeing on EXTERNAL.
 * The DERIVATIONS keep that disagreement explicit: static-IP contexts use
 * this list as-is; pool contexts append "EXTERNAL" (a pool cannot live in
 * a customer's own datacenter); the startup profile treats AUTO as its own
 * honest bucket and resolves EXTERNAL through the infrastructure row.
 */
export const AGGREGATE_CLOUD_REGIONS = [
	"AUTO",
	"NORTH_AMERICA",
	"SOUTH_AMERICA",
	"EUROPE",
	"AFRICA",
	"ASIA",
	"AUSTRALIA",
	"AWS",
	"GOOGLE",
] as const;

/** Below this n, percentile labels are refused (max + raw list instead). */
export const PERCENTILE_MIN_N = 20;

export type StartupSampleInput = {
	outcome: "RUNNING" | "FAILED" | "CENSORED";
	queueSeconds: number | null;
	observedAt: Date;
};

export type StartupProfile = {
	/** Completed (RUNNING) samples inside the window. */
	n: number;
	failures: number;
	censored: number;
	maxSeconds: number | null;
	/** Null below PERCENTILE_MIN_N — the UI must not print "P50/P90". */
	p50Seconds: number | null;
	p90Seconds: number | null;
	/** Ascending completed queueSeconds — the raw list small-n honesty shows. */
	rawSeconds: number[];
};

/** Nearest-rank percentile over an ASCENDING list (n ≥ 1). */
function percentile(sorted: readonly number[], p: number): number {
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function startupProfile(
	samples: readonly StartupSampleInput[],
	windowDays: number,
	now: Date,
): StartupProfile {
	const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
	const inWindow = samples.filter((s) => s.observedAt.getTime() >= cutoff);
	const completed = inWindow
		.filter((s) => s.outcome === "RUNNING" && s.queueSeconds !== null)
		.map((s) => s.queueSeconds as number)
		.sort((a, b) => a - b);
	const failures = inWindow.filter((s) => s.outcome === "FAILED").length;
	const censored = inWindow.filter((s) => s.outcome === "CENSORED").length;
	const enough = completed.length >= PERCENTILE_MIN_N;
	return {
		n: completed.length,
		failures,
		censored,
		maxSeconds: completed.length > 0 ? (completed.at(-1) as number) : null,
		p50Seconds: enough ? percentile(completed, 50) : null,
		p90Seconds: enough ? percentile(completed, 90) : null,
		rawSeconds: completed,
	};
}

export type ResolvedStartupRegion = {
	/**
	 * The bucket samples aggregate under. Cloud Connect plans carry the
	 * plan region "EXTERNAL" (C18) with the real region on the
	 * infrastructure block; defaults carry "AUTO" — which stays its own
	 * bucket, because it is a placement REQUEST, not a region, and folding
	 * it into whatever Bitmovin chose would launder the uncertainty the
	 * bucket exists to show.
	 */
	region: string;
	infrastructureId: string | null;
};

export function resolveStartupRegion(
	plan: Pick<LiveChannelPlan, "bitmovin">,
): ResolvedStartupRegion {
	const infra = plan.bitmovin.infrastructure;
	if (infra?.cloudRegion) {
		return {
			region: infra.cloudRegion,
			infrastructureId: infra.infrastructureId ?? null,
		};
	}
	return {
		region: plan.bitmovin.cloudRegion ?? "AUTO",
		infrastructureId: null,
	};
}

/** PR3 (design §5): the arm-time lead resolution's two envs' defaults.
 * The worker/web read the real env; core owns the numbers so both sides
 * agree (the #104 duplicated-constant lesson). */
export const SCHEDULE_DEFAULT_LEAD_SECONDS = 900;
export const SCHEDULE_LEAD_MARGIN_SECONDS = 180;

export type AutoLeadResolution = {
	/** Seconds subtracted from airAt to get fireAt. */
	leadSeconds: number;
	fireAtMs: number;
	/** P90: profile-fed. DEFAULT: below the honesty bar (or no samples). */
	source: "P90" | "DEFAULT";
	p90Seconds: number | null;
	n: number;
};

/**
 * Arm-time auto-lead : resolve fireAt from the
 * operator's airAt ONCE, at arm time — never in the sweep (a per-tick
 * profile query inside the 30s loop is unindexable, the design's stated
 * reason). Profile-fed when the region's p90 is honest (n ≥
 * PERCENTILE_MIN_N via startupProfile's null contract); otherwise the
 * DEFAULT lead, and the caller says "insufficient data" out loud.
 *
 * The never-shorten rule lives in the CALLER (route): a manually chosen
 * EARLIER fireAt wins over the resolution — more lead is safe, less is
 * not. This function only computes.
 */
export function resolveAutoLead(
	profile: StartupProfile,
	opts: {
		airAtMs: number;
		defaultLeadSeconds?: number;
		leadMarginSeconds?: number;
	},
): AutoLeadResolution {
	const defaultLead = opts.defaultLeadSeconds ?? SCHEDULE_DEFAULT_LEAD_SECONDS;
	const margin = opts.leadMarginSeconds ?? SCHEDULE_LEAD_MARGIN_SECONDS;
	if (profile.p90Seconds !== null) {
		const leadSeconds = profile.p90Seconds + margin;
		return {
			leadSeconds,
			fireAtMs: opts.airAtMs - leadSeconds * 1000,
			source: "P90",
			p90Seconds: profile.p90Seconds,
			n: profile.n,
		};
	}
	return {
		leadSeconds: defaultLead,
		fireAtMs: opts.airAtMs - defaultLead * 1000,
		source: "DEFAULT",
		p90Seconds: null,
		n: profile.n,
	};
}
