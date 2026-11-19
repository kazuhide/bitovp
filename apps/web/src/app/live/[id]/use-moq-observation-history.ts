"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { moqObservationPath } from "@/lib/moq-player/history-client";
import { moqObservationHistorySchema } from "@/lib/moq-player/observations";

type HistoryScope = "live" | "archive";

export function moqObservationHistoryKey(
	channelId: string,
	runId: string,
	scope: HistoryScope = "archive",
) {
	const key = ["moq-observations", channelId, runId] as const;
	return scope === "live" ? ([...key, "live"] as const) : key;
}

export function useMoqObservationHistory(
	channelId: string,
	runId: string,
	scope: HistoryScope,
	enabled = true,
) {
	return useQuery({
		queryKey: moqObservationHistoryKey(channelId, runId, scope),
		queryFn: async ({ signal }) => {
			const value = moqObservationHistorySchema.parse(
				await apiFetch(moqObservationPath(channelId, runId), {
					cache: "no-store",
					signal,
				}),
			);
			if (value.runId !== runId) throw new Error();
			return value;
		},
		enabled,
		retry: false,
		refetchInterval: scope === "live" ? 5000 : false,
	});
}
