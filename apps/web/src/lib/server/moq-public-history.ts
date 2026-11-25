import "server-only";
import {
	MOQ_TASK_HISTORY_ERROR,
	projectMoqTaskHistory,
	publicHdrSourceProjection,
	publicStorageDiagnostic,
} from "@bitovp/core";
import type { ServerContext } from "./context";

/** Project retained Task snapshots before any channel or run detail is returned. */
export function publicLiveHistory<
	T extends { stepLog: unknown; error: string | null },
>(row: T): T {
	const history = projectMoqTaskHistory(row.stepLog, row.error);
	return {
		...row,
		stepLog: publicHdrSourceProjection(history.stepLog),
		error: publicStorageDiagnostic(history.moq ? history.error : row.error),
	};
}

/** Project the text and its MoQ classification in the same database read. */
export async function publicMoqListErrors<
	T extends { id: string; error?: string | null },
>(
	prisma: ServerContext["prisma"],
	model: "channel" | "run",
	rows: T[],
): Promise<T[]> {
	const ids = [
		...new Set(
			rows
				.filter((row) => typeof row.error === "string" && row.error.length > 0)
				.map((row) => row.id),
		),
	];
	if (ids.length === 0) return rows;
	if (rows.length > 100)
		throw new Error("MoQ history page exceeds its read budget");
	type ErrorSnapshot = { id: string; error: string | null };
	const matches =
		model === "channel"
			? await prisma.$queryRaw<ErrorSnapshot[]>`
				SELECT id, CASE
					WHEN NULLIF(error, '') IS NULL THEN NULL
					WHEN jsonb_typeof("stepLog") IS DISTINCT FROM 'array' THEN NULL
					WHEN "stepLog" @> '[{"kind":"CREATE_OUTPUT_MOQ"}]'::jsonb
						THEN ${MOQ_TASK_HISTORY_ERROR}
					ELSE error
				END AS error
				FROM "LiveChannel" WHERE id = ANY(${ids}::uuid[])
			`
			: await prisma.$queryRaw<ErrorSnapshot[]>`
				SELECT id, CASE
					WHEN NULLIF(error, '') IS NULL THEN NULL
					WHEN jsonb_typeof("stepLog") IS DISTINCT FROM 'array' THEN NULL
					WHEN "stepLog" @> '[{"kind":"CREATE_OUTPUT_MOQ"}]'::jsonb
						THEN ${MOQ_TASK_HISTORY_ERROR}
					ELSE error
				END AS error
				FROM "LiveChannelRun" WHERE id = ANY(${ids}::uuid[])
			`;
	const publicErrors = new Map(matches.map((row) => [row.id, row.error]));
	return rows.map((row) => {
		if (!row.error) return row;
		// A delete, concurrent clear or malformed step log cannot re-expose
		// text from the earlier page or replay read.
		return {
			...row,
			error:
				publicStorageDiagnostic(publicErrors.get(row.id)) ??
				"Live encoding error details unavailable",
		};
	});
}
