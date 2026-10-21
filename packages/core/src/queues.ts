import { z } from "zod";
import { productEventSchema } from "./events/schema";
import {
	sealedFeederSourceSchema,
	slateSourceSchema,
} from "./live/program-schedule";

/**
 * BullMQ queue names shared by apps/web (producers) and apps/worker
 * (consumers). See ARCHITECTURE §1: orchestrator executes compiled
 * EncodingPlans, live-channel provisions/acts on live channels,
 * vmaf-runner computes libvmaf reports, feeder-manager supervises
 * pseudo-live ffmpeg loops.
 */
export const QUEUE_NAMES = {
	usageStatistics: "usage-statistics",
	orchestrator: "encoding-orchestrator",
	liveChannel: "live-channel-lifecycle",
	vmafRunner: "vmaf-runner",
	feederManager: "feeder-manager",
	/**
	 * Storage object inspection (P5): ffprobe over one object in a customer
	 * bucket. It rides a queue rather than a route because ffprobe lives in the
	 * WORKER image, and the read is bounded (capped head + optional tail).
	 */
	storageInspect: "storage-inspect",
	/**
	 * Outbound notification delivery : one job per emitted
	 * product event; the consumer fans out to matching channels. Best-effort
	 * from the emit side — a notify failure never fails the job that emitted.
	 */
	notify: "notify-dispatch",
	/**
	 * Startup-probe batches : one job per operator-confirmed
	 * batch; the processor runs probes SERIALLY per region (parallel probes
	 * would measure queue contention we caused ourselves — design §4) and is
	 * resumable by construction (per-probe channels are the progress record).
	 */
	startupProbe: "startup-probe",
	/**
	 * Slate normalization + registration : one job per
	 * `SlateNormalization` row. Rides its own queue because it downloads a
	 * customer object, runs ffmpeg (worker image only) and uploads the result
	 * before it touches the provider — minutes, not the live-channel queue's
	 * seconds — and because a WAITING_FOR_INPUT row is re-queued by this
	 * queue's own repeatable promoter once the ingest reference exists.
	 */
	slateNormalize: "slate-normalize",
} as const;

export type QueueKey = keyof typeof QUEUE_NAMES;
export type QueueName = (typeof QUEUE_NAMES)[QueueKey];

export const orchestratorJobSchema = z.object({
	encodingJobId: z.uuid(),
});
export type OrchestratorJob = z.infer<typeof orchestratorJobSchema>;

/**
 * Live channel queue payloads. "provision" replays the compiled step log
 * on CREATED|PROVISIONING rows (the start action claims ERROR →
 * PROVISIONING first; stale jobs on any other status skip); the rest are
 * direct API actions on the persisted channel (STOP/restart are NOT
 * compiled steps — COVERAGE P3 batch 1 contract). Per-action params are
 * validated again by the worker with the schemas below (the queue payload
 * crosses processes).
 */
export const liveChannelActionSchema = z.enum([
	"provision",
	"stop",
	"restart",
	"reset-timeshift",
	"update-rtmp-ingest",
	"update-auto-shutdown",
	"scte35",
	"heartbeat",
	// live-to-VOD: create + start + await DEFAULT manifests over the stopped
	// channel's own encoding, with manifestGenerator LEGACY (C3's documented
	// exception). Long-running like provision, so it rides the queue rather
	// than a route.
	"live-to-vod",
	// Scheduled slate insertion : the scheduler sweep
	// fires SLATE_IN rows through this action so the sweep never touches
	// Bitmovin directly — same principle as provision/stop.
	"insert-content",
	// Deferred slate-content registration : a creation-time
	// SLATE_IN row carries a SOURCE, not a content id — insertable content
	// is per-encoding and the encoding does not exist yet. Once the channel
	// is RUNNING the sweep claims the row (contentClaimedAt CAS) and fires
	// this action; the processor creates the input from the vaulted
	// credential, registers the content, polls it READY, and only then
	// writes insertableContentId — so the fire path's "no content id yet ⇒
	// wait" gate doubles as the READY gate.
	"register-slate-content",
	//  — the feeder-chain rows: a scheduled FEEDER_START fires
	// this; the processor creates the FeederSession and hands it to the
	// feeder-manager queue.
	"feeder-start",
	//  — the switch is TWO-PHASE (audit 2026-08-29 HIGH-3). The
	// sweep fires `feeder-stage` at fireAt − lead: the processor creates the
	// session with its commit instant and the feeder worker downloads,
	// probes and gates the sealed source, then HOLDS it (READY, no ffmpeg).
	// At fireAt the sweep fires `feeder-commit` for a READY session only —
	// the feeder worker then stops every predecessor, waits until each is
	// proven gone, and spawns. `feeder-switch` remains for the immediate
	// (lead 0) form and for jobs already queued under the old single-phase
	// name: it stages with the commit pre-requested.
	"feeder-stage",
	"feeder-commit",
	"feeder-switch",
]);

/** Cancellation wake is bound to one exact run; ordinary provision has no params. */
export const liveStartupCancelParamsSchema = z.object({
	cancelRunId: z.uuid().optional(),
});

/**
 * Params for the insert-content action (validated again worker-side).
 * Bounds MATCH the existing panel path's scheduleContentCreateSchema —
 * uuid content ids and the 24h duration ceiling (review-190 I5: the first
 * cut said 1h, so a rain-delay slate was impossible via the scheduler but
 * fine via the panel — two schemas for one Bitmovin field).
 */
export const liveInsertContentParamsSchema = z.object({
	insertableContentId: z.uuid(),
	durationSeconds: z.number().int().min(1).max(86_400),
	// review-223 F6 : when the slate is bounded by a program
	// start, the WINDOW rides along and the processor re-derives the duration
	// at the moment it calls the SDK — queue retries can run ~75s after the
	// sweep computed durationSeconds, and every one of those seconds would
	// otherwise be slate ON TOP of the program. scheduleId lets the processor
	// write the outcome onto the row when the window is already gone.
	slateUntil: z.iso.datetime().optional(),
	scheduleId: z.uuid().optional(),
});

export type LiveInsertContentParams = z.infer<
	typeof liveInsertContentParamsSchema
>;

/** Params for register-slate-content . */
export const liveRegisterSlateParamsSchema = z.object({
	scheduleId: z.uuid(),
	// review-223: the ONE source shape, not a local re-declaration of it —
	// drift between the row schema and the queue schema would strand rows.
	source: slateSourceSchema,
});
export type LiveRegisterSlateParams = z.infer<
	typeof liveRegisterSlateParamsSchema
>;

/** Params for feeder-start / feeder-switch . */
export const liveFeederActionParamsSchema = z.object({
	scheduleId: z.uuid(),
	// : the SEALED shape, not the bare location. The processor
	// creating the session is what writes the seal onto it, so the version
	// the sweep read off the row has to survive the queue hop — parsing this
	// as `slateSourceSchema` (strict) would have REJECTED every sealed row's
	// payload and stranded the feed.
	source: sealedFeederSourceSchema,
});
export type LiveFeederActionParams = z.infer<
	typeof liveFeederActionParamsSchema
>;

/**
 * Params for feeder-stage : the fire path's payload plus the
 * instant the switch is meant to COMMIT — the row's fireAt, carried onto
 * the session as `commitAt` so the held session can time out a commit that
 * never arrives, and so the immediate form can say "now".
 */
export const liveFeederStageParamsSchema = liveFeederActionParamsSchema.extend({
	commitAt: z.iso.datetime(),
});
export type LiveFeederStageParams = z.infer<typeof liveFeederStageParamsSchema>;

/**
 * Params for feeder-commit : the row and the session it staged.
 * Both ids ride the payload so the processor's compare-and-swap names the
 * exact session the sweep judged READY, never "whatever the row points at
 * now".
 */
export const liveFeederCommitParamsSchema = z.object({
	scheduleId: z.uuid(),
	feederSessionId: z.uuid(),
});
export type LiveFeederCommitParams = z.infer<
	typeof liveFeederCommitParamsSchema
>;
export type LiveChannelAction = z.infer<typeof liveChannelActionSchema>;

/** ResetLiveManifestTimeShift surface (manifestIds absent = all manifests). */
export const liveResetTimeshiftParamsSchema = z.object({
	residualPeriodInSeconds: z.number().min(0).optional(),
	offsetInSeconds: z.number().min(0).optional(),
	manifestIds: z.array(z.string().min(1)).min(1).optional(),
	/** Shifts progressive MP4 start positions too (SDK: MP4 only). */
	shiftProgressiveMuxingStartPosition: z.boolean().optional(),
});
export type LiveResetTimeshiftParams = z.infer<
	typeof liveResetTimeshiftParamsSchema
>;

/**
 * live-to-VOD params. Bitmovin has NO live-to-VOD API: the operation is a
 * workflow — generate DEFAULT VOD manifests over the (stopped) live
 * encoding's recorded output with `manifestGenerator: LEGACY` (C3: V2 is
 * pinned everywhere EXCEPT here). The destination reuses an OUTPUT the
 * channel already provisioned (resolved from its step log), so no new
 * credentials are needed.
 */
export const liveToVodParamsSchema = z.object({
	/** Plan output key; absent ⇒ the channel's first output. */
	outputKey: z.string().min(1).optional(),
	/**
	 * Manifest destination path; absent ⇒ the parent of every muxing path the
	 * channel's step log records. A default manifest MUST sit above the muxings
	 * it lists (COVERAGE §0 C35), so a value here is validated against them
	 * rather than sent — see `resolveLiveToVodTarget`.
	 */
	path: z.string().min(1).optional(),
	/**
	 * Which manifest families to generate; absent ⇒ every family the RECORDED
	 * muxings are compatible with (`supportedLiveToVodFamilies` over the step
	 * log: fMP4 → HLS + DASH, segmented TS → HLS only). It used to mean "both",
	 * which on a TS-only recording created a DASH default manifest the
	 * provider refuses (400 / code 2700) and turned the delivered HLS into a
	 * whole-record ERROR . An explicit
	 * incompatible family is refused by the route (422) and the worker before
	 * any provider call.
	 */
	manifests: z
		.array(z.enum(["HLS", "DASH"]))
		.min(1)
		.optional(),
});
export type LiveToVodParams = z.infer<typeof liveToVodParamsSchema>;

/** Scte35Cue surface — cueDuration seconds; manifestIds absent = all. */
export const liveScte35ParamsSchema = z.object({
	cueDuration: z.number().positive(),
	manifestIds: z.array(z.string().min(1)).min(1).optional(),
});
export type LiveScte35Params = z.infer<typeof liveScte35ParamsSchema>;

/**
 * Durable external-effect identity. Producers bind this at admission; the
 * worker acquires the corresponding database claim and persists DISPATCHING
 * before crossing the provider send/process-spawn boundary.
 */
export const liveEffectActionSchema = z.enum([
	"STOP",
	"RESTART",
	"SLATE_INSERT",
	"SLATE_REGISTER",
	"SCTE35",
	"TIMESHIFT_RESET",
	"RTMP_INGEST_UPDATE",
	"AUTO_SHUTDOWN_UPDATE",
	"FEEDER_START",
	"FEEDER_COMMIT",
	"FEEDER_SPAWN",
]);
export type LiveEffectAction = z.infer<typeof liveEffectActionSchema>;

export const liveEffectIntentSchema = z.object({
	idempotencyKey: z.string().min(1).max(240),
	requestSha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	liveChannelRunId: z.uuid(),
	providerEncodingId: z.string().min(1),
	admissionFenceVersion: z.number().int().nonnegative(),
	action: liveEffectActionSchema,
	scheduleId: z.uuid().optional(),
	targetId: z.string().min(1).optional(),
});
export type LiveEffectIntent = z.infer<typeof liveEffectIntentSchema>;

export const liveChannelJobSchema = z
	.object({
		liveChannelId: z.uuid(),
		action: liveChannelActionSchema.default("provision"),
		/** Action-specific params; parsed per action by the worker. */
		params: z.unknown().optional(),
		/**
		 * live-to-VOD only: the route claim, BullMQ job and every worker write use
		 * the same identity. Optional for all historical/non-live-to-VOD jobs.
		 */
		attemptId: z.uuid().optional(),
		liveChannelRunId: z.uuid().optional(),
		encodingId: z.string().min(1).optional(),
		/**
		 * WHICH airing a scheduled action was planned for. New irreversible
		 * effects also carry `effect`, whose exact run/provider/generation is
		 * claimed again immediately before the external boundary.
		 */
		plannedLiveChannelRunId: z.uuid().nullish(),
		/** Required for every newly-admitted irreversible provider/ingest effect. */
		effect: liveEffectIntentSchema.optional(),
	})
	.superRefine((job, ctx) => {
		if (job.action !== "live-to-vod") {
			return;
		}
		for (const key of [
			"attemptId",
			"liveChannelRunId",
			"encodingId",
		] as const) {
			if (job[key] === undefined) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `${key} is required for live-to-vod`,
				});
			}
		}
	});
export type LiveChannelJob = z.infer<typeof liveChannelJobSchema>;

export const storageInspectJobSchema = z.object({
	storageInspectionId: z.uuid(),
});
export type StorageInspectJob = z.infer<typeof storageInspectJobSchema>;

/** One `SlateNormalization` row to prepare and register . */
export const slateNormalizeJobSchema = z.object({
	slateNormalizationId: z.uuid(),
});
export type SlateNormalizeJob = z.infer<typeof slateNormalizeJobSchema>;

/** The repeatable promoter's job name on the slate-normalize queue. */
export const SLATE_NORMALIZE_PROMOTE_JOB = "slate-normalize-promote";

/**
 * Notify queue job = the product event itself . Validated at
 * BOTH ends: the emitter refuses to enqueue an event the schema rejects, and
 * the consumer re-parses before delivery so a queue writer cannot smuggle
 * fields past the strict payload contract.
 */
export const notifyJobSchema = productEventSchema;

/**  PR4 — a probe batch. Caps mirror the design: <=10 per region. */
export const probeBatchJobSchema = z.object({
	requestId: z.string().uuid(),
	regions: z.array(z.string().min(1)).min(1).max(10),
	perRegion: z.number().int().min(1).max(10),
});
export type ProbeBatchJob = z.infer<typeof probeBatchJobSchema>;

export const vmafJobSchema = z.object({
	vmafJobId: z.uuid(),
});
export type VmafJob = z.infer<typeof vmafJobSchema>;

/**
 * Feeder-manager queue payloads (P3-PR3). "start" runs the whole session
 * lifecycle inside ONE long-lived BullMQ job (download → probe → supervised
 * ffmpeg push until stop/error — BullMQ renews the lock while the processor
 * promise is pending); "stop" signals the in-process supervisor (SIGTERM →
 * grace → SIGKILL), which is why the feeder worker needs concurrency > 1.
 * There is no "restart": the supervisor restarts crashed ffmpeg itself
 * (bounded backoff) and a finished session is recreated, not revived.
 */
export const feederJobSchema = z.object({
	feederSessionId: z.uuid(),
	action: z.enum(["start", "stop"]),
});
export type FeederJob = z.infer<typeof feederJobSchema>;

/**
 * Feeder-manager worker concurrency. One BullMQ "start" job holds a slot
 * for its WHOLE push (hours — BullMQ renews the lock while the processor
 * promise is pending), so stop jobs need spare slots to reach the
 * in-process supervisor registry. The create route enforces
 * FEEDER_MAX_ACTIVE_SESSIONS (= concurrency − 1) so at least one slot is
 * always free for a stop — without the cap, FEEDER_CONCURRENCY long-lived
 * starts would starve every stop into the waiting list.
 */
export const FEEDER_CONCURRENCY = 8;
export const FEEDER_MAX_ACTIVE_SESSIONS = FEEDER_CONCURRENCY - 1;

/**
 * Structural queue surface for feeder producers — bullmq's Queue satisfies
 * it, and core stays free of a bullmq dependency.
 */
export type FeederQueueLike = {
	add(
		name: string,
		data: FeederJob,
		opts: { jobId: string; removeOnComplete: number; removeOnFail: number },
	): Promise<unknown>;
	getJob(
		jobId: string,
	): Promise<
		| { getState(): Promise<string>; remove(): Promise<unknown> }
		| null
		| undefined
	>;
};

/**
 * Feeder jobId convention shared by every producer: start jobs dedupe on
 * the bare session id (sessions are one-shot — exactly one start per row),
 * stop jobs on `<id>:stop` so a route-issued stop and the channel-stop
 * coupling collapse into one delivery.
 */
/**
 * A DASH, not a colon. BullMQ 5 rejects a custom job id containing `:`.
 *
 * `job.js:1049` throws `Custom Id cannot contain :` — the character is its own key
 * separator in Redis. So every feeder STOP returned HTTP 500 and the session stayed
 * PUSHING: an ffmpeg process nobody could stop through the product, which is a bill.
 *
 * Found by the first real live channel. No test could: the queue is mocked everywhere, and
 * a mock accepts any id — so the id that BullMQ refuses is exactly the id every test was
 * happy with. The stop path had never once run against a real queue.
 */
export function feederJobId(job: FeederJob): string {
	return job.action === "stop"
		? `${job.feederSessionId}-stop`
		: job.feederSessionId;
}

/**
 * The one feeder enqueue path (web routes + the live-channel coupling in
 * the worker). BullMQ treats ANY existing job under a jobId — including one
 * parked in the failed OR completed set — as "already enqueued" and silently
 * drops the add, which would block every retry after a failed stop. So a
 * SETTLED job under the dedup id is removed first (best-effort: losing that
 * race just no-ops the add and the caller retries); pending/active duplicates
 * still dedupe — that idempotency is the point of the constant id.
 *
 * COMPLETED joined that set with audit 2026-08-29 CRITICAL-2. The old comment
 * argued the completed-id caveat "cannot bite here, because sessions are
 * terminal after one stop" — and that premise is now false: a session whose
 * START job died outside the worker can be terminal AND still own a pushing
 * ffmpeg, so a second stop is exactly what reclaims it. With a completed
 * `<id>-stop` job parked under the dedup id, that second stop would have been
 * swallowed and the operator would have watched a 200 do nothing.
 */
const SETTLED_JOB_STATES = new Set(["failed", "completed"]);

export async function enqueueFeederJob(
	queue: FeederQueueLike,
	job: FeederJob,
): Promise<void> {
	const jobId = feederJobId(job);
	if (job.action === "stop") {
		const existing = await queue.getJob(jobId);
		if (existing && SETTLED_JOB_STATES.has(await existing.getState())) {
			await existing.remove().catch(() => {});
		}
	}
	await queue.add("feeder", job, {
		jobId,
		removeOnComplete: 1000,
		removeOnFail: 1000,
	});
}
