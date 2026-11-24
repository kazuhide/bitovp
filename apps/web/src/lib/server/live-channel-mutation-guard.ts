import "server-only";
import { isAisaManagedLivePlan } from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { aisaLiveAccessAllowed } from "./aisa-live-access";
import { jsonError } from "./http";
import { isAisaLiveChannelView } from "./live-channel-aisa-view";

/** Imported terminal runs are history, never an editable live channel. */
export function rejectImportedAisaMutation(channel: { origin?: string }) {
	if (channel.origin === "AISA_IMPORTED")
		return jsonError(409, "Imported AISA runs are read-only", {
			code: "AISA_IMPORTED_READ_ONLY",
		});
	return null;
}

/** Current managed integration does not retain the ordinary authored graph. */
export function rejectAisaGraphMutation(channel: {
	origin?: string;
	plan?: unknown;
}) {
	const imported = rejectImportedAisaMutation(channel);
	if (imported) return imported;
	if (isAisaManagedLivePlan(channel.plan))
		return jsonError(
			409,
			"This operation is unavailable for AISA Live Preview",
			{ code: "AISA_ACTION_UNSUPPORTED" },
		);
	return null;
}

/** Channel then run is the lock order used by Start, Stop and provider binding. */
export async function lockLiveScheduleTarget(
	tx: AppTransactionClient,
	channelId: string,
) {
	await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${channelId}::uuid FOR UPDATE`;
	await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE "liveChannelId" = ${channelId}::uuid ORDER BY seq DESC LIMIT 1 FOR UPDATE`;
}

export const latestScheduleBinding = {
	orderBy: { seq: "desc" },
	take: 1,
	select: {
		id: true,
		aisaAnalysisId: true,
		aisaStatus: true,
		aisaSnapshot: true,
		stepLog: true,
	},
} as const;

export function rejectLiveScheduleMutation(
	channel: { origin?: string; plan?: unknown; runs?: readonly unknown[] },
	tenant: unknown,
	action:
		| "START"
		| "STOP"
		| "SLATE_IN"
		| "FEEDER_START"
		| "FEEDER_SWITCH"
		| "CANCEL"
		| "CAP",
) {
	const managed = isAisaLiveChannelView(channel, channel.runs?.[0]);
	if (managed && !aisaLiveAccessAllowed(tenant))
		return jsonError(404, "Not found");
	if (action === "CAP" && managed)
		return jsonError(
			409,
			"Runtime-cap updates are unavailable for AISA Live Preview",
			{ code: "AISA_ACTION_UNSUPPORTED" },
		);
	const imported = rejectImportedAisaMutation(channel);
	if (imported) return imported;
	if (
		managed &&
		(!["STOP", "SLATE_IN", "CANCEL"].includes(action) ||
			(action === "SLATE_IN" && !isAisaManagedLivePlan(channel.plan)))
	)
		return jsonError(
			409,
			"This operation is unavailable for AISA Live Preview",
			{ code: "AISA_ACTION_UNSUPPORTED" },
		);
	return null;
}
