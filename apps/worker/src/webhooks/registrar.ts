import {
	deriveWebhookKey,
	HEARTBEAT_EVENT_PRUNE_BATCH,
	HEARTBEAT_EVENT_RETENTION_MS,
	HEARTBEAT_WEBHOOK_KIND,
	hashWebhookToken,
	heartbeatRegistrationKey,
	LIVE_RUN_LIVE_STATUSES,
	newWebhookToken,
	nextRegistrationAttemptAt,
	REGISTRATION_TOMBSTONE_TTL_MS,
	type SecretCipher,
	tokenFromReceiverUrl,
	WEBHOOK_RECONCILE_REQUEST_KEY,
	WEBHOOK_REGISTRATION_KINDS,
	type WebhookRegistrationKind,
	webhookKeyId,
	webhookReceiverPath,
	webhookUrlMatchesBase,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	EncodingJobStatus,
	LiveChannelStatus,
	Prisma,
	WebhookRegistrationStatus,
} from "@bitovp/db";
import {
	readIngressSnapshot,
	recordResetCleanupWebhookResult,
	resolveWebhookMasterSecret,
} from "@bitovp/db";
import {
	type PerEncodingHeartbeatProvider,
	reconcilePerEncodingHeartbeats,
} from "./per-encoding-heartbeat";

/**
 * Per-encoding webhook registrar (WP-G G-2) — a RECONCILER, not a hook.
 *
 * The brief asked for registration "where the orchestrator persists the
 * encoding id". That persist sits inside the lease-fenced step loop of
 * `orchestrator/processor.ts` (and its live twin), the most delicate code in
 * the repository; a call added there would also be lost with the process the
 * moment it crashed between the persist and the provider call. So the
 * registrar reads what those loops PERSIST — `bitmovinEncodingId` on an active
 * job or run — every 10 s, and drives the `WebhookRegistration` table toward
 * the state the world implies:
 *
 *   1. RETIRE: an ACTIVE row whose job/run is terminal or gone, whose URL is
 *      not under the current public ingress, or whose key was derived from a
 *      previous master → `deleteByEncodingIdAndWebhookId` → DELETED.
 *   2. REGISTER: an active encoding with a kind that has no ACTIVE row → one
 *      token per encoding, `createByEncodingId` for three VOD kinds (plus
 *      liveManifestReady only for Live runs)
 *      with `signature: { HMAC, key }` → ACTIVE. No public ingress → the row
 *      is SKIPPED with `ingressUnavailable`, the job is never touched.
 *   3. PRUNE: DELETED rows older than the tombstone TTL.
 *
 * Idempotent by construction (a second start finds its rows), crash-safe
 * (the next tick resumes from the table), and serial + budgeted per tick so
 * an ingress change re-registering fifty encodings never bursts the
 * provider. Every provider mutation is CAS-claimed on the row first, so two
 * workers cannot both create the same hook.
 */

/** Job statuses whose encoding should receive webhooks. */
export const REGISTRABLE_JOB_STATUSES = [
	"QUEUED",
	"RUNNING",
	"AWAITING_QC",
] as const satisfies readonly EncodingJobStatus[];

/** Job statuses that retire a registration (the encoding is done). */
export const TERMINAL_JOB_STATUSES = [
	"FINISHED",
	"ERROR",
	"CANCELED",
	"QC_FAILED",
] as const satisfies readonly EncodingJobStatus[];

/** Run statuses that retire a registration. */
export const TERMINAL_RUN_STATUSES = [
	"STOPPED",
	"ERROR",
] as const satisfies readonly LiveChannelStatus[];

export type RegistrarProviderApi = PerEncodingHeartbeatProvider & {
	create(
		encodingId: string,
		kind: WebhookRegistrationKind,
		payload: { url: string; signature: { type: "HMAC"; key: string } },
	): Promise<{ id: string }>;
	/** Resolves on 404 too — an already-gone hook is the desired state. */
	remove(
		encodingId: string,
		kind: WebhookRegistrationKind,
		webhookId: string,
	): Promise<void>;
	/** Resolves on 404 too. */
	removeHeartbeat(webhookId: string): Promise<void>;
};

export type RegistrarDeps = {
	prisma: AppPrismaClient;
	cipher: SecretCipher;
	/** BITMOVIN_WEBHOOK_SECRET, already blank-stripped. */
	envSecret?: string;
	providerFor(bitmovinAccountId: string): Promise<RegistrarProviderApi>;
	now?: () => Date;
	log?: (message: string) => void;
	/** Provider calls one tick may make; the rest waits for the next tick. */
	maxProviderCallsPerTick?: number;
	/** Per-encoding cadence; null disables and retires heartbeat hooks.
	 * idleMs and old mode aliases remain accepted for caller compatibility only.
	 */
	heartbeat?: () => Promise<{
		intervalS: number;
		idleMs: number;
		mode?: "PER_ENCODING" | "AUTO" | "LEGACY_ACCOUNT";
	} | null>;
	/** Current organization's creation time for an absent tenant rollout marker. */
	heartbeatRolloutEnabledAt?: () => Promise<Date | null>;
};

export type RegistrarTickStats = {
	registered: number;
	skipped: number;
	failed: number;
	retired: number;
	pruned: number;
	/** Heartbeat WebhookEvent rows past their 7-day retention, removed this tick (rev414 R4). */
	heartbeatEventsPruned: number;
	/** True when the budget ran out — more work waits for the next tick. */
	budgetExhausted: boolean;
};

/** How long a CAS claim on a row keeps other workers off it. */
const CLAIM_MS = 60_000;

type RetireReason = "terminal" | "orphan" | "ingressChanged" | "keyRotated";

export function createWebhookRegistrar(deps: RegistrarDeps) {
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? ((message: string) => console.log(message));
	const maxCalls = deps.maxProviderCallsPerTick ?? 40;
	const providers = new Map<string, Promise<RegistrarProviderApi>>();
	const providerFor = (accountId: string) => {
		let api = providers.get(accountId);
		if (!api) {
			api = deps.providerFor(accountId);
			providers.set(accountId, api);
		}
		return api;
	};

	async function tick(): Promise<RegistrarTickStats> {
		providers.clear();
		const at = now();
		const stats: RegistrarTickStats = {
			registered: 0,
			skipped: 0,
			failed: 0,
			retired: 0,
			pruned: 0,
			heartbeatEventsPruned: 0,
			budgetExhausted: false,
		};
		let budget = maxCalls;
		const spend = () => {
			if (budget <= 0) {
				stats.budgetExhausted = true;
				return false;
			}
			budget -= 1;
			return true;
		};

		const ingressBase =
			(await readIngressSnapshot(deps.prisma))?.current?.baseUrl ?? null;
		const master = await resolveWebhookMasterSecret({
			prisma: deps.prisma,
			cipher: deps.cipher,
			envSecret: deps.envSecret,
		});
		const keyId = webhookKeyId(master.secret);

		await honourReconcileRequest(at);

		// New heartbeat registrations are always scoped to a supported encoding.
		const heartbeat = deps.heartbeat ? await deps.heartbeat() : null;
		await reconcilePerEncodingHeartbeats({
			resetCleanupResult: (id, providerId, ownerToken) =>
				recordResetCleanupWebhookResult(
					deps.prisma,
					deps.cipher,
					id,
					providerId,
					ownerToken,
				),
			prisma: deps.prisma,
			at,
			heartbeat,
			rolloutEnabledAt: deps.heartbeatRolloutEnabledAt,
			ingressBase,
			masterSecret: master.secret,
			keyId,
			providerFor,
			spend,
			stats,
		});

		// ---- 1. retire -------------------------------------------------------
		const active = await deps.prisma.webhookRegistration.findMany({
			where: {
				OR: [
					{ status: "ACTIVE" },
					{
						scope: "hb",
						encodingId: { startsWith: "account:" },
						providerWebhookId: { not: null },
						status: { in: ["FAILED", "SKIPPED"] },
					},
				],
			},
			include: {
				encodingJob: { select: { status: true } },
				liveChannelRun: { select: { status: true } },
			},
			orderBy: { createdAt: "asc" },
		});
		for (const row of active) {
			// Individual heartbeat cleanup (including ambiguous FAILED intents) is
			// handled above; never send an encoding hook to the account DELETE API.
			if (row.scope === "hb" && !row.encodingId.startsWith("account:"))
				continue;
			if (
				row.scope === "hb" &&
				(row.kind !== HEARTBEAT_WEBHOOK_KIND ||
					row.encodingId !== heartbeatRegistrationKey(row.bitmovinAccountId))
			)
				continue;
			const reason =
				row.scope === "hb"
					? "perEncodingOnly"
					: retireReason(row, ingressBase, keyId);
			if (reason === null) {
				continue;
			}
			if (row.nextAttemptAt && row.nextAttemptAt > at) {
				continue; // backing off
			}
			if (row.claimedUntil && row.claimedUntil > at) {
				continue; // claimed by another worker
			}
			if (!spend()) {
				break;
			}
			const claimed = await deps.prisma.webhookRegistration.updateMany({
				where: {
					id: row.id,
					status: row.status,
					AND: [
						{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }] },
						{ OR: [{ claimedUntil: null }, { claimedUntil: { lte: at } }] },
					],
				},
				data: { claimedUntil: new Date(at.getTime() + CLAIM_MS) },
			});
			if (claimed.count === 0) {
				continue;
			}
			try {
				if (row.providerWebhookId) {
					const api = await providerFor(row.bitmovinAccountId);
					if (row.scope === "hb") {
						await api.removeHeartbeat(row.providerWebhookId);
					} else {
						await api.remove(
							row.encodingId,
							row.kind as WebhookRegistrationKind,
							row.providerWebhookId,
						);
					}
				}
				await deps.prisma.webhookRegistration.update({
					where: { id: row.id },
					data: {
						status: "DELETED",
						deletedAt: at,
						note: reason,
						nextAttemptAt: null,
						claimedUntil: null,
						attempts: 0,
					},
				});
				stats.retired += 1;
			} catch {
				await deps.prisma.webhookRegistration.update({
					where: { id: row.id },
					data: {
						note: `delete failed (${reason})`,
						attempts: row.attempts + 1,
						nextAttemptAt: nextRegistrationAttemptAt(row.attempts + 1, at),
						claimedUntil: null,
					},
				});
				stats.failed += 1;
				log(
					`[webhook-registrar] delete failed for ${row.encodingId}/${row.kind} (${reason})`,
				);
			} finally {
				const remaining = await deps.prisma.webhookRegistration.findMany({
					where: { id: row.id },
					select: { id: true },
					take: 1,
				});
				if (!remaining.length)
					await recordResetCleanupWebhookResult(
						deps.prisma,
						deps.cipher,
						row.id,
						null,
						new Date(at.getTime() + CLAIM_MS).toISOString(),
					);
			}
		}

		// ---- 2. register -----------------------------------------------------
		const candidates = await liveEncodings();
		if (candidates.length > 0) {
			const existing = await deps.prisma.webhookRegistration.findMany({
				where: { encodingId: { in: candidates.map((c) => c.encodingId) } },
			});
			const byEncoding = new Map<string, typeof existing>();
			for (const row of existing) {
				const rows = byEncoding.get(row.encodingId) ?? [];
				rows.push(row);
				byEncoding.set(row.encodingId, rows);
			}
			for (const candidate of candidates) {
				const rows = byEncoding.get(candidate.encodingId) ?? [];
				const needed = WEBHOOK_REGISTRATION_KINDS.filter(
					(kind) =>
						// Live Manifest Ready is not supported by VOD encodings.
						(kind !== "liveManifestReady" ||
							candidate.liveChannelRunId !== null) &&
						rows.find((r) => r.kind === kind)?.status !== "ACTIVE",
				);
				if (needed.length === 0) {
					continue;
				}
				if (ingressBase === null) {
					for (const kind of needed) {
						const row = rows.find((r) => r.kind === kind);
						if (
							row?.status === "SKIPPED" &&
							row.note === "ingressUnavailable"
						) {
							continue; // already recorded; no churn
						}
						await upsertRow(candidate, kind, {
							status: "SKIPPED",
							note: "ingressUnavailable",
							providerWebhookId: null,
							url: null,
							tokenHash: null,
							keyId: null,
							nextAttemptAt: null,
						});
						stats.skipped += 1;
					}
					continue;
				}
				// Reuse failed-attempt tokens too: a lost response can have created
				// a hook that cleanup must still discover by its exact receiver URL.
				const sibling = rows.find(
					(r) =>
						r.scope === "j" &&
						(r.status === "ACTIVE" || r.status === "FAILED") &&
						r.url !== null &&
						r.keyId === keyId &&
						webhookUrlMatchesBase(r.url, ingressBase),
				);
				const token =
					(sibling?.url ? tokenFromReceiverUrl(sibling.url) : null) ??
					newWebhookToken();
				const url = `${ingressBase}${webhookReceiverPath("j", token)}`;
				const signatureKey = deriveWebhookKey(master.secret, token);
				const tokenHash = hashWebhookToken(token);
				for (const kind of needed) {
					const row = rows.find((r) => r.kind === kind);
					if (row?.nextAttemptAt && row.nextAttemptAt > at) {
						continue; // backing off
					}
					if (row?.claimedUntil && row.claimedUntil > at) {
						continue; // claimed by another worker
					}
					if (!spend()) {
						break;
					}
					// Ensure the row exists, then CAS-claim it before the provider
					// call — two workers cannot both create this hook.
					const owner = await upsertRow(candidate, kind, {});
					const claimUntil = new Date(at.getTime() + CLAIM_MS);
					const claimed = await deps.prisma.webhookRegistration.updateMany({
						where: {
							id: owner.id,
							encodingId: candidate.encodingId,
							kind,
							status: { in: ["SKIPPED", "FAILED", "DELETED"] },
							AND: [
								{
									OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }],
								},
								{ OR: [{ claimedUntil: null }, { claimedUntil: { lte: at } }] },
							],
						},
						data: {
							claimedUntil: claimUntil,
							url,
							tokenHash,
							keyId,
							configuration: { createAttempted: true },
						},
					});
					if (claimed.count === 0) {
						continue;
					}
					try {
						const api = await providerFor(candidate.bitmovinAccountId);
						const created = await api.create(candidate.encodingId, kind, {
							url,
							signature: { type: "HMAC", key: signatureKey },
						});
						await completeRegistration(owner.id, claimUntil, {
							status: "ACTIVE",
							providerWebhookId: created.id,
							url,
							tokenHash,
							keyId,
							note: null,
							attempts: 0,
							nextAttemptAt: null,
							claimedUntil: null,
							registeredAt: at,
							deletedAt: null,
						});
						stats.registered += 1;
					} catch {
						// SDK exceptions can embed the entire receiver URL + HMAC key
						// inside stringified request bodies. Never persist or log them.
						const attempts = (row?.attempts ?? 0) + 1;
						await completeRegistration(owner.id, claimUntil, {
							status: "FAILED",
							note: "provider: registration failed",
							attempts,
							nextAttemptAt: nextRegistrationAttemptAt(attempts, at),
							claimedUntil: null,
						});
						stats.failed += 1;
						log(
							`[webhook-registrar] create failed for ${candidate.encodingId}/${kind}`,
						);
					}
				}
			}
		}

		// ---- 3. prune --------------------------------------------------------
		const pruned = await deps.prisma.webhookRegistration.deleteMany({
			where: {
				status: "DELETED",
				deletedAt: {
					lt: new Date(at.getTime() - REGISTRATION_TOMBSTONE_TTL_MS),
				},
			},
		});
		stats.pruned = pruned.count;
		// Heartbeat pushes land in WebhookEvent (one row per interval per live
		// encoding: 4,320/day at 20 s, 86,400/day at 1 s) and had no retention
		// (rev414 R4). Bounded like the LiveHeartbeat prune: oldest first,
		// ≤ HEARTBEAT_EVENT_PRUNE_BATCH per tick, only rows past the TTL.
		const staleHeartbeats = await deps.prisma.webhookEvent.findMany({
			where: {
				eventType: "LIVE_ENCODING_HEARTBEAT",
				receivedAt: {
					lt: new Date(at.getTime() - HEARTBEAT_EVENT_RETENTION_MS),
				},
			},
			select: { id: true },
			orderBy: { receivedAt: "asc" },
			take: HEARTBEAT_EVENT_PRUNE_BATCH,
		});
		if (staleHeartbeats.length > 0) {
			const prunedEvents = await deps.prisma.webhookEvent.deleteMany({
				where: { id: { in: staleHeartbeats.map((row) => row.id) } },
			});
			stats.heartbeatEventsPruned = prunedEvents.count;
		}
		return stats;
	}

	type Candidate = {
		encodingId: string;
		bitmovinAccountId: string;
		encodingJobId: string | null;
		liveChannelRunId: string | null;
	};

	async function liveEncodings(): Promise<Candidate[]> {
		const jobs = await deps.prisma.encodingJob.findMany({
			where: {
				bitmovinEncodingId: { not: null },
				bitmovinAccountId: { not: null },
				status: { in: [...REGISTRABLE_JOB_STATUSES] },
			},
			select: { id: true, bitmovinEncodingId: true, bitmovinAccountId: true },
		});
		const runs = await deps.prisma.liveChannelRun.findMany({
			where: {
				bitmovinEncodingId: { not: null },
				status: { in: [...LIVE_RUN_LIVE_STATUSES] },
				liveChannel: { bitmovinAccountId: { not: null } },
			},
			select: {
				id: true,
				bitmovinEncodingId: true,
				liveChannel: { select: { bitmovinAccountId: true } },
			},
		});
		const out: Candidate[] = [];
		for (const job of jobs) {
			if (job.bitmovinEncodingId && job.bitmovinAccountId) {
				out.push({
					encodingId: job.bitmovinEncodingId,
					bitmovinAccountId: job.bitmovinAccountId,
					encodingJobId: job.id,
					liveChannelRunId: null,
				});
			}
		}
		for (const run of runs) {
			if (run.bitmovinEncodingId && run.liveChannel.bitmovinAccountId) {
				out.push({
					encodingId: run.bitmovinEncodingId,
					bitmovinAccountId: run.liveChannel.bitmovinAccountId,
					encodingJobId: null,
					liveChannelRunId: run.id,
				});
			}
		}
		return out;
	}

	async function completeRegistration(
		id: string,
		claimedUntil: Date,
		data: Prisma.WebhookRegistrationUpdateManyMutationInput,
	) {
		const result = await deps.prisma.webhookRegistration.updateMany({
			where: { id, claimedUntil },
			data,
		});
		if (!result.count)
			await recordResetCleanupWebhookResult(
				deps.prisma,
				deps.cipher,
				id,
				typeof data.providerWebhookId === "string"
					? data.providerWebhookId
					: null,
				claimedUntil.toISOString(),
			);
		return result;
	}

	async function upsertRow(
		candidate: Candidate,
		kind: WebhookRegistrationKind | typeof HEARTBEAT_WEBHOOK_KIND,
		data: {
			scope?: "j" | "hb";
			status?: WebhookRegistrationStatus;
			providerWebhookId?: string | null;
			url?: string | null;
			tokenHash?: string | null;
			keyId?: string | null;
			note?: string | null;
			attempts?: number;
			nextAttemptAt?: Date | null;
			claimedUntil?: Date | null;
			registeredAt?: Date | null;
			deletedAt?: Date | null;
		},
	) {
		return deps.prisma.webhookRegistration.upsert({
			where: { encodingId_kind: { encodingId: candidate.encodingId, kind } },
			create: {
				scope: data.scope ?? "j",
				encodingId: candidate.encodingId,
				kind,
				bitmovinAccountId: candidate.bitmovinAccountId,
				encodingJobId: candidate.encodingJobId,
				liveChannelRunId: candidate.liveChannelRunId,
				status: data.status ?? "SKIPPED",
				note: data.note ?? "pending",
				providerWebhookId: data.providerWebhookId ?? null,
				url: data.url ?? null,
				tokenHash: data.tokenHash ?? null,
				keyId: data.keyId ?? null,
				attempts: data.attempts ?? 0,
				nextAttemptAt: data.nextAttemptAt ?? null,
				claimedUntil: data.claimedUntil ?? null,
				registeredAt: data.registeredAt ?? null,
				deletedAt: data.deletedAt ?? null,
			},
			update: {
				bitmovinAccountId: candidate.bitmovinAccountId,
				encodingJobId: candidate.encodingJobId,
				liveChannelRunId: candidate.liveChannelRunId,
				...data,
			},
		});
	}

	/**
	 * Settings → Webhooks "re-register now" writes an AppSetting timestamp;
	 * the next tick clears every backoff so SKIPPED/FAILED rows retry at once
	 * (ACTIVE rows under a moved ingress are retired by rule 1 regardless).
	 */
	async function honourReconcileRequest(at: Date): Promise<void> {
		const row = await deps.prisma.appSetting.findUnique({
			where: { key: WEBHOOK_RECONCILE_REQUEST_KEY },
			select: { value: true },
		});
		const requested =
			typeof row?.value === "object" &&
			row.value !== null &&
			typeof (row.value as { requestedAt?: unknown }).requestedAt === "string"
				? (row.value as { requestedAt: string; handledAt?: string })
				: null;
		if (!requested || requested.handledAt === requested.requestedAt) {
			return;
		}
		// Backoffs only. A live claim (`claimedUntil`) is another worker's
		// provider call in flight and stays untouched — releasing it here once
		// orphaned a hook at Bitmovin (rev412/rev413).
		await deps.prisma.webhookRegistration.updateMany({
			where: { status: { in: ["SKIPPED", "FAILED"] } },
			data: { nextAttemptAt: null },
		});
		await deps.prisma.appSetting.update({
			where: { key: WEBHOOK_RECONCILE_REQUEST_KEY },
			data: {
				value: {
					requestedAt: requested.requestedAt,
					handledAt: requested.requestedAt,
					handledOn: at.toISOString(),
				},
			},
		});
		log(
			"[webhook-registrar] re-register requested from Settings — backoffs cleared",
		);
	}

	return { tick };
}

function retireReason(
	row: {
		encodingJobId: string | null;
		liveChannelRunId: string | null;
		encodingJob: { status: EncodingJobStatus } | null;
		liveChannelRun: { status: LiveChannelStatus } | null;
		url: string | null;
		keyId: string | null;
	},
	ingressBase: string | null,
	keyId: string,
): RetireReason | null {
	if (row.encodingJobId === null && row.liveChannelRunId === null) {
		return "orphan";
	}
	if (
		row.encodingJob &&
		(TERMINAL_JOB_STATUSES as readonly EncodingJobStatus[]).includes(
			row.encodingJob.status,
		)
	) {
		return "terminal";
	}
	if (
		row.liveChannelRun &&
		(TERMINAL_RUN_STATUSES as readonly LiveChannelStatus[]).includes(
			row.liveChannelRun.status,
		)
	) {
		return "terminal";
	}
	if (
		ingressBase !== null &&
		(row.url === null || !webhookUrlMatchesBase(row.url, ingressBase))
	) {
		return "ingressChanged";
	}
	if (row.keyId !== keyId) {
		return "keyRotated";
	}
	return null;
}
