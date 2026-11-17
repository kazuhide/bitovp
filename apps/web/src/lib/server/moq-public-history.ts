import "server-only";
import { MOQ_TASK_HISTORY_ERROR, projectMoqTaskHistory } from "@bitovp/core";
import type { ServerContext } from "./context";

/** Old MoQ Task prose must not become public again before a Worker retry. */
export function publicMoqHistory<
	T extends { stepLog: unknown; error: string | null },
>(row: T): T {
	const history = projectMoqTaskHistory(row.stepLog, row.error);
	return history.moq
		? { ...row, stepLog: history.stepLog, error: history.error }
		: row;
}

/** Keep lean lists lean: ask PostgreSQL only for the matching page-row IDs. */
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
	const query = {
		where: {
			id: { in: ids },
			stepLog: { array_contains: [{ kind: "CREATE_OUTPUT_MOQ" }] },
		},
		select: { id: true } as const,
		take: ids.length,
	};
	const matches =
		model === "channel"
			? await prisma.liveChannel.findMany(query)
			: await prisma.liveChannelRun.findMany(query);
	const moqIds = new Set(matches.map((row) => row.id));
	return rows.map((row) =>
		moqIds.has(row.id) ? { ...row, error: MOQ_TASK_HISTORY_ERROR } : row,
	);
}
