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
	let startAcknowledged = false;
	let settled = false;
	function onPageHide() {
		void settle("CANCELED");
	}
	window.addEventListener("pagehide", onPageHide);
	const start = sendOperationAttempt(organizationId, {
		...identity,
		stage: "STARTED",
	}).then((acknowledged) => {
		startAcknowledged = acknowledged;
		if (!acknowledged) window.removeEventListener("pagehide", onPageHide);
		return acknowledged;
	});
	function settle(
		stage: ResultStage,
		elapsedMs = Math.max(0, Math.round(performance.now() - startedAt)),
	) {
		if (settled) return;
		settled = true;
		window.removeEventListener("pagehide", onPageHide);
		if (elapsedMs > MAX_OPERATION_ELAPSED_MS) return;
		const send = () => {
			if (performance.now() - startedAt > RESULT_RECEIVE_WINDOW_MS) return;
			void sendOperationAttempt(organizationId, {
				...identity,
				stage,
				elapsedMs,
			});
		};
		// Send immediately when a start is known, including during pagehide.
		if (startAcknowledged) send();
		else
			void start.then((acknowledged) => {
				if (acknowledged) send();
			});
	}
	return settle;
}
