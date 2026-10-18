import { z } from "zod";
import type { LiveToVodFamilySupport } from "./vod-manifest-target";

/**
 * The live-to-VOD record — `LiveChannel.liveToVod` / `LiveChannelRun.liveToVod`
 * (our own workflow state; no Bitmovin resource mirrors it).
 *
 * **Why it is per FAMILY .**
 * The record used to be one status over a list of finished manifests, written
 * by a loop that generated the families in sequence and turned the FIRST
 * failure into a whole-record ERROR. On a TS-only channel the default asked
 * for HLS *and* DASH; the HLS manifest was generated, the DASH create came
 * back `400 / code 2700` (a DASH default manifest enumerates fMP4 muxings
 * only), and the record said ERROR with `manifests: []` — a delivered HLS
 * asset reported as nothing (measured on the paid run of 2026-08-30).
 *
 * Two invariants replace that:
 *
 *  1. the DEFAULT family set is "every family compatible with the recorded
 *     muxings" (`liveToVodFamilySupport`), never "both";
 *  2. one family's failure never erases another family's success — each
 *     family carries its own status, manifest id, url and error, and the
 *     record's overall status is DERIVED from them (`deriveLiveToVodStatus`).
 *
 * `manifests[]` survives as the projection of the FINISHED families: it is
 * what every existing reader — the channel page, the harness, the retry
 * filename rule (`priorRollManifestFiles`) — already consumes.
 *
 * **Legacy records** (written before this shape: no `families`) retain that
 * absence marker on read and are otherwise left as they are — an old ERROR
 * record whose `manifests[]` happens to be non-empty is NOT promoted to
 * FINISHED or PARTIAL by inference (§14.6 LF-02 item 6). Preserving absence
 * also lets downstream verification distinguish compatibility from a new,
 * invalid empty-family record.
 */

export const LIVE_TO_VOD_FAMILIES = ["HLS", "DASH"] as const;
export const liveToVodFamilySchema = z.enum(LIVE_TO_VOD_FAMILIES);
export type LiveToVodFamily = z.infer<typeof liveToVodFamilySchema>;

/**
 * Per-family lifecycle. `CREATED` is persisted the moment the provider
 * answers the create — BEFORE start/poll — so a crash or lost response after
 * that point leaves an id a retry can read back rather than a manifest nobody
 * remembers (§14.6 LF-02 item 4). `SKIPPED_UNSUPPORTED` names a family the
 * DEFAULT left out because the recording cannot carry it (TS → no DASH), so
 * the record explains its own shape.
 */
export const LIVE_TO_VOD_FAMILY_STATUSES = [
	"PENDING",
	"CREATED",
	"RUNNING",
	"FINISHED",
	"ERROR",
	"SKIPPED_UNSUPPORTED",
] as const;
export const liveToVodFamilyStatusSchema = z.enum(LIVE_TO_VOD_FAMILY_STATUSES);
export type LiveToVodFamilyStatus = z.infer<typeof liveToVodFamilyStatusSchema>;

export const LIVE_TO_VOD_ERROR_CODES = [
	"L2V_ENQUEUE_FAILED",
	"L2V_QUEUE_STATE_UNKNOWN",
	"L2V_PROVIDER_LOOKUP_FAILED",
	"L2V_PROVIDER_LOOKUP_AMBIGUOUS",
	"L2V_PROVIDER_CREATE_FAILED",
	"L2V_PROVIDER_START_FAILED",
	"L2V_PROVIDER_STATUS_FAILED",
	"L2V_PROVIDER_DELETE_UNCONFIRMED",
	"L2V_PERSIST_FAILED",
	"L2V_JOB_DIED",
	"L2V_RECORD_INVALID",
] as const;
export const liveToVodErrorCodeSchema = z.enum(LIVE_TO_VOD_ERROR_CODES);
export type LiveToVodErrorCode = z.infer<typeof liveToVodErrorCodeSchema>;

export const LIVE_TO_VOD_REASON_CODES = ["L2V_UNSUPPORTED_FAMILY"] as const;
export const liveToVodReasonCodeSchema = z.enum(LIVE_TO_VOD_REASON_CODES);
export type LiveToVodReasonCode = z.infer<typeof liveToVodReasonCodeSchema>;

/**
 * Exact provider create identity. It is persisted before a POST is allowed.
 * A resume may look up only this tuple; a list error or more than one match is
 * ambiguity, never permission to create another billable resource.
 */
export const liveToVodProviderIdentitySchema = z
	.object({
		attemptId: z.string().min(1),
		encodingId: z.string().min(1),
		outputId: z.string().min(1),
		outputPath: z.string(),
		manifestName: z.string().min(1),
	})
	.strict();
export type LiveToVodProviderIdentity = z.infer<
	typeof liveToVodProviderIdentitySchema
>;

export const liveToVodCreateIntentSchema = z
	.object({
		ownerToken: z.string().min(1),
		status: z.enum(["CREATE_PENDING", "LOOKUP_UNKNOWN"]),
		requestedAt: z.string().min(1),
		errorCode: liveToVodErrorCodeSchema.optional(),
		technicalDetail: z.string().optional(),
	})
	.strict();
export type LiveToVodCreateIntent = z.infer<typeof liveToVodCreateIntentSchema>;

const liveToVodCleanupBase = z.object({
	providerId: z.string().min(1),
	requestedAt: z.string().min(1),
	errorCode: liveToVodErrorCodeSchema.optional(),
	technicalDetail: z.string().optional(),
});

export const liveToVodCleanupSchema = z.discriminatedUnion("status", [
	liveToVodCleanupBase
		.extend({
			status: z.literal("DELETE_PENDING"),
		})
		.strict(),
	liveToVodCleanupBase
		.extend({
			status: z.literal("DELETE_CONFIRMED"),
			confirmedAt: z.string().min(1),
		})
		.strict(),
]);
export type LiveToVodCleanup = z.infer<typeof liveToVodCleanupSchema>;

const liveToVodFamilyBaseSchema = z.object({
	type: liveToVodFamilySchema,
});

/**
 * Status-discriminated family state. Provider claims cannot be inferred from
 * loose optional fields: CREATED/RUNNING require both the exact create
 * identity and provider id, FINISHED additionally requires the delivered URL,
 * and SKIPPED requires a stable reason code. Invalid historical combinations
 * are downgraded by `normalizeLiveToVodRecord`, never promoted.
 */
export const liveToVodFamilyRecordSchema = z
	.discriminatedUnion("status", [
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("PENDING"),
				providerIdentity: liveToVodProviderIdentitySchema.optional(),
				createIntent: liveToVodCreateIntentSchema.optional(),
			})
			.strict(),
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("CREATED"),
				providerIdentity: liveToVodProviderIdentitySchema,
				manifestId: z.string().min(1),
			})
			.strict(),
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("RUNNING"),
				providerIdentity: liveToVodProviderIdentitySchema,
				manifestId: z.string().min(1),
			})
			.strict(),
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("FINISHED"),
				providerIdentity: liveToVodProviderIdentitySchema,
				manifestId: z.string().min(1),
				url: z.string().min(1),
			})
			.strict(),
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("ERROR"),
				errorCode: liveToVodErrorCodeSchema,
				technicalDetail: z.string().optional(),
				/** @deprecated read as technicalDetail; retained for historical JSON. */
				error: z.string().optional(),
				providerIdentity: liveToVodProviderIdentitySchema.optional(),
				createIntent: liveToVodCreateIntentSchema.optional(),
				manifestId: z.string().min(1).optional(),
				url: z.string().min(1).optional(),
				cleanup: liveToVodCleanupSchema.optional(),
			})
			.strict(),
		liveToVodFamilyBaseSchema
			.extend({
				status: z.literal("SKIPPED_UNSUPPORTED"),
				reasonCode: liveToVodReasonCodeSchema,
				technicalDetail: z.string().optional(),
				/** @deprecated read as technicalDetail; retained for historical JSON. */
				reason: z.string().optional(),
			})
			.strict(),
	])
	.superRefine((family, ctx) => {
		if (
			family.status === "PENDING" &&
			Boolean(family.providerIdentity) !== Boolean(family.createIntent)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"PENDING providerIdentity and createIntent must be persisted together",
			});
		}
		if (
			family.status === "ERROR" &&
			family.createIntent !== undefined &&
			family.providerIdentity === undefined
		) {
			ctx.addIssue({
				code: "custom",
				message: "ERROR createIntent requires its exact providerIdentity",
			});
		}
		if (
			family.status === "ERROR" &&
			family.cleanup !== undefined &&
			(family.providerIdentity === undefined ||
				family.manifestId === undefined ||
				family.cleanup.providerId !== family.manifestId)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"ERROR cleanup requires the same exact providerIdentity and manifestId",
			});
		}
	});
export type LiveToVodFamilyRecord = z.infer<typeof liveToVodFamilyRecordSchema>;

export const LIVE_TO_VOD_STATUSES = [
	"RUNNING",
	"FINISHED",
	"PARTIAL",
	"ERROR",
] as const;
export const liveToVodStatusSchema = z.enum(LIVE_TO_VOD_STATUSES);
export type LiveToVodStatus = z.infer<typeof liveToVodStatusSchema>;

export const liveToVodManifestSchema = z
	.object({
		type: liveToVodFamilySchema,
		manifestId: z.string().min(1),
		url: z.string().min(1),
	})
	.strict();
export type LiveToVodManifest = z.infer<typeof liveToVodManifestSchema>;

export type LiveToVodRecord = {
	status: LiveToVodStatus;
	/** One route claim, queue job and worker lifecycle share this identity. */
	attemptId?: string;
	/** Same-attempt CAS; every atomic channel+run write increments it. */
	revision?: number;
	queueJobId?: string;
	/** Exact run row archived by this attempt; never "latest run" at write time. */
	liveChannelRunId?: string;
	/**
	 * Time the route claimed this exact attempt. Optional only for historical
	 * records; worker progress and dead-job release preserve the claimed value.
	 */
	requestedAt?: string;
	finishedAt?: string;
	outputId?: string;
	outputKey?: string;
	path?: string;
	/** Per-family state; absent on a legacy record and kept absent on read. */
	families?: LiveToVodFamilyRecord[];
	/**
	 * Exact terminal identities from earlier rolls of this same channel run.
	 * The route claim replaces both channel and run mirrors atomically, so this
	 * history is what keeps a later roll from reusing/adopting their filenames.
	 */
	priorManifests?: LiveToVodManifest[];
	/** The FINISHED families' manifests — the projection every reader consumes. */
	manifests: LiveToVodManifest[];
	errorCode?: LiveToVodErrorCode;
	/** Redacted diagnostics. Customer UI must localize errorCode instead. */
	technicalDetail?: string;
	/** @deprecated historical alias for technicalDetail. */
	error?: string;
};

const LIVE_TO_VOD_STATUS_SET = new Set<string>(LIVE_TO_VOD_STATUSES);

/**
 * Downgrade a malformed known family without erasing the provider artefact
 * needed for manual or retry reconciliation. Nothing here can become a
 * FINISHED projection: the result is always ERROR/L2V_RECORD_INVALID.
 */
function invalidLiveToVodFamily(
	raw: Record<string, unknown>,
	type: LiveToVodFamily,
): LiveToVodFamilyRecord {
	const providerIdentity = liveToVodProviderIdentitySchema.safeParse(
		raw.providerIdentity,
	);
	const createIntent = liveToVodCreateIntentSchema.safeParse(raw.createIntent);
	const rawCleanup =
		typeof raw.cleanup === "object" && raw.cleanup !== null
			? (raw.cleanup as Record<string, unknown>)
			: undefined;
	const manifestId =
		typeof raw.manifestId === "string" && raw.manifestId.length > 0
			? raw.manifestId
			: typeof rawCleanup?.providerId === "string" &&
					rawCleanup.providerId.length > 0
				? rawCleanup.providerId
				: undefined;
	const parsedCleanup = liveToVodCleanupSchema.safeParse(raw.cleanup);
	let cleanup: LiveToVodCleanup | undefined;
	if (
		providerIdentity.success &&
		manifestId !== undefined &&
		parsedCleanup.success &&
		parsedCleanup.data.providerId === manifestId
	) {
		cleanup = parsedCleanup.data;
	} else if (
		providerIdentity.success &&
		manifestId !== undefined &&
		rawCleanup?.status === "DELETE_CONFIRMED" &&
		rawCleanup.providerId === manifestId &&
		typeof rawCleanup.requestedAt === "string" &&
		rawCleanup.requestedAt.length > 0
	) {
		// A claimed confirmation without its readback timestamp is unresolved,
		// never cleaned. Retrying the exact id is safe even if it is already gone.
		const cleanupError = liveToVodErrorCodeSchema.safeParse(
			rawCleanup.errorCode,
		);
		cleanup = {
			providerId: manifestId,
			status: "DELETE_PENDING",
			requestedAt: rawCleanup.requestedAt,
			...(cleanupError.success ? { errorCode: cleanupError.data } : {}),
			...(typeof rawCleanup.technicalDetail === "string"
				? { technicalDetail: rawCleanup.technicalDetail }
				: {}),
		};
	}
	const technicalDetail =
		typeof raw.technicalDetail === "string"
			? raw.technicalDetail
			: typeof raw.error === "string"
				? raw.error
				: undefined;
	return {
		type,
		status: "ERROR",
		errorCode: "L2V_RECORD_INVALID",
		...(technicalDetail ? { technicalDetail } : {}),
		...(providerIdentity.success
			? { providerIdentity: providerIdentity.data }
			: {}),
		...(providerIdentity.success && createIntent.success
			? { createIntent: createIntent.data }
			: {}),
		...(manifestId ? { manifestId } : {}),
		...(typeof raw.url === "string" && raw.url.length > 0
			? { url: raw.url }
			: {}),
		...(cleanup ? { cleanup } : {}),
	};
}

/**
 * Boundary normaliser for the wire/DB value. The column's REAL population is
 * wider than the type: one production row carried a bare `{}` (writer
 * unknown), and `record.manifests.length` took the whole channel-detail page
 * down with it (2026-08-22 real-browser pass). A record without a `status`
 * the union knows is no record. Only a record where `families` is ABSENT gets
 * legacy manifest compatibility. Once `families` exists, any invalid, unknown
 * or duplicate entry invalidates the record and the visible `manifests` are
 * re-projected exclusively from valid FINISHED families; silently dropping a
 * `[null]` or an impossible status shape would preserve a false raw FINISHED.
 */
export function normalizeLiveToVodRecord(raw: unknown): LiveToVodRecord | null {
	if (raw === null || typeof raw !== "object") {
		return null;
	}
	const record = raw as Record<string, unknown>;
	if (
		typeof record.status !== "string" ||
		!LIVE_TO_VOD_STATUS_SET.has(record.status)
	) {
		return null;
	}
	const legacyManifests: LiveToVodManifest[] = [];
	if (Array.isArray(record.manifests)) {
		for (const entry of record.manifests) {
			const parsed = liveToVodManifestSchema.safeParse(entry);
			if (parsed.success) {
				legacyManifests.push(parsed.data);
			}
		}
	}
	const priorManifestsPresent = Object.hasOwn(record, "priorManifests");
	let invalidPriorManifests =
		priorManifestsPresent && !Array.isArray(record.priorManifests);
	const priorManifests: LiveToVodManifest[] = [];
	if (Array.isArray(record.priorManifests)) {
		const seen = new Set<string>();
		for (const entry of record.priorManifests) {
			const parsed = liveToVodManifestSchema.safeParse(entry);
			if (!parsed.success) {
				invalidPriorManifests = true;
				continue;
			}
			const identity = `${parsed.data.type}\0${parsed.data.manifestId}\0${parsed.data.url}`;
			if (seen.has(identity)) {
				continue;
			}
			seen.add(identity);
			priorManifests.push(parsed.data);
		}
	}
	const familiesPresent = Object.hasOwn(record, "families");
	let invalidFamilyShape = familiesPresent && !Array.isArray(record.families);
	const families: LiveToVodFamilyRecord[] = [];
	if (Array.isArray(record.families)) {
		for (const entry of record.families) {
			const parsed = liveToVodFamilyRecordSchema.safeParse(entry);
			const rawType =
				typeof entry === "object" && entry !== null
					? liveToVodFamilySchema.safeParse(
							(entry as Record<string, unknown>).type,
						)
					: undefined;
			const family = parsed.success
				? parsed.data
				: rawType?.success && typeof entry === "object" && entry !== null
					? invalidLiveToVodFamily(
							entry as Record<string, unknown>,
							rawType.data,
						)
					: undefined;
			if (!parsed.success) {
				invalidFamilyShape = true;
			}
			if (!family) {
				continue;
			}
			if (families.some((f) => f.type === family.type)) {
				invalidFamilyShape = true;
				continue;
			}
			families.push(family);
		}
	}
	const text = (key: string): string | undefined =>
		typeof record[key] === "string" ? (record[key] as string) : undefined;
	const revision =
		typeof record.revision === "number" &&
		Number.isInteger(record.revision) &&
		record.revision >= 0
			? record.revision
			: undefined;
	invalidFamilyShape ||= families.some(
		(family) =>
			"errorCode" in family && family.errorCode === "L2V_RECORD_INVALID",
	);
	// A raw RUNNING value is the durable queue claim, not a family outcome.
	// Retried families may all still be terminal at the instant the route has
	// fenced the new attempt but the worker has not reset/reconciled one yet.
	// Treat that record as active only when every coordinate needed to identify
	// the exact DB claim and deterministic queue job is present. Otherwise a
	// stale/malformed RUNNING row could be mistaken for permission to create.
	const exactActiveClaim =
		record.status === "RUNNING" &&
		(text("attemptId")?.length ?? 0) > 0 &&
		(text("queueJobId")?.length ?? 0) > 0 &&
		(text("liveChannelRunId")?.length ?? 0) > 0 &&
		revision !== undefined &&
		!Object.hasOwn(record, "finishedAt");
	const invalidActiveClaim =
		familiesPresent && record.status === "RUNNING" && !exactActiveClaim;
	const familyStatus = familiesPresent
		? deriveLiveToVodStatus(families)
		: undefined;
	const invalidEmptyFamilySet = familiesPresent && families.length === 0;
	// Once an identified claim is settled, the stored overall verdict and the
	// family projection must agree. A contradictory raw ERROR must never be
	// promoted to FINISHED merely because its family fields look successful.
	const invalidTerminalStatus =
		familiesPresent &&
		record.status !== "RUNNING" &&
		record.status !== familyStatus;
	const invalidRecordShape =
		invalidFamilyShape ||
		invalidPriorManifests ||
		invalidActiveClaim ||
		invalidEmptyFamilySet ||
		invalidTerminalStatus;
	const normalizedStatus = invalidRecordShape
		? "ERROR"
		: exactActiveClaim
			? "RUNNING"
			: familiesPresent
				? (familyStatus as LiveToVodStatus)
				: (record.status as LiveToVodStatus);
	const manifests = familiesPresent
		? liveToVodManifestsOf(families)
		: legacyManifests;
	return {
		status: normalizedStatus,
		...(text("attemptId") !== undefined
			? { attemptId: text("attemptId") }
			: {}),
		...(revision !== undefined ? { revision } : {}),
		...(text("queueJobId") !== undefined
			? { queueJobId: text("queueJobId") }
			: {}),
		...(text("liveChannelRunId") !== undefined
			? { liveChannelRunId: text("liveChannelRunId") }
			: {}),
		...(text("requestedAt") !== undefined
			? { requestedAt: text("requestedAt") }
			: {}),
		...(text("finishedAt") !== undefined
			? { finishedAt: text("finishedAt") }
			: {}),
		...(text("outputId") !== undefined ? { outputId: text("outputId") } : {}),
		...(text("outputKey") !== undefined
			? { outputKey: text("outputKey") }
			: {}),
		...(text("path") !== undefined ? { path: text("path") } : {}),
		...(invalidRecordShape
			? { errorCode: "L2V_RECORD_INVALID" as const }
			: liveToVodErrorCodeSchema.safeParse(record.errorCode).success
				? { errorCode: record.errorCode as LiveToVodErrorCode }
				: {}),
		...(text("technicalDetail") !== undefined
			? { technicalDetail: text("technicalDetail") }
			: text("error") !== undefined
				? { technicalDetail: text("error") }
				: {}),
		...(text("error") !== undefined ? { error: text("error") } : {}),
		...(familiesPresent ? { families } : {}),
		...(priorManifestsPresent ? { priorManifests } : {}),
		manifests,
	};
}

/**
 * The record's overall status, DERIVED from its families — never stored
 * independently of them, so a family cannot fail without the record saying
 * so and a family cannot finish without the record keeping it.
 *
 * `SKIPPED_UNSUPPORTED` is not an outcome, so it is ignored. Any family still
 * in flight ⇒ RUNNING. Otherwise: every family FINISHED ⇒ FINISHED; some
 * FINISHED and some ERROR ⇒ PARTIAL; nothing FINISHED ⇒ ERROR (which is also
 * the answer for an empty set — a roll that generated nothing did not
 * succeed).
 */
export function deriveLiveToVodStatus(
	families: readonly LiveToVodFamilyRecord[],
): LiveToVodStatus {
	const outcomes = families.filter((f) => f.status !== "SKIPPED_UNSUPPORTED");
	if (
		outcomes.some(
			(f) =>
				f.status === "PENDING" ||
				f.status === "CREATED" ||
				f.status === "RUNNING",
		)
	) {
		return "RUNNING";
	}
	const finished = outcomes.filter((f) => f.status === "FINISHED").length;
	const failed = outcomes.filter((f) => f.status === "ERROR").length;
	if (finished > 0 && failed === 0) {
		return "FINISHED";
	}
	if (finished > 0) {
		return "PARTIAL";
	}
	return "ERROR";
}

/** The FINISHED families' manifests — `manifests[]` as every reader expects it. */
export function liveToVodManifestsOf(
	families: readonly LiveToVodFamilyRecord[],
): LiveToVodManifest[] {
	const manifests: LiveToVodManifest[] = [];
	for (const family of families) {
		if (
			family.status === "FINISHED" &&
			family.manifestId !== undefined &&
			family.url !== undefined
		) {
			manifests.push({
				type: family.type,
				manifestId: family.manifestId,
				url: family.url,
			});
		}
	}
	return manifests;
}

/**
 * Is `existing` a record a RETRY may continue from? A terminal record with
 * per-family state whose failed families can be re-run without touching the
 * finished ones. A RUNNING record is not (the route 409s it), a FINISHED one
 * is not (a roll over a finished roll is a NEW roll — review-357's filename
 * rule keeps them apart), and a legacy record has nothing per-family to
 * continue from (§14.6 LF-02 item 6: no inference over an old ERROR).
 */
export function isRetryableLiveToVod(
	existing: LiveToVodRecord | null,
): existing is LiveToVodRecord & { families: LiveToVodFamilyRecord[] } {
	return (
		existing !== null &&
		(existing.status === "PARTIAL" || existing.status === "ERROR") &&
		(existing.families?.length ?? 0) > 0
	);
}

/**
 * The family entries a roll starts from, given what the operator asked for
 * and what the recording supports.
 *
 * `requested` is the explicit list or the supported default; `explicit` says
 * which. `carried` are the families of a retryable prior record at the SAME
 * destination (the worker decides that — the route only carries them). The
 * rules, in order, per family (HLS then DASH — the order the loop runs in):
 *
 *  - a carried FINISHED family is kept VERBATIM whether requested or not — a
 *    success is never erased by a later roll (§14.6 LF-02 item 5);
 *  - a carried family with a manifest id is kept verbatim: the worker reads
 *    that id back before deciding to adopt, reuse or clean it up, and never
 *    creates a second manifest before that decision (item 4);
 *  - a carried family with no id that is requested again restarts PENDING;
 *    one that is not requested keeps its recorded history;
 *  - an uncarried requested family starts PENDING;
 *  - on a DEFAULT request, an unsupported family is recorded
 *    SKIPPED_UNSUPPORTED with the reason, so the record explains why a
 *    TS-only roll has no DASH; on an explicit request it is simply absent.
 */
export function liveToVodFamilyPlan(args: {
	requested: readonly LiveToVodFamily[];
	explicit: boolean;
	support: LiveToVodFamilySupport;
	carried: readonly LiveToVodFamilyRecord[];
}): LiveToVodFamilyRecord[] {
	const plan: LiveToVodFamilyRecord[] = [];
	for (const type of LIVE_TO_VOD_FAMILIES) {
		const prior = args.carried.find((f) => f.type === type);
		const wanted = args.requested.includes(type);
		if (prior) {
			if (
				wanted &&
				prior.status === "ERROR" &&
				prior.providerIdentity &&
				prior.createIntent &&
				prior.cleanup?.status !== "DELETE_PENDING"
			) {
				plan.push({
					type,
					status: "PENDING",
					providerIdentity: prior.providerIdentity,
					createIntent: prior.createIntent,
				});
				continue;
			}
			if (
				wanted &&
				prior.status !== "FINISHED" &&
				!("manifestId" in prior && prior.manifestId !== undefined)
			) {
				plan.push({ type, status: "PENDING" });
			} else {
				plan.push({ ...prior });
			}
			continue;
		}
		if (wanted) {
			plan.push({ type, status: "PENDING" });
			continue;
		}
		const skipped = args.support.unsupported.find((u) => u.family === type);
		if (!args.explicit && skipped) {
			plan.push({
				type,
				status: "SKIPPED_UNSUPPORTED",
				reasonCode: "L2V_UNSUPPORTED_FAMILY",
				reason: skipped.reason,
				technicalDetail: skipped.reason,
			});
		}
	}
	return plan;
}

/**
 * The record the route CLAIMS before enqueueing (and the dead-job release
 * cannot build, having no prior read). A fresh roll claims RUNNING with the
 * planned families PENDING; a retry over a PARTIAL/ERROR record carries that
 * record's families, output and path forward so the worker can continue only
 * the failed ones — the worker still verifies the destination matches before
 * treating them as its own.
 */
export function liveToVodClaim(args: {
	existing: LiveToVodRecord | null;
	requested: readonly LiveToVodFamily[];
	explicit: boolean;
	support: LiveToVodFamilySupport;
	requestedAt: string;
	attemptId?: string;
	queueJobId?: string;
	liveChannelRunId?: string;
	outputKey?: string;
}): LiveToVodRecord {
	const retry = isRetryableLiveToVod(args.existing) ? args.existing : null;
	const priorByIdentity = new Map<string, LiveToVodManifest>();
	for (const manifest of [
		...(args.existing?.priorManifests ?? []),
		// Keep current FINISHED identities even on a same-destination retry.
		// They remain current there (the duplicate is harmless), and become true
		// history if the worker discovers this request was re-targeted and resets
		// the family plan before its first replacement create.
		...(args.existing?.manifests ?? []),
	]) {
		priorByIdentity.set(
			`${manifest.type}\0${manifest.manifestId}\0${manifest.url}`,
			manifest,
		);
	}
	const priorManifests = [...priorByIdentity.values()];
	const families = liveToVodFamilyPlan({
		requested: args.requested,
		explicit: args.explicit,
		support: args.support,
		carried: retry?.families ?? [],
	});
	return {
		status: "RUNNING",
		requestedAt: args.requestedAt,
		...(args.attemptId !== undefined ? { attemptId: args.attemptId } : {}),
		...(args.attemptId !== undefined ? { revision: 0 } : {}),
		...(args.queueJobId !== undefined ? { queueJobId: args.queueJobId } : {}),
		...(args.liveChannelRunId !== undefined
			? { liveChannelRunId: args.liveChannelRunId }
			: {}),
		...(args.outputKey !== undefined ? { outputKey: args.outputKey } : {}),
		...(retry?.outputId !== undefined ? { outputId: retry.outputId } : {}),
		...(retry?.path !== undefined ? { path: retry.path } : {}),
		...(priorManifests.length > 0 ? { priorManifests } : {}),
		families,
		manifests: liveToVodManifestsOf(families),
	};
}
