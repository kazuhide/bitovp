import { z } from "zod";

export const OPERATION_ATTEMPTS_PATH = "/api/operation-attempts";
export const MAX_OPERATION_ELAPSED_MS = 600_000;
export const RESULT_RECEIVE_WINDOW_MS = MAX_OPERATION_ELAPSED_MS + 60_000;

const uuid = z.uuid().transform((id) => id.toLowerCase());
const target = {
	operation: z.literal("LIVE_MOQ_PLAYBACK"),
	attemptId: uuid,
	channelId: uuid,
	runId: uuid,
};

export const operationAttemptEventSchema = z.discriminatedUnion("stage", [
	z.strictObject({ ...target, stage: z.literal("STARTED") }),
	z.strictObject({
		...target,
		stage: z.enum(["FIRST_FRAME", "FAILED", "CANCELED"]),
		elapsedMs: z.number().int().min(0).max(MAX_OPERATION_ELAPSED_MS),
	}),
]);

export type OperationAttemptEvent = z.infer<typeof operationAttemptEventSchema>;
