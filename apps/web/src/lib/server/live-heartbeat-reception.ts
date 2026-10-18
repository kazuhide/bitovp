import "server-only";
import {
	heartbeatCustomData,
	parseHeartbeatRegistrationConfig,
	redactSecrets,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type {
	HeartbeatReception,
	PushTimelineEvent,
} from "@/app/live/live-shared";
import { readLiveHeartbeatSettings } from "./live-heartbeat-settings";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function customDataMatches(
	body: unknown,
	config: NonNullable<ReturnType<typeof parseHeartbeatRegistrationConfig>>,
) {
	const actual = record(record(record(body)?.customData)?.bitOvp);
	return (
		actual !== null &&
		Object.entries(heartbeatCustomData(config).bitOvp).every(
			([key, value]) => actual[key] === value,
		)
	);
}

/** Actual ES 2.281 / EMS 0.48 envelope, verified by the run-14 GCS archive. */
function envelope(body: unknown) {
	const object = record(body);
	const encoding = record(object?.encoding);
	const value = record(object?.value);
	const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
	if (
		object?.eventType !== "LIVE_ENCODING_HEARTBEAT" ||
		typeof object.webhookId !== "string" ||
		!uuid.test(object.webhookId) ||
		typeof encoding?.id !== "string" ||
		!uuid.test(encoding.id) ||
		!value
	)
		return null;
	return { webhookId: object.webhookId, encodingId: encoding.id, value };
}

/**
 * : a verified Push receipt as a health-series row — `at` is the
 * PROVIDER's sample time and `raw` the heartbeat body, the same fields the
 * poll mirror persists, so `deriveRunHealth` reads both alike. Null when the
 * receipt is not this encoding's heartbeat or carries no usable timestamp.
 */
export function pushHeartbeatRow(
	raw: unknown,
	encodingId: string,
): { at: Date; raw: Record<string, unknown> } | null {
	const parsed = envelope(raw);
	if (!parsed || parsed.encodingId !== encodingId) return null;
	const sampledAt = parsed.value.timestamp;
	if (typeof sampledAt !== "string") return null;
	const ms = Date.parse(sampledAt);
	if (!Number.isFinite(ms)) return null;
	return { at: new Date(ms), raw: parsed.value };
}

/** Called only AFTER signature verification. Body-supplied account/run ids have no authority. */
export async function bindHeartbeatRun(
	prisma: AppPrismaClient,
	body: unknown,
	tokenHash: string,
	allowLegacyHistory = true,
) {
	const parsed = envelope(body);
	if (!parsed) return null;
	const registration = await prisma.webhookRegistration.findFirst({
		where: {
			scope: "hb",
			kind: "liveEncodingHeartbeat",
			providerWebhookId: parsed.webhookId,
			tokenHash,
		},
		select: {
			id: true,
			bitmovinAccountId: true,
			encodingId: true,
			liveChannelRunId: true,
			configuration: true,
		},
	});
	if (!registration) {
		if (!allowLegacyHistory) return null;
		// Replacement overwrites the account-level registration row. A previously
		// bound, signature-verified event can retain that exact run/hook identity;
		// an unseen hook or an unbound legacy event cannot establish authority.
		const run = await prisma.liveChannelRun.findFirst({
			where: { bitmovinEncodingId: parsed.encodingId },
			select: { id: true },
		});
		if (!run) return null;
		const selected = await prisma.webhookRegistration.findFirst({
			where: {
				liveChannelRunId: run.id,
				kind: "liveEncodingHeartbeat",
				scope: "hb",
			},
			select: { configuration: true },
		});
		const selectedConfig = parseHeartbeatRegistrationConfig(
			selected?.configuration,
		);
		if (selectedConfig && selectedConfig.mode !== "LEGACY_ACCOUNT") return null;
		const prior = await prisma.webhookEvent.findFirst({
			where: {
				source: "bitmovin",
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				liveChannelRunId: run.id,
				AND: [
					{ raw: { path: ["webhookId"], equals: parsed.webhookId } },
					{ raw: { path: ["encoding", "id"], equals: parsed.encodingId } },
				],
			},
			select: { id: true },
		});
		return prior ? { runId: run.id, registrationId: null } : null;
	}
	const config = parseHeartbeatRegistrationConfig(registration.configuration);
	if (registration.configuration != null && !config) return null;
	if (config?.mode === "PENDING_VERSION" || config?.mode === "POLL_ONLY")
		return null;
	if (config?.mode === "PER_ENCODING") {
		if (
			registration.encodingId !== parsed.encodingId ||
			registration.liveChannelRunId !== config.runId ||
			!customDataMatches(body, config)
		)
			return null;
	}
	const run = await prisma.liveChannelRun.findFirst({
		where: {
			...(config?.mode === "PER_ENCODING"
				? { id: config.runId, liveChannelId: config.channelId }
				: {}),
			bitmovinEncodingId: parsed.encodingId,
			liveChannel: { bitmovinAccountId: registration.bitmovinAccountId },
		},
		select: { id: true },
	});
	if (run && config?.mode !== "PER_ENCODING") {
		const selected = await prisma.webhookRegistration.findFirst({
			where: {
				liveChannelRunId: run.id,
				kind: "liveEncodingHeartbeat",
				scope: "hb",
			},
			select: { configuration: true },
		});
		const selectedConfig = parseHeartbeatRegistrationConfig(
			selected?.configuration,
		);
		if (selectedConfig && selectedConfig.mode !== "LEGACY_ACCOUNT") return null;
	}
	return run ? { runId: run.id, registrationId: registration.id } : null;
}

const RECENT_RECEIPT_LIMIT = 300;

/** Read-only Push projection: never races the poll mirror or drives billable lifecycle decisions. */
export async function readHeartbeatReception(
	prisma: AppPrismaClient,
	run: {
		id: string;
		bitmovinEncodingId: string | null;
		createdAt: Date;
	} | null,
	now: Date,
): Promise<HeartbeatReception> {
	try {
		const settings = await readLiveHeartbeatSettings(prisma);
		const empty: HeartbeatReception = {
			state: "available",
			runId: run?.id ?? null,
			configuredIntervalS: settings.effective.intervalS,
			latest: null,
			previous: null,
			timeline: { events: [], coverage: "recent-receipts", truncated: false },
			previousReceivedAt: null,
		};
		if (!run?.bitmovinEncodingId) return empty;
		const registration = await prisma.webhookRegistration.findFirst({
			where: {
				liveChannelRunId: run.id,
				kind: "liveEncodingHeartbeat",
				scope: "hb",
			},
			select: { configuration: true, status: true },
		});
		const config = parseHeartbeatRegistrationConfig(
			registration?.configuration,
		);
		if (config) {
			empty.configuredIntervalS = config.intervalS;
			empty.registration = {
				mode: config.mode,
				requestedEncoderVersion: config.requestedEncoderVersion,
				resolvedEncoderVersion: config.resolvedEncoderVersion,
				status: registration?.status ?? "SKIPPED",
			};
		}
		const rows = await prisma.webhookEvent.findMany({
			where: {
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				liveChannelRunId: run.id,
				receivedAt: { gte: run.createdAt, lte: now },
			},
			orderBy: { receivedAt: "desc" },
			// One lookahead distinguishes a full window from actual older receipts.
			take: RECENT_RECEIPT_LIMIT + 1,
			select: { receivedAt: true, raw: true },
		});
		// Dedupe retries by provider sample time, not event id (older encoders may reuse ids).
		// Earliest receipt per sample within this window; no high-water guarantee across windows.
		const samples = new Map<
			number,
			NonNullable<Extract<HeartbeatReception, { state: "available" }>["latest"]>
		>();
		const events = new Map<string, PushTimelineEvent>();
		let eventCapReached = false;
		for (const row of rows.slice(0, RECENT_RECEIPT_LIMIT)) {
			if (
				config?.mode === "PENDING_VERSION" ||
				config?.mode === "POLL_ONLY" ||
				(config?.mode === "PER_ENCODING" && !customDataMatches(row.raw, config))
			)
				continue;
			const parsed = envelope(row.raw);
			if (!parsed || parsed.encodingId !== run.bitmovinEncodingId) continue;
			const sampledAt = parsed.value.timestamp;
			if (
				typeof sampledAt !== "string" ||
				!Number.isFinite(Date.parse(sampledAt))
			)
				continue;
			const sampleMs = Date.parse(sampledAt);
			if (sampleMs < run.createdAt.getTime() || sampleMs > now.getTime())
				continue;
			const rawEvents = parsed.value.events;
			if (Array.isArray(rawEvents)) {
				if (rawEvents.length > 1_000) eventCapReached = true;
				for (const rawEvent of rawEvents.slice(0, 1_000)) {
					const event = record(rawEvent);
					const details = record(event?.details) ?? event;
					const kind = details?.eventType ?? event?.type;
					const time = event?.time ?? event?.timestamp;
					if (
						(kind !== "FIRST_CONNECT" &&
							kind !== "DISCONNECT" &&
							kind !== "RECONNECT") ||
						typeof time !== "string"
					)
						continue;
					const eventMs = Date.parse(time);
					if (
						!Number.isFinite(eventMs) ||
						eventMs < run.createdAt.getTime() ||
						eventMs > sampleMs
					)
						continue;
					const key = `${kind}:${eventMs}`;
					const previous = events.get(key);
					if (
						!previous ||
						row.receivedAt.getTime() < Date.parse(previous.observedReceivedAt)
					) {
						events.set(key, {
							kind,
							eventAt: new Date(eventMs).toISOString(),
							observedReceivedAt: row.receivedAt.toISOString(),
						});
					}
				}
			}
			const existing = samples.get(sampleMs);
			if (
				!existing ||
				row.receivedAt.getTime() < Date.parse(existing.receivedAt)
			) {
				samples.set(sampleMs, {
					receivedAt: row.receivedAt.toISOString(),
					sampledAt,
					raw: redactSecrets(parsed.value),
				});
			}
		}
		const ordered = [...samples.entries()]
			.sort((a, b) => b[0] - a[0])
			.map(([, sample]) => sample);
		return {
			...empty,
			latest: ordered[0] ?? null,
			previous: ordered[1] ?? null,
			timeline: {
				events: [...events.values()]
					.sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt))
					.slice(-100),
				coverage: "recent-receipts",
				truncated:
					rows.length > RECENT_RECEIPT_LIMIT ||
					events.size > 100 ||
					eventCapReached,
			},
			previousReceivedAt: ordered[1]?.receivedAt ?? null,
		};
	} catch {
		return { state: "unavailable", runId: run?.id ?? null };
	}
}
