import "server-only";
import type { AppPrismaClient } from "@bitovp/db";
import type { OperationAnalyticsWeek } from "@/lib/operation-analytics";
import { RESULT_RECEIVE_WINDOW_MS } from "@/lib/operation-attempts";

const WEEK_COUNT = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type AggregateRow = {
	weekStart: string;
	started: bigint;
	firstFrame: bigint;
	failed: bigint;
	canceled: bigint;
	pending: bigint;
	p50Ms: number | null;
	p95Ms: number | null;
};

export async function readWeeklyOperationAnalytics(
	prisma: Pick<AppPrismaClient, "$queryRaw">,
	organizationId: string,
	now = new Date(),
): Promise<OperationAnalyticsWeek[]> {
	const currentWeek = new Date(now);
	currentWeek.setUTCHours(0, 0, 0, 0);
	currentWeek.setUTCDate(
		currentWeek.getUTCDate() - ((currentWeek.getUTCDay() + 6) % 7),
	);
	const firstWeekMs = currentWeek.getTime() - (WEEK_COUNT - 1) * WEEK_MS;
	const firstWeek = new Date(firstWeekMs).toISOString();
	const pendingSince = new Date(
		now.getTime() - RESULT_RECEIVE_WINDOW_MS,
	).toISOString();

	// Prisma stores DateTime as a timestamp without time zone. Bind UTC wall-clock
	// timestamps so the report and the index range are independent of the DB session zone.
	const rows = await prisma.$queryRaw<AggregateRow[]>`
		SELECT
			to_char(date_trunc('week', "startedAt"), 'YYYY-MM-DD') AS "weekStart",
			count(*) AS "started",
			count(*) FILTER (WHERE "outcome" = 'FIRST_FRAME') AS "firstFrame",
			count(*) FILTER (WHERE "outcome" = 'FAILED') AS "failed",
			count(*) FILTER (WHERE "outcome" = 'CANCELED') AS "canceled",
			count(*) FILTER (
				WHERE "outcome" IS NULL
				AND "startedAt" >= (${pendingSince}::timestamptz AT TIME ZONE 'UTC')
			) AS "pending",
			percentile_cont(0.5) WITHIN GROUP (ORDER BY "elapsedMs")
				FILTER (WHERE "outcome" = 'FIRST_FRAME') AS "p50Ms",
			percentile_cont(0.95) WITHIN GROUP (ORDER BY "elapsedMs")
				FILTER (WHERE "outcome" = 'FIRST_FRAME') AS "p95Ms"
		FROM "OperationAttempt"
		WHERE "organizationId" = ${organizationId}::uuid
			AND "operation" = 'LIVE_MOQ_PLAYBACK'
			AND "startedAt" >= (${firstWeek}::timestamptz AT TIME ZONE 'UTC')
			AND "startedAt" <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
		GROUP BY 1
	`;
	const byWeek = new Map(rows.map((row) => [row.weekStart, row]));

	return Array.from({ length: WEEK_COUNT }, (_, index) => {
		const weekStart = new Date(firstWeekMs + index * WEEK_MS)
			.toISOString()
			.slice(0, 10);
		const row = byWeek.get(weekStart);
		const started = Number(row?.started ?? 0n);
		const firstFrame = Number(row?.firstFrame ?? 0n);
		const failed = Number(row?.failed ?? 0n);
		const canceled = Number(row?.canceled ?? 0n);
		const pending = Number(row?.pending ?? 0n);
		const eligible = started - pending;
		return {
			weekStart,
			isPartial: index === WEEK_COUNT - 1,
			started,
			firstFrame,
			failed,
			canceled,
			unconfirmed: eligible - firstFrame - failed - canceled,
			pending,
			firstFrameShare: eligible === 0 ? null : firstFrame / eligible,
			p50Ms: row?.p50Ms ?? null,
			p95Ms: row?.p95Ms ?? null,
		};
	});
}
