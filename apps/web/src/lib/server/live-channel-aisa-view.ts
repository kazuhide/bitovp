import "server-only";
import {
	type AisaFinalizationRun,
	aisaLiveFinalization,
	deriveProviderLifecycle,
	isAisaManagedLivePlan,
	type PersistedProviderState,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { aisaLiveAccessAllowed } from "./aisa-live-access";
import {
	projectSafeHeartbeat,
	projectSafeHeartbeatReception,
} from "./safe-heartbeat-projection";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A persisted run binding still protects a channel whose old plan is unreadable. */
export function isAisaLiveChannelView(channel: unknown, run: unknown): boolean {
	const row = record(channel);
	const binding = record(run);
	return (
		row?.origin === "AISA_IMPORTED" ||
		isAisaManagedLivePlan(row?.plan) ||
		(binding !== null &&
			["aisaAnalysisId", "aisaStatus", "aisaSnapshot"].some(
				(key) => binding[key] !== null && binding[key] !== undefined,
			))
	);
}

/** Use freshly authenticated context, never a caller-supplied role or actor header. */
export function aisaPublisherConnectionAllowed(tenant: unknown): boolean {
	return aisaLiveAccessAllowed(tenant);
}

/** Separate an ended encoder's recovery from the action that stops an active encoder. */
export async function canRetryEndedAisaFinalization(
	prisma: Pick<AppPrismaClient, "liveEffectClaim">,
	channel: {
		id: string;
		status: string;
		bitmovinEncodingId: string | null;
		plan: unknown;
	},
	run:
		| (AisaFinalizationRun &
				PersistedProviderState & {
					id: string;
					status: string;
					error: string | null;
					cancelRequested: boolean;
				})
		| null,
	nowMs: number,
): Promise<boolean> {
	if (
		!run ||
		run.cancelRequested ||
		!channel.bitmovinEncodingId ||
		run.bitmovinEncodingId !== channel.bitmovinEncodingId ||
		!isAisaManagedLivePlan(channel.plan) ||
		deriveProviderLifecycle(run, nowMs) !== "TERMINAL"
	)
		return false;
	const finalization = aisaLiveFinalization(run);
	if (finalization === "PENDING") {
		const recoverable = ["RUNNING", "STOPPING", "ERROR", "STOPPED"];
		return (
			recoverable.includes(channel.status) && recoverable.includes(run.status)
		);
	}
	if (
		finalization !== "FAILED" ||
		!["ERROR", "STOPPED"].includes(channel.status) ||
		!["ERROR", "STOPPED"].includes(run.status)
	)
		return false;
	if (run.status !== "ERROR" || run.error !== "AISA_LIVE_TERMINAL_FAILURE")
		return true;

	// The final result can land before its durable stop claim is acknowledged.
	const claim = await prisma.liveEffectClaim.findUnique({
		where: { idempotencyKey: `manual:stop:${channel.id}:${run.id}` },
		select: {
			state: true,
			action: true,
			liveChannelId: true,
			liveChannelRunId: true,
			providerEncodingId: true,
			scheduleId: true,
			targetId: true,
			requestSha256: true,
		},
	});
	return (
		claim?.state === "AMBIGUOUS" &&
		claim.action === "STOP" &&
		claim.liveChannelId === channel.id &&
		claim.liveChannelRunId === run.id &&
		claim.providerEncodingId === channel.bitmovinEncodingId &&
		claim.scheduleId === null &&
		claim.targetId === null &&
		claim.requestSha256 === null
	);
}

export const AISA_CHANNEL_RESPONSE_HEADERS = {
	"Cache-Control": "private, no-store",
	Vary: "Cookie, Authorization",
};

function fields<Key extends string>(
	value: Record<string, unknown>,
	names: readonly Key[],
): Record<Key, unknown> {
	return Object.fromEntries(
		names.map((name) => [name, value[name] ?? null]),
	) as Record<Key, unknown>;
}

const channelFields = [
	"id",
	"name",
	"origin",
	"status",
	"bitmovinAccountId",
	"bitmovinEncodingId",
	"createdAt",
	"updatedAt",
	"runningSince",
	"programStartAt",
	"programEndAt",
	"maxRunMinutes",
] as const;
const runFields = [
	"id",
	"seq",
	"status",
	"cancelRequested",
	"bitmovinEncodingId",
	"createdAt",
	"runningSince",
	"endedAt",
	"programStartAt",
	"programEndAt",
	"lastHeartbeatAt",
	"providerStatus",
	"providerStatusObservedAt",
	"providerUnknownSince",
	"providerTerminalAt",
] as const;

function runCreatedAt(value: unknown): Date | undefined {
	const created =
		value instanceof Date
			? value
			: typeof value === "string"
				? new Date(value)
				: undefined;
	return created && Number.isFinite(created.getTime()) ? created : undefined;
}

function publicRun(value: unknown, now: Date) {
	const run = record(value);
	if (!run) return null;
	const createdAt = runCreatedAt(run.createdAt);
	const monitoringBound =
		typeof run.id === "string" &&
		typeof run.bitmovinEncodingId === "string" &&
		createdAt !== undefined;
	return {
		...fields(run, runFields),
		aisaAnalysisId: null,
		aisaStatus: null,
		aisaObservedAt: null,
		aisaSnapshot: null,
		streamKey: null,
		encoderIp: null,
		stepLog: [],
		lastHeartbeat: monitoringBound
			? projectSafeHeartbeat(run.lastHeartbeat, now, createdAt)
			: null,
		liveToVod: null,
		originObservation: null,
		error: run.error ? "AISA operation failed" : null,
	};
}

/**
 * Nonowners keep ordinary Live monitoring, without AISA data or publisher material.
 * Build the response from an allowlist: plans, compiled payloads, raw telemetry,
 * diagnostics and future fields can all contain ingest coordinates under aliases.
 */
export function aisaChannelViewerProjection(
	channel: unknown,
	run: unknown,
	options: { heartbeatReception?: unknown; observedNow?: Date } = {},
) {
	const row = record(channel) ?? {};
	const now = options.observedNow ?? new Date();
	const currentRun = publicRun(run, now);
	const runId = typeof currentRun?.id === "string" ? currentRun.id : null;
	const createdAt = runCreatedAt(record(run)?.createdAt);
	const monitoringBound =
		createdAt !== undefined &&
		typeof currentRun?.bitmovinEncodingId === "string";
	return {
		...fields(row, channelFields),
		aisaFeatureAllowed: false,
		// Retain only the marker used by the common Live detail to select its view.
		plan: {
			start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
		},
		streamKey: null,
		encoderIp: null,
		stepLog: [],
		// The run is authoritative: an absent sample cannot fall through to a
		// previous airing's channel mirror.
		lastHeartbeat: currentRun?.lastHeartbeat ?? null,
		liveToVod: null,
		liveToVodFamilies: null,
		playbackLinks: [],
		playbackLinksAvailability: "unavailable" as const,
		error: row.error ? "AISA operation failed" : null,
		currentRun,
		heartbeatReception: projectSafeHeartbeatReception(
			monitoringBound ? options.heartbeatReception : undefined,
			runId,
			now,
			createdAt,
		),
		technicalDetailsAllowed: false,
		monitoringSafeForViewer: true as const,
		serverNow: now.toISOString(),
	};
}
