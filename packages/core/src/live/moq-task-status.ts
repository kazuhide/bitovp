import { z } from "zod";
import { type StepLogEntry, stepLogSchema } from "../plan/steplog";

const taskMetadataSchema = z.object({
	status: z.enum([
		"CREATED",
		"QUEUED",
		"RUNNING",
		"FINISHED",
		"ERROR",
		"CANCELED",
		"TRANSFER_ERROR",
	]),
	progress: z.number().finite().optional().catch(undefined),
});
export type MoqTaskStatus = z.infer<typeof taskMetadataSchema>;
export const MOQ_TASK_HISTORY_ERROR = "MoQ encoding operation failed";

/** Provider Task prose can contain publisher capabilities, including on RUNNING. */
export function projectMoqTaskStatus(value: unknown): MoqTaskStatus | null {
	const parsed = taskMetadataSchema.safeParse(value);
	if (!parsed.success) return null;
	return {
		status: parsed.data.status,
		...(parsed.data.progress !== undefined
			? { progress: parsed.data.progress }
			: {}),
	};
}

type MoqTaskHistory =
	| { moq: false; stepLog: unknown; error: unknown }
	| { moq: true; stepLog: StepLogEntry[]; error: string | null };

/** Shared by Worker resumes and public readers of previously persisted MoQ runs. */
export function projectMoqTaskHistory(
	stepLog: unknown,
	error: unknown,
): MoqTaskHistory {
	const moq =
		Array.isArray(stepLog) &&
		stepLog.some(
			(entry) =>
				entry !== null &&
				typeof entry === "object" &&
				entry.kind === "CREATE_OUTPUT_MOQ",
		);
	if (!moq) return { moq: false, stepLog, error };
	const parsed = stepLogSchema.safeParse(stepLog);
	return {
		moq: true,
		error:
			error === undefined || error === null || error === ""
				? null
				: MOQ_TASK_HISTORY_ERROR,
		stepLog: parsed.success
			? parsed.data.map((entry) => ({
					...entry,
					...(entry.error ? { error: MOQ_TASK_HISTORY_ERROR } : {}),
					...(entry.kind === "AWAIT_LIVE_RUNNING" &&
					entry.response !== undefined
						? { response: projectMoqTaskStatus(entry.response) }
						: {}),
				}))
			: [],
	};
}
