"use client";

import type { AisaPlaybackMoment } from "@/lib/aisa-live/playback";
import { useSession } from "@/lib/auth/use-session";
import { bindPassiveRequestUrl } from "@/lib/passive-request";

export type AisaMomentPlayRequest = { identity: string; token: number };

export function useAisaRecordingUrl(
	accountId: string,
	analysisId: string,
	encodingId: string,
) {
	const session = useSession();
	const current = session.status === "success" ? session.data : undefined;
	const organizationId =
		current?.configured && current.authenticated
			? current.organizationId ||
				(current.mode === "password" || current.mode === "none"
					? "00000000-0000-4000-8000-000000000001"
					: "")
			: "";
	return organizationId
		? bindPassiveRequestUrl(
				`/api/live/analyses/${analysisId}/recording?bitmovinAccountId=${accountId}&encodingId=${encodingId}`,
				organizationId,
			)
		: "";
}

export function momentPlaybackIdentity(
	url: string,
	origin: number,
	moment: AisaPlaybackMoment & { id: string; lastUpdatedSequence: number },
) {
	return JSON.stringify([
		url,
		origin,
		moment.id,
		moment.lastUpdatedSequence,
		moment.startInSeconds,
		moment.endInSeconds,
		moment.anchorInSeconds,
	]);
}
