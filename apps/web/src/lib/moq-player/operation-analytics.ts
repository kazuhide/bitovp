import {
	MAX_OPERATION_ELAPSED_MS,
	OPERATION_ATTEMPTS_PATH,
	type OperationAttemptEvent,
	RESULT_RECEIVE_WINDOW_MS,
} from "@/lib/operation-attempts";

type ResultStage = Exclude<OperationAttemptEvent["stage"], "STARTED">;

async function sendOperationAttempt(
	organizationId: string,
	event: OperationAttemptEvent,
) {
	try {
		const response = await fetch(OPERATION_ATTEMPTS_PATH, {
			method: "POST",
			mode: "same-origin",
			redirect: "error",
			keepalive: true,
			headers: {
				"content-type": "application/json",
				"x-bitovp-expected-org": organizationId,
			},
			body: JSON.stringify(event),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export function trackMoqPlaybackOperation(
	{
		organizationId,
		channelId,
		runId,
	}: {
		organizationId: string;
		channelId: string;
		runId: string;
	},
	startedAt: number,
) {
	let attemptId: string;
	try {
		attemptId = crypto.randomUUID();
	} catch {
		return;
	}
	const identity = {
		operation: "LIVE_MOQ_PLAYBACK",
		attemptId,
		channelId,
		runId,
	} as const;
	const start = sendOperationAttempt(organizationId, {
		...identity,
		stage: "STARTED",
	});
	let settled = false;
	return (
		stage: ResultStage,
		elapsedMs = Math.max(0, Math.round(performance.now() - startedAt)),
	) => {
		if (settled) return;
		settled = true;
		if (elapsedMs > MAX_OPERATION_ELAPSED_MS) return;
		void start.then((acknowledged) => {
			// The server pairs results with a previously accepted start.
			if (
				!acknowledged ||
				performance.now() - startedAt > RESULT_RECEIVE_WINDOW_MS
			)
				return;
			return sendOperationAttempt(organizationId, {
				...identity,
				stage,
				elapsedMs,
			});
		});
	};
}
