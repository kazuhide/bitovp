"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { moqObservationPath } from "@/lib/moq-player/history-client";
import { moqObservationHistorySchema } from "@/lib/moq-player/observations";

export function useMoqObservationHistory(
	channelId: string,
	runId: string,
	refresh: boolean,
	enabled = true,
) {
	return useQuery({
		queryKey: ["moq-observations", channelId, runId],
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
		refetchInterval: refresh ? 5000 : false,
	});
}
