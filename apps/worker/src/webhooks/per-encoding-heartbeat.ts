import { randomUUID } from "node:crypto";
import {
	deriveWebhookKey,
	HEARTBEAT_WEBHOOK_KIND,
	type HeartbeatRegistrationConfig,
	hashWebhookToken,
	heartbeatCustomData,
	LIVE_RUN_LIVE_STATUSES,
	newWebhookToken,
	nextRegistrationAttemptAt,
	parseHeartbeatRegistrationConfig,
	resolveHeartbeatMode,
	webhookReceiverPath,
	webhookUrlMatchesBase,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

export type EncodingHeartbeatPayload = {
	name: string;
	url: string;
	interval: number;
	signature: { type: "HMAC"; key: string };
	customData: ReturnType<typeof heartbeatCustomData>;
};
export type EncodingHeartbeatHook = {
	id: string;
	name?: string;
	url?: string;
	interval?: number;
};
export type PerEncodingHeartbeatProvider = {
	getHeartbeatEncodingVersion(
		encodingId: string,
	): Promise<{ requested: string | null; resolved: string | null }>;
	createEncodingHeartbeat(
		encodingId: string,
		payload: EncodingHeartbeatPayload,
	): Promise<{ id: string }>;
	listEncodingHeartbeats(encodingId: string): Promise<EncodingHeartbeatHook[]>;
	getEncodingHeartbeatCustomData(
		encodingId: string,
		webhookId: string,
	): Promise<unknown>;
	removeEncodingHeartbeat(encodingId: string, webhookId: string): Promise<void>;
};

/** A durable intent, not retryable POSTs, closes the immediate-delivery/crash window. */
export async function reconcilePerEncodingHeartbeats(deps: {
	prisma: AppPrismaClient;
	at: Date;
	heartbeat: {
		intervalS: number;
		mode?: "PER_ENCODING" | "AUTO" | "LEGACY_ACCOUNT";
	} | null;
	/** Authoritative creation time of the current organization, never a global fallback. */
	rolloutEnabledAt?: () => Promise<Date | null>;
	ingressBase: string | null;
	masterSecret: string;
	keyId: string;
	providerFor(accountId: string): Promise<PerEncodingHeartbeatProvider>;
	spend(): boolean;
	resetCleanupResult?(
		id: string,
		providerId: string | null,
		ownerToken: string,
	): Promise<boolean>;
	stats: {
		registered: number;
		skipped: number;
		failed: number;
		retired: number;
	};
}): Promise<void> {
	const { prisma, at } = deps;
	let rollout = await prisma.appSetting.findUnique({
		where: { key: "live:heartbeat-per-encoding-rollout" },
		select: { value: true },
	});
	// The original migration seeded only the legacy organization's setting.
	// A new tenant needs its own cutoff before its first run is reconciled.
	// Its creation time admits its own new runs while pre-tenant legacy airings
	// remain excluded. Existing (including malformed) markers are never replaced.
	if (!rollout && deps.heartbeat && deps.rolloutEnabledAt) {
		const enabledAt = await deps.rolloutEnabledAt();
		if (enabledAt && Number.isFinite(enabledAt.getTime())) {
			try {
				await prisma.appSetting.create({
					data: {
						key: "live:heartbeat-per-encoding-rollout",
						value: { enabledAt: enabledAt.toISOString() },
					},
				});
			} catch (error) {
				if (object(error)?.code !== "P2002") throw error;
			}
			// A concurrent initializer's persisted cutoff is the only authority.
			rollout = await prisma.appSetting.findUnique({
				where: { key: "live:heartbeat-per-encoding-rollout" },
				select: { value: true },
			});
		}
	}
	const cutoffValue = object(rollout?.value)?.enabledAt;
	const cutoff =
		typeof cutoffValue === "string" ? Date.parse(cutoffValue) : Number.NaN;
	// Missing/invalid authority never silently migrates an already-running encoding.
	if (deps.heartbeat && Number.isFinite(cutoff)) {
		const runs = await prisma.liveChannelRun.findMany({
			where: {
				createdAt: { gte: new Date(cutoff) },
				bitmovinEncodingId: { not: null },
				status: { in: [...LIVE_RUN_LIVE_STATUSES] },
				liveChannel: { bitmovinAccountId: { not: null } },
			},
			select: {
				id: true,
				liveChannelId: true,
				bitmovinEncodingId: true,
				liveChannel: { select: { bitmovinAccountId: true, plan: true } },
			},
		});
		for (const run of runs) {
			if (!run.bitmovinEncodingId || !run.liveChannel.bitmovinAccountId)
				continue;
			const requested = object(
				object(run.liveChannel.plan)?.bitmovin,
			)?.encoderVersion;
			const config: HeartbeatRegistrationConfig = {
				v: 1,
				mode: resolveHeartbeatMode(
					typeof requested === "string" ? requested : null,
					null,
					deps.heartbeat.mode,
				),
				requestedEncoderVersion:
					typeof requested === "string" ? requested : null,
				resolvedEncoderVersion: null,
				intervalS: deps.heartbeat.intervalS,
				registrationId: randomUUID(),
				channelId: run.liveChannelId,
				runId: run.id,
				createAttempted: false,
			};
			await prisma.webhookRegistration.upsert({
				where: {
					encodingId_kind: {
						encodingId: run.bitmovinEncodingId,
						kind: HEARTBEAT_WEBHOOK_KIND,
					},
				},
				create: {
					scope: "hb",
					encodingId: run.bitmovinEncodingId,
					kind: HEARTBEAT_WEBHOOK_KIND,
					bitmovinAccountId: run.liveChannel.bitmovinAccountId,
					liveChannelRunId: run.id,
					configuration: config,
					status: "SKIPPED",
					note: config.mode,
				},
				update: {},
			});
		}
	}
	const rows = await prisma.webhookRegistration.findMany({
		where: { scope: "hb", kind: HEARTBEAT_WEBHOOK_KIND },
		include: { liveChannelRun: { select: { status: true } } },
		orderBy: { createdAt: "asc" },
	});
	for (const stale of rows) {
		if (stale.encodingId.startsWith("account:")) continue;
		const config = parseHeartbeatRegistrationConfig(stale.configuration);
		if (!config) continue; // malformed intent has no authority to mutate provider resources
		const live =
			stale.liveChannelRun &&
			(LIVE_RUN_LIVE_STATUSES as readonly string[]).includes(
				stale.liveChannelRun.status,
			);
		const retire =
			!live ||
			!deps.heartbeat ||
			(stale.status !== "DELETED" &&
				((stale.url &&
					deps.ingressBase &&
					!webhookUrlMatchesBase(stale.url, deps.ingressBase)) ||
					(stale.keyId && stale.keyId !== deps.keyId)));
		if (stale.status === "DELETED" && (!live || !deps.heartbeat)) continue;
		// Legacy mode/cadence is part of receipt history: never rewrite a live run.
		// Its owned account hook retires separately; Poll covers the remaining run.
		if (
			!retire &&
			(config.mode === "POLL_ONLY" || config.mode === "LEGACY_ACCOUNT")
		)
			continue;
		if (
			!retire &&
			stale.status === "ACTIVE" &&
			config.mode === "PER_ENCODING"
		) {
			await promoteEarlyReceipts(prisma, stale, config);
			continue;
		}
		if (
			(stale.nextAttemptAt && stale.nextAttemptAt > at) ||
			(stale.claimedUntil && stale.claimedUntil > at)
		)
			continue;
		const claimUntil = new Date(at.getTime() + 60_000);
		const claim = await prisma.webhookRegistration.updateMany({
			where: {
				id: stale.id,
				// A lease being free is not proof this snapshot is still current:
				// another worker may already have created and released the hook.
				updatedAt: stale.updatedAt,
				status: stale.status,
				url: stale.url,
				providerWebhookId: stale.providerWebhookId,
				attempts: stale.attempts,
				AND: [
					{ OR: [{ claimedUntil: null }, { claimedUntil: { lte: at } }] },
					{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }] },
				],
			},
			data: { claimedUntil: claimUntil },
		});
		if (!claim.count) continue;
		const update = async (
			data: Parameters<typeof prisma.webhookRegistration.updateMany>[0]["data"],
		) =>
			prisma.webhookRegistration.updateMany({
				where: { id: stale.id, claimedUntil: claimUntil },
				data,
			});
		let learnedProviderId: string | null = null;
		try {
			const api = await deps.providerFor(stale.bitmovinAccountId);
			const call = async <T>(operation: () => Promise<T>): Promise<T> => {
				if (!deps.spend()) throw new Error("budget");
				return operation();
			};
			if (retire) {
				let ids = stale.providerWebhookId ? [stale.providerWebhookId] : [];
				if (!ids.length && config.createAttempted) {
					const hooks = await call(() =>
						api.listEncodingHeartbeats(stale.encodingId),
					);
					ids = await ownedHooks(hooks, stale.url, config, (id) =>
						call(() =>
							api.getEncodingHeartbeatCustomData(stale.encodingId, id),
						),
					);
					// An absent list cannot prove a timed-out POST never committed.
					if (!ids.length) {
						await update({
							status: "FAILED",
							note: "heartbeat: unresolved create cleanup",
							claimedUntil: null,
							nextAttemptAt: nextRegistrationAttemptAt(stale.attempts + 1, at),
							attempts: stale.attempts + 1,
						});
						continue;
					}
				}
				for (const id of ids)
					await call(() => api.removeEncodingHeartbeat(stale.encodingId, id));
				await update({
					status: "DELETED",
					providerWebhookId: null,
					deletedAt: at,
					claimedUntil: null,
					nextAttemptAt: null,
					attempts: 0,
					note: "heartbeat: retired",
					configuration: { ...config, createAttempted: false },
				});
				deps.stats.retired++;
				continue;
			}
			if (config.mode === "PENDING_VERSION") {
				const version = await call(() =>
					api.getHeartbeatEncodingVersion(stale.encodingId),
				);
				config.requestedEncoderVersion = version.requested;
				config.resolvedEncoderVersion = version.resolved;
				config.mode = resolveHeartbeatMode(version.requested, version.resolved);
				await update({ configuration: config, note: config.mode });
				if (config.mode !== "PER_ENCODING") {
					await update({
						status: "SKIPPED",
						claimedUntil: null,
						nextAttemptAt:
							config.mode === "PENDING_VERSION"
								? new Date(at.getTime() + 10_000)
								: null,
					});
					continue;
				}
			}
			if (!deps.ingressBase) {
				await update({ claimedUntil: null, note: "ingressUnavailable" });
				deps.stats.skipped++;
				continue;
			}
			const token =
				(stale.status !== "DELETED" && stale.url
					? new URL(stale.url).pathname.split("/").at(-1)
					: null) ?? newWebhookToken();
			const url = `${deps.ingressBase}${webhookReceiverPath("hb", token)}`;
			// Discover before every possible create. Dedicated customdata GET is required:
			// writeOnly metadata does not appear in the ordinary list response.
			const hooks = await call(() =>
				api.listEncodingHeartbeats(stale.encodingId),
			);
			const ids = await ownedHooks(hooks, url, config, (id) =>
				call(() => api.getEncodingHeartbeatCustomData(stale.encodingId, id)),
			);
			let id = ids[0];
			for (const duplicate of ids.slice(1))
				await call(() =>
					api.removeEncodingHeartbeat(stale.encodingId, duplicate),
				);
			if (!id) {
				if (config.createAttempted) throw new Error("ambiguous");
				if (hooks.length >= 5) throw new Error("slots");
				// Spend BEFORE durable attempt: exhaustion must not pretend a POST ran.
				if (!deps.spend()) throw new Error("budget");
				config.createAttempted = true;
				const persisted = await update({
					configuration: config,
					url,
					tokenHash: hashWebhookToken(token),
					keyId: deps.keyId,
					providerWebhookId: null,
					deletedAt: null,
					note: "heartbeat: creating",
				});
				if (!persisted.count) continue;
				id = (
					await api.createEncodingHeartbeat(stale.encodingId, {
						name: `Bitmovin OVP ${config.registrationId}`,
						url,
						interval: config.intervalS,
						signature: {
							type: "HMAC",
							key: deriveWebhookKey(deps.masterSecret, token),
						},
						customData: heartbeatCustomData(config),
					})
				).id;
			}
			learnedProviderId = id;
			const completed = await update({
				status: "ACTIVE",
				providerWebhookId: id,
				url,
				tokenHash: hashWebhookToken(token),
				keyId: deps.keyId,
				configuration: config,
				registeredAt: at,
				deletedAt: null,
				attempts: 0,
				nextAttemptAt: null,
				claimedUntil: null,
				note: "heartbeat: registered",
			});
			if (!completed.count) {
				continue;
			}
			deps.stats.registered++;
			await promoteEarlyReceipts(
				prisma,
				{ ...stale, providerWebhookId: id, tokenHash: hashWebhookToken(token) },
				config,
			);
		} catch (error) {
			const code =
				error instanceof Error &&
				["budget", "slots", "ambiguous"].includes(error.message)
					? error.message
					: "provider";
			await update({
				status: "FAILED",
				note: `heartbeat: ${code}`,
				claimedUntil: null,
				attempts: stale.attempts + 1,
				nextAttemptAt: nextRegistrationAttemptAt(stale.attempts + 1, at),
			});
			deps.stats.failed++;
		} finally {
			// Every claimed exit is covered, including pre-CREATE/version/retire exits.
			// ACK only after all SDK work ends and the exact row is really absent.
			const remaining = await prisma.webhookRegistration.findMany({
				where: { id: stale.id },
				select: { id: true },
				take: 1,
			});
			if (!remaining.length)
				await deps.resetCleanupResult?.(
					stale.id,
					learnedProviderId,
					claimUntil.toISOString(),
				);
		}
	}
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function ownedHooks(
	hooks: EncodingHeartbeatHook[],
	url: string | null,
	config: HeartbeatRegistrationConfig,
	customData: (id: string) => Promise<unknown>,
): Promise<string[]> {
	const owned: string[] = [];
	for (const hook of hooks) {
		if (
			hook.url !== url ||
			hook.interval !== config.intervalS ||
			hook.name !== `Bitmovin OVP ${config.registrationId}`
		)
			continue;
		const data = object(object(await customData(hook.id))?.bitOvp);
		if (
			data?.v === 1 &&
			data.registrationId === config.registrationId &&
			data.channelId === config.channelId &&
			data.runId === config.runId
		)
			owned.push(hook.id);
	}
	return owned;
}

/** Quarantined, signed first receipts become visible only after provider ownership is known. */
async function promoteEarlyReceipts(
	prisma: AppPrismaClient,
	row: {
		providerWebhookId: string | null;
		encodingId: string;
		createdAt: Date;
		tokenHash: string | null;
	},
	config: HeartbeatRegistrationConfig,
) {
	if (!row.providerWebhookId || !row.tokenHash) return;
	const events = await prisma.webhookEvent.findMany({
		where: {
			source: "bitmovin",
			eventType: "LIVE_ENCODING_HEARTBEAT",
			signatureValid: true,
			receiverTokenHash: row.tokenHash,
			processedAt: { not: null },
			liveChannelRunId: null,
			receivedAt: { gte: row.createdAt },
			AND: [
				{ raw: { path: ["webhookId"], equals: row.providerWebhookId } },
				{ raw: { path: ["encoding", "id"], equals: row.encodingId } },
				{
					raw: {
						path: ["customData", "bitOvp", "registrationId"],
						equals: config.registrationId,
					},
				},
				{
					raw: {
						path: ["customData", "bitOvp", "runId"],
						equals: config.runId,
					},
				},
				{
					raw: {
						path: ["customData", "bitOvp", "channelId"],
						equals: config.channelId,
					},
				},
				{ raw: { path: ["customData", "bitOvp", "v"], equals: 1 } },
			],
		},
		select: { id: true },
		take: 100,
		orderBy: { receivedAt: "asc" },
	});
	if (events.length)
		await prisma.webhookEvent.updateMany({
			where: { id: { in: events.map((e) => e.id) }, liveChannelRunId: null },
			data: { liveChannelRunId: config.runId },
		});
}
