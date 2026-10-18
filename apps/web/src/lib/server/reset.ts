import "server-only";
import {
	feederOccupancyWhere,
	verificationIntentsSealable,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { assertAisaSnapshotCaptured } from "./delete-jobs";

/**
 *  — "reset the data and start over".
 *
 * SCOPE, decided by the owner: operational data is deleted, configuration
 * survives. After a reset the deployment is ready for the next piece of work
 * without re-entering a single credential.
 *
 * Two tables are configuration whose SIBLING is state, and the split is the
 * interesting part of this list rather than an oversight:
 *   AlertRule  (kept) ↔ AlertEvent    (deleted)
 *   WatchRule  (kept) ↔ WatchedObject (deleted)
 */
export const RESET_DELETES = [
	"webhookEvent",
	"auditLog",
	"accessEvent",
	"storageInspection",
	"watchedObject",
	"alertEvent",
	"liveHeartbeat",
	// #160: measurement time-series, same family as liveHeartbeat — and its
	// liveChannelRunId pointers would dangle over the deleted runs.
	"startupSample",
	// : registrations in flight belong to the channel they were made
	// for, like schedules; the rows cascade with the channel but are counted
	// and deleted explicitly here, in the same family.
	"slateNormalization",
	"liveSchedule",
	"liveEffectClaim",
	"feederSession",
	"vmafResult",
	"vmafJob",
	"manifestJob",
	"liveChannelRun",
	"liveChannel",
	"encodingJob",
] as const;

/**
 * Evidence is neither disposable operational state nor reusable
 * configuration. In particular, EV-01 resource intents are the only durable
 * recovery index after a create response is lost. Reset must preserve the
 * run, intent and append-only event rows as one dossier; deleting the parent
 * would cascade away the exact proof needed to find and clean a paid resource.
 */
export const RESET_PRESERVES = [
	"librarySource",
	"sceneAnalysisRevision",
	"content",
	"contentRevision",
	// WP-G G-2: the per-encoding webhook registrations are the only index of
	// the hooks this app created at the PROVIDER. Their job/run keys are
	// ON DELETE SET NULL, so the reset's job/run deletes orphan them, and the
	// worker's registrar then deletes each hook at Bitmovin and tombstones
	// the row (pruned after seven days). Deleting the rows here would leave
	// those provider hooks behind with nothing that knows their ids.
	"webhookRegistration",
	// LF-01: attempt-bound provider evidence deliberately has no foreign keys so
	// it survives deletion of its operational schedule/run/session dossier.
	"feederPushAttempt",
	"verificationLiveEvidence",
	"verificationResourceIntentEvent",
	"verificationResourceIntent",
	"verificationRun",
] as const;

/** Named so a reviewer can check the complement rather than infer it. */
export const RESET_KEEPS = [
	// Legacy operational-only reset preserves configuration. Explicit selected
	// reset maps these to applicationSettings/credentials (the vault is retired).
	"vmafComputeCredential",
	"vmafExecutionProfile",
	"credential",
	"bitmovinAccount",
	"storageLocationPreset",
	"alertRule",
	"preset",
	"watchRule",
	"notificationChannel",
	"notificationRule",
	"apiToken",
	"appSetting",
	// : a copy of the PROVIDER's daily encoding statistics, keyed to a
	// kept account. Bitmovin deletes them after 90 days; the reset must not —
	// the app cannot re-read what the provider no longer has, and billing
	// history is not the operational state a reset exists to clear.
	"usageDailyStatistic",
	// … and the sweep's watermark that goes with it (rev426 R1).
	"usageSweepCursor",
] as const;

/**
 * The third category the config/state split did not have: CONFIGURATION THAT
 * IS SCOPED TO DELETED STATE (review-265 130-B1).
 *
 * `AlertRule` is kept — but a channel-scoped rule cannot outlive its channel,
 * because the FK is ON DELETE CASCADE (`schema.prisma:418`, migration
 * 20260813070000). Step 13's `liveChannel.deleteMany({})` therefore destroyed
 * every channel-scoped rule while this file promised to keep them, and the
 * counts never mentioned it.
 *
 * Deleted EXPLICITLY here rather than left to the cascade, for two reasons:
 * the operator is told (it is counted, named in the dialog and in the audit
 * row), and `SetNull` — the other way to satisfy the FK — would silently
 * PROMOTE a channel rule to a global one, which fires on every future channel.
 * Destroying a rule whose subject is gone is honest; silently rescoping it is
 * not.
 *
 * `reset-schema.test.ts` asserts no OTHER keep→delete edge exists unhandled.
 */
export const RESET_SCOPED_DELETES = [
	{
		model: "alertRule",
		scope: "channel-scoped rules (liveChannelId set); global rules survive",
		countKey: "alertRuleScoped",
		/**
		 * Runs immediately BEFORE this model — and the position is the whole
		 * point, found by running the reset against a real database
		 * .
		 *
		 * The first version ran this scoped delete before EVERYTHING, which
		 * looked safe and was not: `AlertEvent.rule` is itself ON DELETE
		 * CASCADE (`schema.prisma:442`), so deleting the rules first took their
		 * events with them, and `alertEvent.deleteMany` — nine steps later —
		 * counted 0 for a table that had just lost rows. That is the SAME
		 * dishonest count 130-B1 was about, reintroduced by 130-B1's own fix.
		 *
		 * So a scoped delete obeys the same rule as every other delete here:
		 * after its children, before its parent.
		 */
		before: "liveChannel",
	},
	// `satisfies` rather than a bare `as const`: `before` names a model in the
	// delete sequence, and the loop runs the scoped delete when it MATCHES. A
	// name that matches nothing — a typo, or a model later removed from
	// RESET_DELETES — would make the scoped delete silently never run and its
	// count silently undefined. tsc is the instrument that can see that; no
	// test can distinguish "did not run" from "ran and found nothing".
] as const satisfies ReadonlyArray<{
	model: string;
	scope: string;
	countKey: string;
	before: (typeof RESET_DELETES)[number];
}>;

/**
 * A FOURTH category, and the one that costs money if it is missing: KEPT
 * CONFIGURATION THAT WOULD ACT IMMEDIATELY ON THE WIPED WORLD (review-2 C1).
 *
 * `WatchRule` is configuration and stays. `WatchedObject` is state and goes.
 * That reads like a clean split and is a disaster: the watched-object row IS
 * the at-most-once record — `@@unique([watchRuleId, objectKey, contentId])`,
 * whose own schema comment says "a re-listed unchanged object can never
 * double-submit — DB-enforced". Delete the rows, keep the rules enabled, and
 * the 30-second sweep (a `setInterval`, so the queue drain does not touch it)
 * re-lists the bucket seconds later, finds every object new, and submits a
 * PAID encoding for each. A rule over 4,000 archived mezzanines re-encodes
 * 4,000 mezzanines, minutes after a dialog that said Bitmovin is never
 * touched.
 *
 * The repo already prices this exact effect: `watch-rules/[id]/re-arm`
 * carries the comment "this route spends money, so it refuses" and guards
 * three ways — to make ONE such row reappear. The reset makes all of them
 * reappear.
 *
 * So the rules are DISARMED in the same transaction: `enabled: false` and the
 * scan cursor cleared, counted, and named in the dialog. Not deleted — they
 * are the operator's configuration, and re-enabling is one click when they
 * actually want the next project watched.
 */
export const RESET_DISARMS = [
	{
		model: "watchRule",
		why: "re-detects and re-submits everything under its prefix once WatchedObject is gone",
		countKey: "watchRuleDisarmed",
	},
] as const satisfies ReadonlyArray<{
	model: (typeof RESET_KEEPS)[number];
	why: string;
	countKey: string;
}>;

export type ResetModel = (typeof RESET_DELETES)[number];
export type ResetScopedCountKey =
	(typeof RESET_SCOPED_DELETES)[number]["countKey"];
export type ResetDisarmCountKey = (typeof RESET_DISARMS)[number]["countKey"];
export type ResetCounts = Record<ResetModel, number> &
	Record<ResetScopedCountKey, number> &
	Record<ResetDisarmCountKey, number>;

/**
 * What is still running, and therefore what the reset refuses to delete.
 *
 * Owner's choice: the reset NEVER touches Bitmovin. Deleting the local record
 * of an encoder that is still spending money is 's incident as a
 * product decision — so the operator stops those first, and this returns the
 * list that tells them which.
 */
export type ActiveWork = {
	encodingJobs: { id: string; name: string; status: string }[];
	liveChannels: { id: string; name: string; status: string }[];
	feederSessions: {
		id: string;
		status: string;
		channelName: string;
		sourceName: string;
		createdAt: Date;
	}[];
	vmafJobs: {
		id: string;
		status: string;
		mode: "VOD" | "LIVE";
		encodingName: string | null;
		createdAt: Date;
	}[];
	/** EV-01 dossiers that cannot yet prove possibly-created == cleaned. */
	verificationIntents: VerificationIntentBlocker[];
	/** Rows whose STATUS says idle but which still name a cloud encoder. */
	unstoppedEncoders: EncoderPointer[];
	/**
	 * review-2 I6: each list above is capped at 50. Without the totals, a
	 * deployment holding 4,000 blocking rows shows fifty opaque lines and no
	 * hint that clearing them is a different size of job than it looks.
	 */
	totals: {
		encodingJobs: number;
		liveChannels: number;
		feederSessions: number;
		vmafJobs: number;
		verificationIntents: number;
		/** Exact source-row count retained for safety and audit diagnostics. */
		unstoppedEncoderPointers: number;
		/** Exact distinct Bitmovin encoding identities shown to customers. */
		unstoppedEncoders: number;
	};
};

export type VerificationIntentBlocker = {
	id: string;
	verificationRunId: string;
	verificationKey: string;
	state: string;
	cleanupState: string;
};

/** A row that is the only local record of a Bitmovin encoding resource. */
export type EncoderPointer = {
	/** Available for reset reconcile; not needed by post-reset cleanup pointers. */
	createdAt?: Date;
	liveChannelId?: string;
	liveChannelCreatedAt?: Date;
	kind: "encodingJob" | "liveChannel" | "liveChannelRun";
	id: string;
	name: string | null;
	status: string;
	bitmovinEncodingId: string;
	/**
	 * : the account that minted the encoding's TEMPORARY stream
	 * key. Captured INSIDE the transaction for the same reason everything else
	 * here is — after commit the rows are gone, and the key release runs
	 * post-commit against exactly this recorded set.
	 */
	bitmovinAccountId: string | null;
};

/** Keep the first, most useful source row for each provider encoding id. */
export function uniqueEncoderPointers<
	T extends Pick<EncoderPointer, "bitmovinEncodingId">,
>(pointers: readonly T[]): T[] {
	const byProviderId = new Map<string, T>();
	for (const pointer of pointers) {
		if (!byProviderId.has(pointer.bitmovinEncodingId)) {
			byProviderId.set(pointer.bitmovinEncodingId, pointer);
		}
	}
	return [...byProviderId.values()];
}

export const RESET_BLOCKING_JOB_STATUSES = [
	"QUEUED",
	"RUNNING",
	"AWAITING_QC",
] as const;
export const RESET_BLOCKING_CHANNEL_STATUSES = [
	"PROVISIONING",
	"RUNNING",
	"STOPPING",
] as const;
/** The enum has no STOPPING for feeders — CREATED/DOWNLOADING/PUSHING are
 *  the live set (schema.prisma:474). */
export const RESET_BLOCKING_FEEDER_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
] as const;

/**
 * Reset deletes feeder rows, so its safety population must include more than
 * active job states: a terminal held claim or unproven pid may still be the
 * only durable pointer to a publisher. Active staged holds remain blocking
 * too even though they deliberately do not occupy the publisher slot.
 */
function resetBlockingFeederWhere() {
	return {
		OR: [
			{ status: { in: [...RESET_BLOCKING_FEEDER_STATUSES] } },
			feederOccupancyWhere(),
		],
	};
}
export const RESET_BLOCKING_VMAF_STATUSES = ["PENDING", "RUNNING"] as const;

/**
 * review-265 130-B2: the four sets above ask a LOCAL question — "does this row
 * say it is running" — while the property the refusal protects is "is this row
 * the only record of a cloud resource that may still be spending money". A
 * status allowlist drifts from that; the encoder pointer does not.
 *
 * So a non-null `bitmovinEncodingId` blocks UNLESS the status is one where the
 * encoder is KNOWN to have stopped. Stated as the stopped set rather than the
 * blocking set on purpose: a status added to either enum later blocks by
 * default, and the default that costs money is the other one.
 *
 * Measured, not assumed — the pointer is nulled in exactly three places
 * (`live-processor.ts:1435`, `scheduler/sweep.ts:283`, live actions route),
 * and NONE of them is a stop: the first is CREATE_ENCODING's resume, the other
 * two are a re-air freeing the channel columns for a fresh encoding. A stopped
 * channel therefore KEEPS its pointer in normal operation, which is why
 * STOPPED is listed here as known-stopped rather than treated as suspicious —
 * blocking on the pointer alone would refuse every deployment that has ever
 * aired anything, i.e. the reset would be unusable exactly where it is needed.
 *
 * ERROR is the interesting one, and it is why this is not simply
 * "ERROR blocks": an encode that failed to COMPILE never reached
 * `startEncoding` and has a null pointer, so it does not block. An encode that
 * errored AFTER the encoder existed does. The pointer is what discriminates.
 */
/**
 * CANCELED is deliberately NOT here, and it was on the first cut.
 *
 * Cancel stops the encoding BEST-EFFORT: `stopJobEncodings`
 * (`processor.ts:706-717`) catches every failure, `console.error`s it, and the
 * job is persisted CANCELED regardless — "a stop failure is logged, never
 * fatal — we still cancel locally". Nothing about that outcome reaches the
 * database, so a CANCELED row with a pointer is exactly as unproven as an
 * ERROR one: usually stopped, sometimes a live encoder whose stop call never
 * landed. Treating it as known-stopped would have re-opened the hole B2
 * closed, one status to the left.
 *
 * The better fix is to persist the stop's outcome and read it here — deferred
 * in  rather than done in this PR, because it changes the
 * orchestrator's cancel path. Until then this refuses and the operator checks.
 */
export const RESET_STOPPED_JOB_STATUSES = ["FINISHED", "QC_FAILED"] as const;
/**
 * The channel side had the SAME trap, and it is why this constant now carries a
 * comment as long as its sibling's (review-265 130-C1).
 *
 * `STOPPED` was written unconditionally even when Bitmovin never confirmed the
 * stop, with `error` cleared to null — the failure surviving only as a
 * `console.error`, directly under a comment saying that "STOPPED" over a live
 * encoding "is the most expensive lie this system can tell". So `STOPPED`
 * alone was exactly as unproven as `CANCELED`, and this reset classified those
 * rows as safe to delete:  reached through a clean-looking row.
 *
 * Recording it as an accepted risk was the cheap answer and it was the wrong
 * one — the row COULD carry the truth, it just did not. The stop path now
 * persists the unconfirmed-stop message instead of nulling it, so **`STOPPED`
 * means stopped-and-confirmed exactly when `error` is null**, and the pointer
 * queries ask for that pair rather than for the status alone.
 *
 * Blocking on the pointer instead was measured and rejected: the pointer
 * survives every stop and is cleared only on a re-air, so that would refuse the
 * reset on any install that has ever aired. This way the only false positives
 * are stops that genuinely did not confirm — which is the population that
 * should block.
 */
export const RESET_STOPPED_CHANNEL_STATUSES = ["STOPPED"] as const;

/**
 * : a row whose encoder pointer was CONFIRMED terminal no longer
 * blocks. The stamp (`encoderStoppedConfirmedFor`) is the encoding id the
 * provider was seen to report FINISHED/ERROR/CANCELED for — written by a
 * cancel whose readback came back terminal (`processor.ts` finalizeCancel)
 * and by `reconcileEncoderPointers` below. It clears the row only while it
 * EQUALS the row's `bitmovinEncodingId`, compared column against column in
 * SQL (rev425 C1): a retry or re-air that points the row at a new encoding
 * blocks again by construction, whoever wrote the pointer.
 */
function unconfirmedFor<R>(pointer: R) {
	return {
		OR: [
			{ encoderStoppedConfirmedFor: null },
			// Prisma accepts a field reference on `equals` (not on a bare `not`).
			{ encoderStoppedConfirmedFor: { not: { equals: pointer } } },
		],
	};
}

export function pointerJobWhere(prisma: AppPrismaClient) {
	return {
		bitmovinEncodingId: { not: null },
		status: { notIn: [...RESET_STOPPED_JOB_STATUSES] },
		...unconfirmedFor(prisma.encodingJob.fields.bitmovinEncodingId),
	};
}

/** NOT (known-stopped AND the stop confirmed), and no stamp for THIS encoding. */
export function pointerChannelWhere(prisma: AppPrismaClient) {
	return {
		bitmovinEncodingId: { not: null },
		NOT: {
			status: { in: [...RESET_STOPPED_CHANNEL_STATUSES] },
			error: null,
		},
		...unconfirmedFor(prisma.liveChannel.fields.bitmovinEncodingId),
	};
}

/** A run carries the same contract as its channel, against its own column. */
export function pointerRunWhere(prisma: AppPrismaClient) {
	return {
		bitmovinEncodingId: { not: null },
		NOT: {
			status: { in: [...RESET_STOPPED_CHANNEL_STATUSES] },
			error: null,
		},
		...unconfirmedFor(prisma.liveChannelRun.fields.bitmovinEncodingId),
	};
}

/**
 * What the provider said about one encoder pointer . `stopped` is
 * TERMINAL (FINISHED/ERROR/CANCELED, via core's classifier) or CREATED — an
 * encoding that was never started has nothing to stop (rev431; a later
 * (re)start clears the stamp). QUEUED/RUNNING are `running`. Generic 404s
 * stay unverified. `missing` is reset-only evidence, subject to account
 * provenance and locked CAS below; it never changes provider lifecycle.
 */
export type ProviderEncoderState =
	| {
			kind: "missing";
			account: import("./reset-provider").ResetAccountSnapshot;
	  }
	| { kind: "stopped"; providerStatus: string }
	| { kind: "running"; providerStatus: string }
	| { kind: "unverified"; message: string };

export type EncoderStateReader = (
	bitmovinAccountId: string,
	bitmovinEncodingId: string,
) => Promise<ProviderEncoderState>;

export type ReconcileReport = {
	confirmed: EncoderPointer[];
	running: (EncoderPointer & { providerStatus: string })[];
	unverified: (EncoderPointer & { message: string })[];
};

/**
 * Every row that still names an encoder nobody confirmed terminal, with its
 * account — the LEFTOVER population: rows in an ACTIVE app status
 * (QUEUED/RUNNING/PROVISIONING/STOPPING…) are excluded because they block
 * the reset on their status alone and their worker is still writing them.
 * Unbounded and read serially: reset is rare, and a cap could hide row 51.
 */
export async function listEncoderPointers(
	prisma: AppPrismaClient,
): Promise<EncoderPointer[]> {
	const [jobs, channels, runs] = await Promise.all([
		prisma.encodingJob.findMany({
			where: {
				...pointerJobWhere(prisma),
				status: {
					notIn: [
						...RESET_STOPPED_JOB_STATUSES,
						...RESET_BLOCKING_JOB_STATUSES,
					],
				},
			},
			select: {
				id: true,
				createdAt: true,
				name: true,
				status: true,
				bitmovinEncodingId: true,
				bitmovinAccountId: true,
			},
		}),
		prisma.liveChannel.findMany({
			where: {
				...pointerChannelWhere(prisma),
				status: { notIn: [...RESET_BLOCKING_CHANNEL_STATUSES] },
			},
			select: {
				id: true,
				createdAt: true,
				name: true,
				status: true,
				bitmovinEncodingId: true,
				bitmovinAccountId: true,
			},
		}),
		prisma.liveChannelRun.findMany({
			where: {
				...pointerRunWhere(prisma),
				status: { notIn: [...RESET_BLOCKING_CHANNEL_STATUSES] },
			},
			select: {
				id: true,
				createdAt: true,
				liveChannelId: true,
				status: true,
				bitmovinEncodingId: true,
				liveChannel: { select: { bitmovinAccountId: true, createdAt: true } },
			},
		}),
	]);
	return [
		...jobs.map((r) => ({
			createdAt: r.createdAt,
			kind: "encodingJob" as const,
			id: r.id,
			name: r.name,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.bitmovinAccountId ?? null,
		})),
		...channels.map((r) => ({
			createdAt: r.createdAt,
			kind: "liveChannel" as const,
			id: r.id,
			name: r.name,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.bitmovinAccountId ?? null,
		})),
		...runs.map((r) => ({
			createdAt: r.createdAt,
			liveChannelId: r.liveChannelId,
			liveChannelCreatedAt: r.liveChannel?.createdAt,
			kind: "liveChannelRun" as const,
			id: r.id,
			name: null,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.liveChannel?.bitmovinAccountId ?? null,
		})),
	];
}

/**
 * : ask the provider about every unconfirmed encoder pointer and
 * stamp the rows whose encoding is TERMINAL — or CREATED, never started
 * (rev431) — with that encoding's id. A row whose encoding is
 * QUEUED/RUNNING is reported and left alone: that is the population the
 * refusal exists for. Failed/ambiguous reads remain unverified. Exact entity
 * absence can clear a historical pointer only under the account fence. The
 * stamp lands only on a row that STILL points at the encoding that was read
 * (a retry/re-air in between leaves it unwritten). Nothing at the provider
 * is stopped, deleted or otherwise mutated here.
 */
export async function reconcileEncoderPointers(
	prisma: AppPrismaClient,
	read: EncoderStateReader,
): Promise<ReconcileReport> {
	const pointers = await listEncoderPointers(prisma);
	const states = new Map<string, Promise<ProviderEncoderState>>();
	const report: ReconcileReport = {
		confirmed: [],
		running: [],
		unverified: [],
	};
	for (const pointer of pointers) {
		if (!pointer.bitmovinAccountId) {
			report.unverified.push({
				...pointer,
				message: "no Bitmovin account is recorded for this row",
			});
			continue;
		}
		const key = `${pointer.bitmovinAccountId}/${pointer.bitmovinEncodingId}`;
		let pending = states.get(key);
		if (!pending) {
			pending = read(pointer.bitmovinAccountId, pointer.bitmovinEncodingId);
			states.set(key, pending);
		}
		const state = await pending;
		if (state.kind === "running") {
			report.running.push({ ...pointer, providerStatus: state.providerStatus });
			continue;
		}
		if (state.kind === "unverified") {
			report.unverified.push({ ...pointer, message: state.message });
			continue;
		}
		// Resource absence is a reset-only disposition, never a terminal
		// provider status. A credential edit after this row existed is ambiguous.
		if (
			state.kind === "missing" &&
			(state.account.id !== pointer.bitmovinAccountId ||
				!pointer.createdAt ||
				!Number.isFinite(pointer.createdAt.getTime()) ||
				!Number.isFinite(state.account.updatedAt.getTime()) ||
				state.account.updatedAt.getTime() > pointer.createdAt.getTime() ||
				(pointer.kind === "liveChannelRun" &&
					(!pointer.liveChannelId ||
						!pointer.liveChannelCreatedAt ||
						!Number.isFinite(pointer.liveChannelCreatedAt.getTime()) ||
						state.account.updatedAt.getTime() >
							pointer.liveChannelCreatedAt.getTime())))
		) {
			report.unverified.push({
				...pointer,
				message:
					"The recorded account changed after this row was created; encoding absence is not verified",
			});
			continue;
		}
		const accountFence = {
			bitmovinAccountId: pointer.bitmovinAccountId,
			...(state.kind === "missing"
				? { bitmovinAccount: { is: state.account } }
				: {}),
		};
		// The stamp lands only on the row AS LISTED: same pointer AND same
		// status. A retry RESUMES the same encoding  without
		// re-pointing, so the pointer alone cannot see it — but every exit from
		// this population changes the status first (retry → QUEUED, a live
		// start → PROVISIONING), and that write also clears the stamp (rev431).
		const where = {
			id: pointer.id,
			bitmovinEncodingId: pointer.bitmovinEncodingId,
			...(state.kind === "missing" ? { createdAt: pointer.createdAt } : {}),
		};
		const data = { encoderStoppedConfirmedFor: pointer.bitmovinEncodingId };
		const stamp = async (
			db: {
				[K in "encodingJob" | "liveChannel" | "liveChannelRun"]: Pick<
					AppPrismaClient[K],
					"updateMany"
				>;
			},
		) =>
			pointer.kind === "encodingJob"
				? await db.encodingJob.updateMany({
						where: {
							...where,
							...accountFence,
							status: pointer.status as Prisma.EncodingJobWhereInput["status"],
						},
						data,
					})
				: pointer.kind === "liveChannel"
					? await db.liveChannel.updateMany({
							where: {
								...where,
								...accountFence,
								status:
									pointer.status as Prisma.LiveChannelWhereInput["status"],
							},
							data,
						})
					: await db.liveChannelRun.updateMany({
							where: {
								...where,
								liveChannel: {
									is: {
										...accountFence,
										...(state.kind === "missing"
											? { createdAt: pointer.liveChannelCreatedAt }
											: {}),
									},
								},
								...(state.kind === "missing"
									? { liveChannelId: pointer.liveChannelId }
									: {}),
								status:
									pointer.status as Prisma.LiveChannelRunWhereInput["status"],
							},
							data,
						});
		const { count } =
			state.kind === "missing"
				? await prisma
						.$transaction(async (tx) => {
							// A relation predicate alone does not lock its parent. Keep the
							// account version and run-parent binding stable through commit.
							const accounts = await tx.$queryRaw<
								{ id: string }[]
							>`SELECT id FROM "BitmovinAccount" WHERE id = ${pointer.bitmovinAccountId}::uuid FOR UPDATE`;
							if (accounts.length !== 1) return { count: 0 };
							if (pointer.kind === "liveChannelRun") {
								const channels = await tx.$queryRaw<
									{ id: string }[]
								>`SELECT id FROM "LiveChannel" WHERE id = ${pointer.liveChannelId}::uuid FOR UPDATE`;
								if (channels.length !== 1) return { count: 0 };
							}
							return stamp(tx);
						})
						.catch(() => ({ count: 0 }))
				: await stamp(prisma);
		if (count === 0) {
			report.unverified.push({
				...pointer,
				message:
					state.kind === "missing"
						? "The row or account changed, or the reset confirmation could not be saved; check again"
						: "the row was pointed at another encoding or changed state while Bitmovin was being read; check again",
			});
			continue;
		}
		report.confirmed.push(pointer);
	}
	return report;
}

export async function findActiveWork(
	prisma: AppPrismaClient,
): Promise<ActiveWork> {
	const [
		encodingJobs,
		liveChannels,
		feederRows,
		vmafRows,
		pointerJobs,
		pointerChannels,
		pointerRuns,
		pointerJobIdentities,
		pointerChannelIdentities,
		pointerRunIdentities,
		intentRows,
	] = await Promise.all([
		prisma.encodingJob.findMany({
			where: { status: { in: [...RESET_BLOCKING_JOB_STATUSES] } },
			select: { id: true, name: true, status: true },
			take: 50,
		}),
		prisma.liveChannel.findMany({
			where: { status: { in: [...RESET_BLOCKING_CHANNEL_STATUSES] } },
			select: { id: true, name: true, status: true },
			take: 50,
		}),
		prisma.feederSession.findMany({
			where: resetBlockingFeederWhere(),
			select: {
				id: true,
				status: true,
				sourceKey: true,
				createdAt: true,
				liveChannel: { select: { name: true } },
			},
			take: 50,
		}),
		prisma.vmafJob.findMany({
			where: { status: { in: [...RESET_BLOCKING_VMAF_STATUSES] } },
			select: {
				id: true,
				status: true,
				mode: true,
				createdAt: true,
				encodingJob: { select: { name: true } },
			},
			take: 50,
		}),
		// 130-B2: rows that name an encoder from a status where nothing
		// proves it stopped. `not: null` plus a NOT-in on the stopped set,
		// so a status nobody has classified yet lands here.
		prisma.encodingJob.findMany({
			where: pointerJobWhere(prisma),
			select: {
				id: true,
				name: true,
				status: true,
				bitmovinEncodingId: true,
			},
			take: 50,
		}),
		prisma.liveChannel.findMany({
			// NOT (known-stopped AND the stop confirmed). A STOPPED row that
			// still carries an error is a stop Bitmovin never confirmed, and
			// it blocks — see RESET_STOPPED_CHANNEL_STATUSES.
			where: pointerChannelWhere(prisma),
			select: {
				id: true,
				name: true,
				status: true,
				bitmovinEncodingId: true,
			},
			take: 50,
		}),
		// Runs carry their own pointer (`run-mirror.ts:136`) and outlive the
		// channel's column across re-airs, so a run is a record the channel
		// scan cannot see.
		prisma.liveChannelRun.findMany({
			// A run carries the same confirmation contract as its channel.
			where: pointerRunWhere(prisma),
			select: {
				id: true,
				status: true,
				bitmovinEncodingId: true,
				liveChannel: { select: { name: true } },
			},
			take: 50,
		}),
		// Exact provider identities are a separate, uncapped minimal projection.
		// The capped rows above remain the actionable preview and safety refusal;
		// DISTINCT here prevents the channel/run mirror from becoming two cloud
		// resources in the customer total.
		prisma.encodingJob.findMany({
			where: pointerJobWhere(prisma),
			select: { bitmovinEncodingId: true },
			distinct: ["bitmovinEncodingId"],
		}),
		prisma.liveChannel.findMany({
			where: pointerChannelWhere(prisma),
			select: { bitmovinEncodingId: true },
			distinct: ["bitmovinEncodingId"],
		}),
		prisma.liveChannelRun.findMany({
			where: pointerRunWhere(prisma),
			select: { bitmovinEncodingId: true },
			distinct: ["bitmovinEncodingId"],
		}),
		// Do not express this as `state != TERMINAL`: a forged/stale TERMINAL
		// label, mismatched exact sets, missing proof, or a bad closure digest is
		// still unresolved. Read the full seal inputs and use the SAME predicate
		// that gates a VerificationRun seal. Reset is rare; an unbounded minimal
		// projection is preferable to a capped query that can hide blocker 51.
		prisma.verificationResourceIntent.findMany({
			select: {
				id: true,
				verificationRunId: true,
				verificationKey: true,
				requestSha256: true,
				state: true,
				cleanupState: true,
				possiblyCreatedKeys: true,
				cleanedResourceKeys: true,
				providerIds: true,
				candidates: true,
				readback: true,
				closureDigest: true,
			},
		}),
	]);
	const sourceName = (sourceKey: string) => {
		const trimmed = sourceKey.endsWith("/")
			? sourceKey.slice(0, -1)
			: sourceKey;
		return trimmed.slice(trimmed.lastIndexOf("/") + 1) || sourceKey;
	};
	const feederSessions = feederRows.map((row) => ({
		id: row.id,
		status: row.status,
		channelName: row.liveChannel.name,
		sourceName: sourceName(row.sourceKey),
		createdAt: row.createdAt,
	}));
	const vmafJobs = vmafRows.map((row) => ({
		id: row.id,
		status: row.status,
		mode: row.mode,
		encodingName: row.encodingJob?.name ?? null,
		createdAt: row.createdAt,
	}));
	const unresolvedIntents = verificationIntentsSealable(intentRows).unresolved;
	const verificationIntents = unresolvedIntents.slice(0, 50).map((intent) => ({
		id: intent.id,
		verificationRunId: intent.verificationRunId,
		verificationKey: intent.verificationKey,
		state: intent.state,
		cleanupState: intent.cleanupState,
	}));
	const pointer = (
		kind: EncoderPointer["kind"],
		row: {
			id: string;
			status: string;
			bitmovinEncodingId: string | null;
			name?: string | null;
			liveChannel?: { name: string } | null;
		},
	): EncoderPointer[] =>
		row.bitmovinEncodingId
			? [
					{
						kind,
						id: row.id,
						name: row.name ?? row.liveChannel?.name ?? null,
						status: row.status,
						bitmovinEncodingId: row.bitmovinEncodingId,
						// The REFUSAL display, not the deletion record — key
						// release (#152) reads collectEncoderPointers, never this.
						bitmovinAccountId: null,
					},
				]
			: [];
	const unstoppedEncoders = [
		...pointerJobs.flatMap((r) => pointer("encodingJob", r)),
		...pointerChannels.flatMap((r) => pointer("liveChannel", r)),
		...pointerRuns.flatMap((r) => pointer("liveChannelRun", r)),
	];
	const providerIdentityIds = new Set(
		[
			...pointerJobIdentities,
			...pointerChannelIdentities,
			...pointerRunIdentities,
		].flatMap((row) =>
			row.bitmovinEncodingId ? [row.bitmovinEncodingId] : [],
		),
	);
	const [
		jobTotal,
		channelTotal,
		feederTotal,
		vmafTotal,
		pointerJobTotal,
		pointerChannelTotal,
		pointerRunTotal,
	] = await Promise.all([
		prisma.encodingJob.count({
			where: { status: { in: [...RESET_BLOCKING_JOB_STATUSES] } },
		}),
		prisma.liveChannel.count({
			where: { status: { in: [...RESET_BLOCKING_CHANNEL_STATUSES] } },
		}),
		prisma.feederSession.count({
			where: resetBlockingFeederWhere(),
		}),
		prisma.vmafJob.count({
			where: { status: { in: [...RESET_BLOCKING_VMAF_STATUSES] } },
		}),
		prisma.encodingJob.count({ where: pointerJobWhere(prisma) }),
		prisma.liveChannel.count({ where: pointerChannelWhere(prisma) }),
		prisma.liveChannelRun.count({ where: pointerRunWhere(prisma) }),
	]);
	return {
		encodingJobs,
		liveChannels,
		feederSessions,
		vmafJobs,
		verificationIntents,
		unstoppedEncoders,
		totals: {
			encodingJobs: jobTotal,
			liveChannels: channelTotal,
			feederSessions: feederTotal,
			vmafJobs: vmafTotal,
			verificationIntents: unresolvedIntents.length,
			unstoppedEncoderPointers:
				pointerJobTotal + pointerChannelTotal + pointerRunTotal,
			unstoppedEncoders: providerIdentityIds.size,
		},
	};
}

/**
 * Every encoder this deployment has a local record of, stopped or not.
 *
 * 130-B2's second half: the reset deletes `stepLog`, which is where
 * `stop-orphan-live.ts` DISCOVERS encoders — its own comment records that the
 * gap "could not find an orphan nobody had noticed", four of which billed for
 * up to 7h19m. After a reset, a stray encoder would have nothing left to
 * attribute it to. So the pointers are collected before the deletes and
 * written into the audit row, which survives because it is written after the
 * transaction. The refusal keeps live encoders from being orphaned; this keeps
 * the SUPPOSEDLY-stopped ones identifiable if that judgement was wrong.
 */
export const ENCODER_POINTER_RECORD_LIMIT = 2_000;

export async function collectEncoderPointers(
	prisma: AppPrismaClient,
	selected = { vodJobs: true, liveChannels: true },
): Promise<{
	pointers: EncoderPointer[];
	total: number;
	truncated: boolean;
	providerIdentityTotal: number;
	liveProviderIdentityTotal: number;
}> {
	// Called INSIDE the reset's transaction (review-265): this file argues two
	// functions above that the counts must come from inside it, because a
	// measurement taken before could differ from what happened — and then took
	// this one before. The audit row is the only artefact the operation leaves
	// standing, so "the recorded set may not be the set that died" is a defect
	// in the one thing left. A rule stated here and violated forty lines below
	// teaches the next reader that the paragraph is decoration.
	const [jobs, channels, runs] = await Promise.all([
		selected.vodJobs
			? prisma.encodingJob.findMany({
					where: { bitmovinEncodingId: { not: null } },
					select: {
						id: true,
						name: true,
						status: true,
						bitmovinEncodingId: true,
						bitmovinAccountId: true,
					},
				})
			: [],
		selected.liveChannels
			? prisma.liveChannel.findMany({
					where: { bitmovinEncodingId: { not: null } },
					select: {
						id: true,
						name: true,
						status: true,
						bitmovinEncodingId: true,
						bitmovinAccountId: true,
					},
				})
			: [],
		selected.liveChannels
			? prisma.liveChannelRun.findMany({
					where: { bitmovinEncodingId: { not: null } },
					// The run has no account column of its own; its channel (still
					// alive inside this transaction) does.
					select: {
						id: true,
						status: true,
						bitmovinEncodingId: true,
						liveChannel: { select: { bitmovinAccountId: true } },
					},
				})
			: [],
	]);
	const all = [
		...jobs.map((r) => ({
			kind: "encodingJob" as const,
			id: r.id,
			name: r.name,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.bitmovinAccountId ?? null,
		})),
		...channels.map((r) => ({
			kind: "liveChannel" as const,
			id: r.id,
			name: r.name,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.bitmovinAccountId ?? null,
		})),
		...runs.map((r) => ({
			kind: "liveChannelRun" as const,
			id: r.id,
			name: null,
			status: r.status,
			bitmovinEncodingId: r.bitmovinEncodingId as string,
			bitmovinAccountId: r.liveChannel?.bitmovinAccountId ?? null,
		})),
	];
	// One audit row holds this as JSON, and a long-lived install can carry
	// thousands of finished encodes. Capped — but the total and the flag ride
	// along, because a truncated list that does not SAY it is truncated reads
	// as "these are all the encoders that ever existed", which is the false
	// reassurance this field exists to avoid.
	// review-265 130-C3: RISK-FIRST before truncating. Every pointer that
	// reaches this list is, by construction, from a status the refusal
	// classified as stopped — so the residual risk is concentrated in the
	// channel/run rows (a stop is only as good as its confirmation) while the
	// job rows are provider-confirmed terminal. Slicing in query order could
	// drop every channel pointer and keep 2000 finished-job ones, which is the
	// truncation degrading adversarially. Channels and runs first, and within a
	// kind the caller's order is preserved.
	const risk = (p: EncoderPointer) => (p.kind === "encodingJob" ? 1 : 0);
	const riskOrdered = [...all].sort((a, b) => risk(a) - risk(b));
	const providerRepresentatives = uniqueEncoderPointers(riskOrdered);
	const representativeRows = new Set(providerRepresentatives);
	// Put one source row for every provider identity before mirrored references,
	// so a channel/run duplicate cannot consume the bounded audit list at the
	// expense of an otherwise-unrecorded encoding. The remaining source rows
	// still follow and retain their provenance while capacity remains.
	const ordered = [
		...providerRepresentatives,
		...riskOrdered.filter((pointer) => !representativeRows.has(pointer)),
	];
	return {
		pointers: ordered.slice(0, ENCODER_POINTER_RECORD_LIMIT),
		total: ordered.length,
		truncated: ordered.length > ENCODER_POINTER_RECORD_LIMIT,
		providerIdentityTotal: providerRepresentatives.length,
		liveProviderIdentityTotal: new Set(
			riskOrdered
				.filter((pointer) => pointer.kind !== "encodingJob")
				.map((pointer) => pointer.bitmovinEncodingId),
		).size,
	};
}

export function isIdle(active: ActiveWork): boolean {
	return (
		active.encodingJobs.length === 0 &&
		active.liveChannels.length === 0 &&
		active.feederSessions.length === 0 &&
		active.vmafJobs.length === 0 &&
		active.verificationIntents.length === 0 &&
		// 130-B2: a row that names an encoder from a not-known-stopped status
		// refuses for the SAME reason the four status lists do — this one just
		// asks about the cloud resource rather than about our own bookkeeping.
		active.unstoppedEncoders.length === 0
	);
}

/**
 * Delete the operational half, in ONE transaction, children before parents.
 *
 * The counts come from the same transaction as the deletes (deleteMany
 * returns them), so the audit row cannot disagree with what happened — a
 * count measured before the transaction could differ by anything that landed
 * in between.
 */
/** Thrown INSIDE the transaction when work started after the pre-check. */
export class ResetRaceLost extends Error {
	constructor(readonly active: ActiveWork) {
		super("work started while the reset was running");
	}
}

export type ResetOutcome = {
	counts: ResetCounts;
	/** Which watch rules were switched off — a count cannot be undone. */
	disarmed: { id: string; name: string }[];
	/** Collected in the same transaction, so it is the set that died. */
	encoders: {
		pointers: EncoderPointer[];
		total: number;
		truncated: boolean;
		providerIdentityTotal: number;
		liveProviderIdentityTotal: number;
	};
};

export async function deleteOperationalData(
	prisma: AppPrismaClient,
): Promise<ResetOutcome> {
	return prisma.$transaction(
		async (tx) => {
			// Lock in stable order, matching capture's job lock; reject before mutations.
			await tx.$queryRaw`SELECT id FROM "EncodingJob" WHERE status = 'FINISHED' ORDER BY id FOR UPDATE`;
			await assertAisaSnapshotCaptured(tx);
			// review-265 130-A1: re-assert INSIDE the transaction. The
			// pre-check ran seconds earlier, and the watch-folder sweep (a 30s
			// timer) or any submit door can create and enqueue a job in
			// between — deleting the only local record of an encoder that is
			// NOW spending money is precisely what the 409 exists to prevent.
			// Same shape as delete-jobs.ts's stillScoring guard: assert in the
			// tx, throw, let the whole thing roll back.
			const racing = await findActiveWork(tx as unknown as AppPrismaClient);
			if (!isIdle(racing)) {
				throw new ResetRaceLost(racing);
			}
			// Inside the transaction, before anything is deleted — so the
			// recorded set IS the set that dies.
			const encoders = await collectEncoderPointers(
				tx as unknown as AppPrismaClient,
			);
			const counts = {} as ResetCounts;
			// 130-B1: the scoped half of a KEPT table, deleted explicitly so
			// the number in the audit row is one this code produced rather than
			// one Postgres produced silently.
			//
			// Written out rather than looped: the WHERE clause is what makes
			// this scoped, and it is per-edge by nature. RESET_SCOPED_DELETES
			// is the declaration (the dialog and reset-schema.test.ts read it);
			// this is the one implementation it declares — including WHERE in
			// the sequence it runs, which the declaration pins as `before`.
			const [scopedAlertRules] = RESET_SCOPED_DELETES;
			const runScopedDeletes = async (beforeModel: string) => {
				if (scopedAlertRules.before !== beforeModel) {
					return;
				}
				counts[scopedAlertRules.countKey] = (
					await tx.alertRule.deleteMany({
						where: { liveChannelId: { not: null } },
					})
				).count;
			};
			for (const model of RESET_DELETES) {
				// After this model's own children, before its parent — the
				// scoped delete is subject to the same ordering rule as the
				// rest, which is what the real-database run taught.
				await runScopedDeletes(model);
				// One deleteMany per model in dependency order rather than
				// relying on cascade behaviour, which differs per relation in
				// this schema.
				const { count } = await (
					tx[model] as unknown as {
						deleteMany: (args?: unknown) => Promise<{ count: number }>;
					}
				).deleteMany({});
				counts[model] = count;
			}
			// review-2 C1: disarm before returning, INSIDE the same transaction
			// — the sweep runs every 30 seconds off a setInterval, so a window
			// between "rows deleted" and "rules disabled" is a window in which
			// it can start re-submitting.
			const [watchRules] = RESET_DISARMS;
			// review-2 N4: ENUMERATE, do not just count. `enabled` is
			// configuration that was set per rule, and the justification for
			// disarming rather than deleting is "re-enabling is one click" —
			// which only holds if the operator knows WHICH rules to click. An
			// operator who had 4 of 7 rules on deliberately would otherwise see
			// 7 disabled rules and no way back to their 4.
			const disarmed = await tx.watchRule.findMany({
				where: { enabled: true },
				select: { id: true, name: true },
			});
			counts[watchRules.countKey] = (
				await tx.watchRule.updateMany({
					where: { enabled: true },
					// disarmedByResetAt : the stamp that separates
					// "reset wiped my at-most-once memory" from a fresh rule.
					// Re-enabling a stamped rule re-detects everything under the
					// prefix; the PATCH guard makes that explicit.
					data: {
						enabled: false,
						scanCursor: null,
						disarmedByResetAt: new Date(),
					},
				})
			).count;
			return { counts, disarmed, encoders };
		},
		// Prisma's DEFAULT interactive-transaction timeout is 5 SECONDS, and
		// this deletes fourteen tables including EncodingJob's plan/stepLog/
		// snapshot JSON — the one deployment where a reset matters most (a
		// long-lived install with real history) is exactly the one that would
		// blow through it and roll back with nothing deleted. Two minutes, and
		// maxWait raised so a busy pool does not fail before it starts.
		{
			timeout: 120_000,
			maxWait: 10_000,
			// review-2 I3: the in-transaction re-assert takes a fresh snapshot
			// and no row locks, so under the Postgres default (READ COMMITTED)
			// a job committed after that SELECT and before encodingJob's
			// deleteMany — thirteen tables later — is invisible to the guard
			// and deleted anyway. That is exactly the outcome 130-A1 exists to
			// prevent, and the guard's comment read as though it were closed.
			// Serializable makes the database refuse the commit instead; the
			// route maps P2034 to the same 409.
			isolationLevel: "Serializable",
		},
	);
}
