import "server-only";
import { isAisaManagedLivePlan } from "@bitovp/core";
import { aisaResultSchema } from "@/lib/aisa-live/contracts";
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
	const principal = record(tenant);
	if (
		principal?.isImpersonating !== false ||
		(principal.role !== "ADMIN" && principal.role !== "OPERATOR") ||
		typeof principal.actor !== "string"
	)
		return false;
	const actor = principal.actor;
	// The authenticated legacy owner is ADMIN in password/none mode.
	if (actor === "session" || actor === "none")
		return principal.role === "ADMIN";
	if (actor.startsWith("user:") && actor.length > "user:".length) return true;
	return (
		actor.startsWith("token:") &&
		actor.length > "token:".length &&
		actor !== "token:unresolved" &&
		principal.tokenRoleKnown === true
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
	"aisaAnalysisId",
	"aisaStatus",
	"aisaObservedAt",
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
	const parsed = aisaResultSchema.safeParse(run.aisaSnapshot);
	const snapshot =
		parsed.success &&
		parsed.data.analysisId === run.aisaAnalysisId &&
		parsed.data.encodingId === run.bitmovinEncodingId
			? parsed.data
			: null;
	return {
		...fields(run, runFields),
		aisaSnapshot: snapshot,
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
 * AISA results are VIEWER-readable; publisher connection material is OPERATOR-only.
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
