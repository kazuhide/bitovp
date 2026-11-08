import "server-only";
import { z } from "zod";
import type { HeartbeatReception } from "@/app/live/live-shared";
import {
	type HeartbeatReceiptValue,
	heartbeatReceiptValue,
} from "./heartbeat-receipt-value";

const iso = z.iso
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());
const metric = z.number().finite().nonnegative().optional().catch(undefined);
const deltasSchema = z.object({
	droppedPacketsVideo: metric,
	droppedPacketsAudio: metric,
	corruptPacketsVideo: metric,
	corruptPacketsAudio: metric,
});
const timelineSchema = z.object({
	events: z
		.array(
			z.object({
				kind: z.enum(["FIRST_CONNECT", "DISCONNECT", "RECONNECT"]),
				eventAt: iso,
				observedReceivedAt: iso,
			}),
		)
		.max(100),
	coverage: z.literal("recent-receipts"),
	truncated: z.boolean(),
});
const registrationSchema = z.object({
	mode: z.enum([
		"PER_ENCODING",
		"LEGACY_ACCOUNT",
		"PENDING_VERSION",
		"POLL_ONLY",
	]),
	status: z.enum(["ACTIVE", "SKIPPED", "FAILED", "DELETED"]),
});

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function inRun(value: string, now: Date, notBefore?: Date): boolean {
	const ms = Date.parse(value);
	return ms <= now.getTime() && (!notBefore || ms >= notBefore.getTime());
}

function observedHls(raw: HeartbeatReceiptValue): boolean {
	return (
		raw.output?.manifests?.hls?.some((manifest) =>
			manifest.manifestUpdates?.some(
				(update) => update.manifestUpdateWallClockTime !== undefined,
			),
		) === true
	);
}

/** Topology is inferred only from retained, valid HLS update evidence. */
export function hasObservedHlsOutput(value: unknown): boolean {
	const parsed = heartbeatReceiptValue.safeParse(value);
	return parsed.success && observedHls(parsed.data);
}

function safeRaw(value: unknown): HeartbeatReceiptValue | null {
	const parsed = heartbeatReceiptValue.safeParse(value);
	if (!parsed.success) return null;
	const raw = parsed.data;
	const ingest = raw.ingest;
	const hasMetrics = (value: object | undefined) =>
		value !== undefined &&
		Object.values(value).some((value) => typeof value === "number");
	// Invalid known fields are dropped by the shared schema. If nothing known
	// remains, do not turn an arbitrary object into a fresh/healthy heartbeat.
	return raw.timestamp !== undefined ||
		ingest?.status !== undefined ||
		ingest?.healthy !== undefined ||
		hasMetrics(ingest) ||
		ingest?.streams?.some((stream) => hasMetrics(stream)) ||
		observedHls(raw) ||
		hasMetrics(raw.output?.segments?.totalProcessingStatsMs)
		? raw
		: null;
}

export function projectSafeHeartbeat(
	value: unknown,
	now: Date,
	notBefore?: Date,
) {
	const sample = record(value);
	const at = iso.safeParse(sample?.at);
	const raw = safeRaw(sample?.raw);
	if (!at.success || !inRun(at.data, now, notBefore) || !raw) return null;
	const parsedDeltas = deltasSchema.safeParse(sample?.deltas);
	const deltas =
		parsedDeltas.success &&
		Object.values(parsedDeltas.data).some((value) => value !== undefined)
			? parsedDeltas.data
			: undefined;
	return { at: at.data, raw, ...(deltas ? { deltas } : {}) };
}

/** The reader already bound Encoding/signature; retain its exact run identity. */
export function projectSafeHeartbeatReception(
	value: unknown,
	runId: string | null,
	now: Date,
	notBefore?: Date,
): HeartbeatReception {
	const source = record(value);
	const unavailable = { state: "unavailable" as const, runId };
	if (!runId || source?.state !== "available" || source.runId !== runId)
		return unavailable;
	const sample = (value: unknown) => {
		const source = record(value);
		const receivedAt = iso.safeParse(source?.receivedAt);
		const sampledAt = iso.safeParse(source?.sampledAt);
		const raw = safeRaw(source?.raw);
		if (
			!receivedAt.success ||
			!sampledAt.success ||
			!raw ||
			!inRun(receivedAt.data, now, notBefore) ||
			!inRun(sampledAt.data, now, notBefore) ||
			(raw.timestamp !== undefined && raw.timestamp !== sampledAt.data)
		)
			return null;
		return { receivedAt: receivedAt.data, sampledAt: sampledAt.data, raw };
	};
	const latest = sample(source.latest);
	const candidate = sample(source.previous);
	const previous =
		latest &&
		candidate &&
		Date.parse(candidate.sampledAt) < Date.parse(latest.sampledAt)
			? candidate
			: null;
	const parsedTimeline = timelineSchema.safeParse(source.timeline);
	const timeline =
		parsedTimeline.success &&
		parsedTimeline.data.events.every(
			(event) =>
				inRun(event.eventAt, now, notBefore) &&
				inRun(event.observedReceivedAt, now, notBefore),
		)
			? parsedTimeline.data
			: undefined;
	const registration = registrationSchema.safeParse(source.registration);
	return {
		state: "available",
		runId,
		configuredIntervalS:
			typeof source.configuredIntervalS === "number" &&
			Number.isFinite(source.configuredIntervalS) &&
			source.configuredIntervalS > 0
				? source.configuredIntervalS
				: null,
		latest,
		previous,
		previousReceivedAt: previous?.receivedAt ?? null,
		...(timeline ? { timeline } : {}),
		...(registration.success
			? {
					registration: {
						...registration.data,
						// Provider version diagnostics are not needed for public health.
						requestedEncoderVersion: null,
						resolvedEncoderVersion: null,
					},
				}
			: {}),
	};
}
