import {
	checkInternalHevcV2Plan,
	classifyProviderStatusWord,
	encodingPlanSchema,
	orchestratorJobSchema,
	type QcVerdict,
	redactSecrets,
	type StepLogEntry,
	soleEncodingStepId,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import { autoTriggerKey } from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";
import {
	finishResetOwner,
	type ResetEncodingJournal,
	type ResetOwnerState,
} from "../reset/lost-encodings";
import { qcVmafEnabled } from "../settings/feature-flags";
import { unresolvableModelMessage } from "../vmaf/model-error";
import {
	CancelRequested,
	executeStep,
	type ResolvedCredential,
} from "./executor";
import {
	assertInternalHevcV2Access,
	type InternalHevcV2,
	internalHevcV2StepsMatch,
} from "./internal-hevc-v2";
import {
	applyJitFallback,
	type JitFallbackNote,
	planJitFallback,
} from "./jit-fallback";
import { VerificationProviderIdPersistenceError } from "./ops/encoding";
import { BitmovinCallError } from "./ops/shared";
import { pollSleepFor } from "./poll-sleep";
import type { SdkOps } from "./sdk-ops";
import {
	type CreateStamp,
	VerificationProviderIdDefinitelyNotPersistedError,
	VerificationProviderOwnershipLostError,
	verificationCreateIdentity,
} from "./stamping-fetch";
import type { StartRetryControl } from "./start-1004-retry";

/**
 * Orchestrator (ARCHITECTURE §3): replays the job's persisted step log —
 * DONE steps are skipped (idempotent resume), each step persists its state
 * before and after execution, redacted snapshots satisfy C7. Single
 * writer per job (schema contract); BullMQ guarantees one active job per
 * jobId, and we use the EncodingJob id as the BullMQ jobId.
 */

export type OrchestratorDeps = {
	journalResetEncoding?: ResetEncodingJournal;
	acknowledgeResetEntity?: (
		entityKey: string,
		ownerToken: string | null,
	) => Promise<void>;
	prisma: AppPrismaClient;
	revealBitmovinAccount(accountId: string): Promise<{
		apiKey: string;
		tenantOrgId: string | null;
	}>;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	/**
	 * Can THIS worker score with the named VMAF model?
	 *
	 * REQUIRED, with `null` as the explicit opt-out — deleting the wiring is a
	 * compile error, not a silent regression. review-234 caught this guard
	 * dormant once already (it was a `validatePlan` option nobody passed), and
	 * then caught me claiming a wiring assertion that did not exist: removing
	 * the line from `index.ts` left 1048/1048 green. `index.ts` cannot be
	 * imported in tests (module side effects — `sdk-ops.stamp.test.ts` records
	 * why), so the type is the only structural guard available; it is the same
	 * cure review-228 B1 applied when `hasEncoding` vanished past 2,467 tests.
	 *
	 * `null` still means "no capability claim ⇒ no refusal" — an unknown must
	 * not manufacture one.
	 */
	vmafModelAvailable: ((model: string) => boolean) | null;
	makeSdk(args: {
		internalHevcV2?: InternalHevcV2;
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
		/** : create-op idempotency stamp, threaded to the fetch layer
		 * (and its adoptWindow to sdk-ops' adopt-before-create). Structural
		 * subtype of CreateStamp — the #163 lesson says a NARROWER declaration
		    here lets a wiring silently drop a field, so keep it in lockstep. */
		stamp?: CreateStamp;
		startControl?: StartRetryControl;
	}): SdkOps;
	sleep(ms: number): Promise<void>;
	pollIntervalMs: number;
	pollTimeoutMs: number;
	now(): string;
	/**
	 * VOD completion hook (P4): invoked once, AFTER the job is persisted
	 * FINISHED, with the already-parsed plan. The VMAF trigger lives here so
	 * the orchestrator stays Bitmovin-only — it creates+enqueues a VmafJob
	 * iff the plan requested VMAF or PSNR (idempotently). Best-effort: a throw is
	 * logged and swallowed so a VMAF-trigger failure never reverts a green
	 * encoding to ERROR (the encoding genuinely finished).
	 */
	onVodFinished?(args: {
		encodingJobId: string;
		plan: ReturnType<typeof encodingPlanSchema.parse>;
	}): Promise<void>;
	/**
	 * Product-event emit . BEST-EFFORT at the emitter: it never
	 * throws, so terminal transitions below call it unguarded — a notify
	 * outage can drop notifications, never FAIL a job. (It is awaited, so a
	 * wedged Redis delays the transition by ioredis's timeout — bounded, and
	 * accepted; review-183 N3.)
	 */
	emitEvent?: EmitProductEvent;
	/**
	 * Webhook-driven early wake . Optional: absent ⇒
	 * plain fixed-interval sleep, byte-identical behaviour to before. The
	 * interest set is READ per sleep (a getter), because the encoding id
	 * only exists after CREATE_ENCODING runs.
	 */
	wakeSleep?(ms: number, interestedIds: () => string[]): Promise<void>;
};

/**
 * How long an attempt's lease survives WITHOUT A HEARTBEAT before another
 * worker may take the job .
 *
 * The VOD twin of `PROVISION_LEASE_MS` in live-processor.ts, and the same
 * correction applies: this is a STALENESS window, not a run budget. An
 * encoding can legitimately run for hours; the lease is renewed on every poll
 * tick (and every persist), so an alive worker holds it however long the
 * provider takes. This window only decides how long a DEAD worker's claim
 * lingers before a redelivery may proceed — and a redelivery arriving inside
 * it returns quietly rather than starting a second tree.
 */
export const ATTEMPT_LEASE_MS = 10 * 60 * 1000;

/**
 * The rows a delivery may take over: non-terminal, and either unclaimed or held by
 * an attempt that stopped renewing more than a lease window ago.
 *
 * ONE derivation, TWO callers (review-322 C2): the processor's claim at the top of
 * `process`, and `index.ts`'s BullMQ `failed` handler. The handler used to match
 * on status alone, so a doubly-stalled ORIGINAL delivery's belated `failed` event —
 * which BullMQ raises independently of whether a redelivery has since claimed the
 * lease and is running correctly — flipped the winner's row to ERROR, nulled its
 * lease out from under it, and on the unattended path stopped its real encoding at
 * the provider. A fresh lease now excludes the row from that handler the same way it
 * excludes it from a second delivery.
 */
export function claimableWhere(
	encodingJobId: string,
	statuses: ("QUEUED" | "RUNNING" | "AWAITING_QC")[],
	now: Date,
): {
	id: string;
	status: { in: ("QUEUED" | "RUNNING" | "AWAITING_QC")[] };
	OR: [{ attemptClaimedAt: null }, { attemptClaimedAt: { lt: Date } }];
} {
	return {
		id: encodingJobId,
		status: { in: statuses },
		OR: [
			{ attemptClaimedAt: null },
			{ attemptClaimedAt: { lt: new Date(now.getTime() - ATTEMPT_LEASE_MS) } },
		],
	};
}

/*
 * Two properties of the timestamp lease that are NOT attempt-scoped, written down
 * because review-322 found the first one as a live hole:
 *
 * - `null` is a SHARED sentinel. Every attempt that leaves the row (FINISHED, ERROR,
 *   QC_FAILED, the AWAITING_QC park) writes it, so "attemptClaimedAt is null" proves
 *   nobody holds the lease NOW — it does not prove that the attempt reading it was the
 *   one that released it. The one write this processor makes AFTER its own release
 *   (the ERROR write when the QC trigger fails after the park) therefore also CASes on
 *   `status: "AWAITING_QC"`: that status is the park's one-way door, and the continuation
 *   that takes the row out of it is the only other writer. A monotonic per-claim
 *   generation would make this structurally impossible; the timestamp keeps the
 *   staleness check free of owner bookkeeping, so the guard is the status instead.
 * - Renewal happens BETWEEN steps (`persist`) and on poll ticks, never inside one step's
 *   own SDK work. `CAPTURE_PER_TITLE_RESULTS` and `stopSiblingEncodings` are sequential
 *   provider round-trips that renew nothing for their duration; at a realistic ladder
 *   they sit far inside the window, and both are read-only or idempotent-stop, so an
 *   overrun costs the attempt its already-done work when its next `persist` loses the
 *   fence — never a second billable tree. Accepted, like #38's adoption residual.
 */

/**
 * Raised when this attempt's lease is taken by another worker.
 *
 * A SENTINEL, not a step failure, for the reason live-processor.ts records
 * about `ProvisionLeaseLostError`: a step failure means the job is broken —
 * mark ERROR, stop siblings, emit JOB_ERROR. Losing the lease means the job is
 * FINE, another attempt owns it, and every one of those actions would land on
 * the row the winner is mid-way through. It is also NOT rethrown out of
 * `process`: BullMQ's `failed` handler flips a QUEUED/RUNNING row to ERROR
 * with no ownership check, so a rethrow would have the LOSER mark the WINNER's
 * job broken.
 */
export class AttemptLeaseLostError extends Error {
	constructor(encodingJobId: string) {
		super(
			`encoding job ${encodingJobId}: attempt lease lost to another worker — stopping before this attempt writes over the owner's step log or creates a second encoding tree`,
		);
		this.name = "AttemptLeaseLostError";
	}
}

export function createOrchestratorProcessor(deps: OrchestratorDeps) {
	const process = async function process(
		jobData: unknown,
		resetOwner: ResetOwnerState,
	): Promise<{
		acknowledged: true;
		encodingJobId: string;
		status: string;
	}> {
		const { encodingJobId } = orchestratorJobSchema.parse(jobData);
		resetOwner.entityKey = `encodingJob:${encodingJobId}`;
		// `let`: re-read after the lease claim below (CRITICAL-1).
		let row = await deps.prisma.encodingJob.findUnique({
			where: { id: encodingJobId },
		});
		if (!row) {
			console.warn(`[orchestrator] job ${encodingJobId} not found — skipping`);
			return { acknowledged: true, encodingJobId, status: "MISSING" };
		}
		if (
			row.status === "FINISHED" ||
			row.status === "CANCELED" ||
			row.status === "ERROR" ||
			row.status === "QC_FAILED"
		) {
			// QC_FAILED is terminal for the PROCESSOR too: delivery-despite-
			// failure is PR4's audited override, never a redelivered queue job.
			return { acknowledged: true, encodingJobId, status: row.status };
		}

		/*
		 * TAKE THE ATTEMPT LEASE, atomically — before any write, any SDK call
		 *
		 *
		 * Everything below this line used to run on the strength of a single
		 * read: the row was not terminal, so proceed. A worker whose BullMQ
		 * lock lapsed mid-provider-call (a Redis blip, a paused container, an
		 * event loop stalled past lockDuration) never learned it had been
		 * redelivered; the second worker read the same non-terminal row and
		 * ran the same steps. Both created at the provider, both wrote the
		 * step log, the last writer won, and `stop-remote-encodings` — which
		 * enumerates only RECORDED ids — could not stop the tree that lost.
		 *
		 * `updateMany` is the lock: exactly one caller matches and gets
		 * `count === 1`. A loser with a live lease returns LEASE_HELD so the
		 * queue handler defers redelivery without acknowledging the job. The lease
		 * EXPIRES rather than being released by name so a worker killed
		 * mid-attempt cannot wedge the job; an alive worker renews it on every
		 * poll tick and every persist (see `renewLease` / `persist`).
		 */
		const claimNowMs = new Date(deps.now()).getTime();
		const claimed = await deps.prisma.encodingJob.updateMany({
			where: claimableWhere(
				encodingJobId,
				["QUEUED", "RUNNING", "AWAITING_QC"],
				new Date(claimNowMs),
			),
			data: { attemptClaimedAt: new Date(claimNowMs) },
		});
		if (claimed.count === 0) {
			// The row may have been deleted or become terminal after our first
			// read. Only actual contention on resumable work needs redelivery.
			const current = await deps.prisma.encodingJob.findUnique({
				where: { id: encodingJobId },
			});
			if (!current) {
				return { acknowledged: true, encodingJobId, status: "MISSING" };
			}
			if (!["QUEUED", "RUNNING", "AWAITING_QC"].includes(current.status)) {
				return { acknowledged: true, encodingJobId, status: current.status };
			}
			console.warn(
				`[orchestrator] job ${encodingJobId}: attempt lease held by another worker — not starting a second attempt`,
			);
			return { acknowledged: true, encodingJobId, status: "LEASE_HELD" };
		}
		/**
		 * The value THIS attempt last wrote — the fencing token. Every write
		 * below is a compare-and-swap against it, so an attempt whose lease
		 * was taken cannot write: the comparison fails and it stops.
		 *
		 * `null` is itself a valid token: after a RELEASING write (park, terminal)
		 * this attempt may still need to write — a trigger that fails right after
		 * the park must be able to record ERROR — and `null` then means "released
		 * by me and unclaimed since". If a continuation has claimed in between,
		 * the comparison fails and the continuation's ownership wins. The first
		 * cut kept the old Date here after releasing, which refused exactly that
		 * ERROR write and turned a real trigger failure into a silent LEASE_LOST.
		 */
		let heldAt: Date | null = new Date(claimNowMs);
		resetOwner.ownerToken = heldAt.toISOString();
		/**
		 * RE-READ after winning (the live lease's own lesson, review of #182):
		 * the snapshot above predates the claim, and a cancel, an override or a
		 * retry may have rewritten the row in between.
		 */
		const claimedRow = await deps.prisma.encodingJob.findUnique({
			where: { id: encodingJobId },
		});
		if (!claimedRow) {
			return { acknowledged: true, encodingJobId, status: "MISSING" };
		}
		row = claimedRow;
		/**
		 * Renew on every poll tick, with the timestamp itself as the token. A
		 * bare "refresh" would be incoherent — with no owner, a worker whose
		 * lease had already gone stale would extend whoever took it. So the
		 * renewal only matches while `attemptClaimedAt` is still OUR value.
		 */
		const renewLease = async (): Promise<boolean> => {
			const next = new Date(new Date(deps.now()).getTime());
			const { count } = await deps.prisma.encodingJob.updateMany({
				where: { id: encodingJobId, attemptClaimedAt: heldAt },
				data: { attemptClaimedAt: next },
			});
			if (count === 0) {
				return false;
			}
			heldAt = next;
			resetOwner.ownerToken = next.toISOString();
			return true;
		};
		/**
		 * The ONE write funnel for this attempt, FENCED on the lease.
		 *
		 * `where` carries the token we last wrote; a count of zero means another
		 * attempt owns the row now and this one stops without writing. The write
		 * also RENEWS the lease — every persist is a heartbeat — except on a
		 * status that leaves the attempt (terminal, parked at AWAITING_QC,
		 * canceled), where it RELEASES the lease instead: a retry after ERROR,
		 * an override after QC_FAILED, or the QC continuation after AWAITING_QC
		 * must be able to claim at once rather than wait out a window that was
		 * never protecting anything.
		 *
		 * Also bumps the denormalized list-view progress column in the SAME
		 * write (the orchestrator is the single writer of stepLog). The list API
		 * can't select stepLog (perf contract), so it reads doneSteps instead.
		 */
		/**
		 * The fenced write, returning whether it landed. `guard` narrows the fence
		 * beyond the lease token for the one call site whose token is the shared
		 * `null` sentinel (see the note above `claimableWhere`).
		 */
		const persistIf = async (
			id: string,
			stepEntries: StepLogEntry[],
			extra: Record<string, unknown> = {},
			guard: Record<string, unknown> = {},
		): Promise<boolean> => {
			const doneSteps = stepEntries.reduce(
				(count, entry) => (entry.status === "DONE" ? count + 1 : count),
				0,
			);
			const leaving = extra.status !== undefined && extra.status !== "RUNNING";
			const next = new Date(new Date(deps.now()).getTime());
			const { count } = await deps.prisma.encodingJob.updateMany({
				where: { id, attemptClaimedAt: heldAt, ...guard },
				data: {
					stepLog: stepEntries as unknown as Prisma.InputJsonValue,
					doneSteps,
					...extra,
					// finishedAt is DERIVED here, inside the funnel, not passed by
					// call sites (review-259 pre-check on 116-A1): persist is the
					// single writer of the FINISHED transition, and deriving the
					// stamp from the status being written means a future FINISHED
					// writer cannot silently omit it — @updatedAt cannot serve as
					// the finish time because any later write (a MARK_ONLY VMAF
					// verdict, a snapshot backfill) bumps it.
					...(extra.status === "FINISHED" ? { finishedAt: deps.now() } : {}),
					attemptClaimedAt: leaving ? null : next,
				},
			});
			if (count === 0) {
				return false;
			}
			heldAt = leaving ? null : next;
			if (!leaving) resetOwner.ownerToken = next.toISOString();
			return true;
		};
		const persist = async (
			id: string,
			stepEntries: StepLogEntry[],
			extra: Record<string, unknown> = {},
		): Promise<void> => {
			if (!(await persistIf(id, stepEntries, extra))) {
				throw new AttemptLeaseLostError(id);
			}
		};

		if (row.status === "AWAITING_QC") {
			// Continuation entry . The claim SERIALIZES
			// deliveries that arrive while the row is parked: whichever loses
			// this CAS returns without touching the step log. It is a claim,
			// not a lease (review-201 I1) — a delivery that arrives AFTER the
			// winner flipped to RUNNING never enters this block and resumes
			// like any stalled-redelivery would, which is the codebase's
			// pre-existing accepted stall risk, not a new invariant: top-level
			// manifest creates dedupe through 's stamp + adopt
			// window, unstamped manifest CHILDREN (DASH periods/HLS media —
			// their SDK models lack customData) can duplicate inside an
			// adopted manifest. Ledger row 86 records that residual; the
			// per-measurement continuation ids (review-201 I2) keep routine
			// operation to one wake per verdict.
			const claim = await deps.prisma.encodingJob.updateMany({
				where: { id: encodingJobId, status: "AWAITING_QC" },
				data: { status: "RUNNING" },
			});
			if (claim.count === 0) {
				// The row left AWAITING_QC between the re-read and this CAS — a
				// window the lease narrows to a few milliseconds but cannot close.
				// Whoever moved it owns the work; RELEASE the lease we just took so
				// they (or a retry) are not locked out for a full window.
				await deps.prisma.encodingJob.updateMany({
					where: { id: encodingJobId, attemptClaimedAt: heldAt },
					data: { attemptClaimedAt: null },
				});
				return { acknowledged: true, encodingJobId, status: "CLAIMED" };
			}
			row.status = "RUNNING";
		}

		// Failures before the first step (corrupt plan, deleted account,
		// MASTER_KEY problems) must not strand the row in QUEUED — retry
		// only accepts ERROR.
		let plan: ReturnType<typeof encodingPlanSchema.parse>;
		let entries: ReturnType<typeof stepLogSchema.parse>;
		let sdk: SdkOps;
		// : which step is executing, for the create-op stamp. Cleared on
		// BOTH exits of executeStep (the DONE path and the catch), so poll,
		// finalize, cancel and sibling-stop traffic all run with no stamp.
		let stampStep: string | undefined;
		// The adoption window is true only while a step that a previous
		// attempt left RUNNING re-executes. Same lifecycle as stampStep — the two
		// move in lockstep at all three sites (set, success-clear, catch-clear).
		let stampAdopt = false;
		let activeEntry: StepLogEntry | undefined;
		let isVerificationRun = false;
		let accountId: string;
		try {
			plan = encodingPlanSchema.parse(row.plan);
			entries = stepLogSchema.parse(row.stepLog);
			resetOwner.entries = entries;
			const verification = verificationCreateIdentity(
				row.verificationKey,
				row.verificationRequestSha256,
			);
			isVerificationRun = verification !== undefined;
			const resolvedAccountId =
				row.cancelRequested && plan.internal?.hevcV2 && row.bitmovinAccountId
					? row.bitmovinAccountId
					: (plan.bitmovin.accountId ?? row.bitmovinAccountId);
			if (!resolvedAccountId) {
				throw new Error("Plan carries no Bitmovin account id");
			}
			if (!row.cancelRequested) {
				if (checkInternalHevcV2Plan(plan).length)
					throw new Error("Invalid internal HEVCv2 persisted plan");
				if (plan.internal?.hevcV2) {
					assertInternalHevcV2Access(resolvedAccountId, plan.internal.hevcV2);
					if (
						row.bitmovinAccountId &&
						row.bitmovinAccountId !== resolvedAccountId
					)
						throw new Error("Invalid internal HEVCv2 persisted plan/account");
					if (!internalHevcV2StepsMatch(plan, entries))
						throw new Error(
							"Internal HEVCv2 persisted steps do not match the plan",
						);
				} else if (
					entries.some(
						(entry) =>
							entry.payload.internalHevcV2 !== undefined ||
							entry.payload.bcfVersion !== undefined ||
							entry.payload.encodingMode === "SMART_PASS",
					)
				) {
					throw new Error(
						"Internal HEVCv2 step requires the enabled plan profile",
					);
				}
			}
			accountId = resolvedAccountId;
			resetOwner.accountId = accountId;
			/**
			 * Refuse an unusable VMAF model HERE — before the first Bitmovin
			 * resource exists, so the refusal costs nothing.
			 *
			 * review-234 I1: the same check was added to `validatePlan` as an
			 * option and then never wired, so the protection existed only in
			 * its own tests. This site needs no plumbing: the worker IS the
			 * process that will score, `deps.vmafModelAvailable` is its real
			 * capability, and a plan whose model resolves to neither a
			 * built-in nor a bundled file would otherwise fail after the
			 * encode had finished and every QC mirror had been downloaded.
			 * Undefined capability ⇒ no refusal (the same rule as the
			 * validator: an unknown must not manufacture one).
			 */
			if (plan.qc && deps.vmafModelAvailable !== null) {
				const model = plan.qc.model;
				if (!deps.vmafModelAvailable(model)) {
					throw new Error(unresolvableModelMessage(model, undefined));
				}
			}
			const account = await deps.revealBitmovinAccount(accountId);
			sdk = deps.makeSdk({
				...(!row.cancelRequested && plan.internal?.hevcV2
					? { internalHevcV2: plan.internal.hevcV2 }
					: {}),
				startControl: {
					check: async (attempted) => {
						if (!(await renewLease()))
							throw new AttemptLeaseLostError(encodingJobId);
						if (await checkCancel())
							throw new CancelRequested(stampStep ?? "start", !attempted);
					},
					sleep: deps.sleep,
				},
				apiKey: account.apiKey,
				tenantOrgId: account.tenantOrgId,
				bitmovinAccountId: accountId,
				// The step slot the stamping fetch reads at call time .
				// Set around executeStep below; per-job instance, so no cross-job race.
				stamp: {
					jobId: encodingJobId,
					currentStep: () => stampStep,
					adoptWindow: () => stampAdopt,
					...(verification
						? {
								verification,
								onEncodingCreated: async (
									providerId: string,
									source: "created" | "adopted",
								) => {
									if (
										activeEntry?.kind !== "CREATE_ENCODING" ||
										activeEntry.status !== "RUNNING"
									) {
										throw new Error(
											"VERIFICATION_PROVIDER_ID_WITHOUT_ACTIVE_CREATE_STEP",
										);
									}
									activeEntry.resourceId = providerId;
									activeEntry.response = redactSecrets({
										providerId,
										source,
										durability: "PROVIDER_ID_PERSISTED",
									});
									try {
										await persist(encodingJobId, entries, {
											...(activeEntry.step === soleEncodingStepId(entries)
												? {
														bitmovinEncodingId: providerId,
														// rev431: the pointer is (re)written for an encoding
														// about to run — no confirmation can stand for it.
														encoderStoppedConfirmedFor: null,
													}
												: {}),
										});
									} catch (err) {
										if (err instanceof AttemptLeaseLostError) {
											return "OWNERSHIP_LOST" as const;
										}
										if ((err as { code?: unknown })?.code === "P1001") {
											throw new VerificationProviderIdDefinitelyNotPersistedError(
												err,
											);
										}
										throw err;
									}
									return "PERSISTED" as const;
								},
							}
						: {}),
				},
			});
			resetOwner.sdk = sdk;
		} catch (err) {
			const message = err instanceof Error ? err.message : "setup failed";
			// Fenced and RELEASED like every other leaving write: a retry after
			// this ERROR must be able to claim immediately.
			await deps.prisma.encodingJob.updateMany({
				where: { id: encodingJobId, attemptClaimedAt: heldAt },
				data: {
					status: "ERROR",
					error: redactSecrets(message),
					attemptClaimedAt: null,
				},
			});
			heldAt = null;
			await deps.emitEvent?.({
				kind: "JOB_ERROR",
				jobId: encodingJobId,
				name: row.name,
				labels: row.labels,
				error: redactSecrets(message),
				path: `/vod/jobs/${encodingJobId}`,
			});
			throw err;
		}

		// Resolve already-created resource ids from DONE entries up front: the
		// cancel finalize needs them (to stop the encoding) and so does the step
		// loop. Built BEFORE the RUNNING transition so a loop-top cancel can run
		// finalize without flipping the job to RUNNING first.
		const ids = new Map<string, string>();
		// Hoisted: the answer cannot change during the run, and computing it per
		// step made this O(n^2) over the step log (review nit).
		const soleStep = soleEncodingStepId(entries);

		for (const entry of entries) {
			if (entry.status === "DONE" && entry.resourceId) {
				ids.set(entry.step, entry.resourceId);
			}
		}

		// Cooperative cancel , re-read from the DB each loop so a
		// crash+resume re-honors it idempotently. The row loaded above may be
		// stale by the time a step finishes, so we re-query the flag rather than
		// trust the initial snapshot.
		const checkCancel = async (): Promise<boolean> => {
			const fresh = await deps.prisma.encodingJob.findUnique({
				where: { id: encodingJobId },
				select: { cancelRequested: true },
			});
			if (fresh === null) {
				return true;
			}
			return fresh.cancelRequested === true;
		};
		// Cancel finalize: stop the job's encoding(s) best-effort (a stop failure
		// is logged, never fatal — we still cancel locally), then persist CANCELED
		// with error:null (CANCELED is not an error). Sent START attempts retain
		// their markers; persist recomputes doneSteps from DONE entries.
		const finalizeCancel = async (): Promise<{
			acknowledged: true;
			encodingJobId: string;
			status: string;
		}> => {
			const { terminal } = await stopJobEncodings(entries, ids, sdk);
			// : stamp the row's OWN pointer, and only when the provider
			// showed that encoding terminal — a later retry re-points the row
			// and the stamp stops matching by construction (rev425 C1).
			const pointer =
				(
					await deps.prisma.encodingJob.findUnique({
						where: { id: encodingJobId },
						select: { bitmovinEncodingId: true },
					})
				)?.bitmovinEncodingId ?? null;
			await persist(encodingJobId, entries, {
				status: "CANCELED",
				error: null,
				encoderStoppedConfirmedFor:
					pointer && terminal.has(pointer) ? pointer : null,
			});
			await deps.emitEvent?.({
				kind: "JOB_CANCELED",
				jobId: encodingJobId,
				name: row.name,
				labels: row.labels,
				path: `/vod/jobs/${encodingJobId}`,
			});
			return { acknowledged: true, encodingJobId, status: "CANCELED" };
		};

		// Loop-top check: a cancel requested before any step runs (e.g. a QUEUED
		// job canceled before the worker picked it) → CANCELED immediately, before
		// the RUNNING flip, stopping nothing (no encoding created yet).
		if (await checkCancel()) {
			return await finalizeCancel();
		}

		{
			const next = new Date(new Date(deps.now()).getTime());
			const { count } = await deps.prisma.encodingJob.updateMany({
				where: { id: encodingJobId, attemptClaimedAt: heldAt },
				data: {
					status: "RUNNING",
					bitmovinAccountId: accountId,
					error: null,
					attemptClaimedAt: next,
				},
			});
			if (count === 0) {
				console.warn(new AttemptLeaseLostError(encodingJobId).message);
				return { acknowledged: true, encodingJobId, status: "LEASE_LOST" };
			}
			heldAt = next;
			resetOwner.ownerToken = next.toISOString();
		}

		const ctx = {
			sdk,
			ids,
			resolveCredential: deps.resolveCredential,
			poll: {
				intervalMs: deps.pollIntervalMs,
				timeoutMs: deps.pollTimeoutMs,
				// The wake variant closes over the RUN's resource ids; a signal
				// for any of them (in practice: the encoding) cuts one sleep
				// short. Poll semantics and writership are unchanged (#16).
				// Built by the extracted seam so the absent/present contract is
				// PINNED (review-186 I1: the inline ternary was dead code under
				// the whole suite — even a throwing sleep survived 842/842).
				// Heartbeat on the same tick the poll already waits for, so an
				// encode that legitimately runs for hours keeps its lease while a
				// dead worker's stops being renewed at once (CRITICAL-1).
				sleep: (async (ms: number) => {
					await pollSleepFor(deps, ids)(ms);
					if (!(await renewLease())) {
						throw new AttemptLeaseLostError(encodingJobId);
					}
				}) as (ms: number) => Promise<void>,
			},
			// AWAIT_ENCODING polls this each interval; a long await is interrupted
			// promptly (CancelRequested) instead of running for minutes.
			shouldCancel: checkCancel,
		};

		/**
		 * QC boundary : decides what happens
		 * when the loop reaches the first phase:"post-qc" step. Reads the AUTO
		 * VmafJob for this encoding — the vmaf-runner writes gateVerdict
		 * atomically with its FINISHED status, so a FINISHED row either carries
		 * the verdict or predates the gate (fail-closed below). ("LATEST" until
		 * review-258 122-A2 scoped it, and the docblock kept saying LATEST for
		 * five days after the code stopped doing it.)
		 */
		const resolveQcBoundary = async (): Promise<
			{ kind: "pass" } | { kind: "wait" } | { kind: "fail"; reason: string }
		> => {
			const vmaf = await deps.prisma.vmafJob.findFirst({
				// review-258 122-A2: scoped to the AUTO row — the reader asks
				// for its own writer's row instead of "the latest", which was
				// only safe while the auto trigger was the sole writer of
				// encodingJobId-bearing rows. 's lab-manual rows now
				// share that space (an operator-chosen model, params {}), and
				// tier 2 contemplates admitting jobs before FINISHED; without
				// this scope, a lab row would read as "predates the gate" and
				// fail-closed a job that already passed.
				where: {
					encodingJobId,
					triggerKey: autoTriggerKey(encodingJobId),
				},
				orderBy: { createdAt: "desc" },
				select: { status: true, gateVerdict: true, error: true },
			});
			if (!vmaf) {
				//  / review-265 131-A1: with QC/VMAF off, no
				// measurement is EVER coming — the trigger creates nothing —
				// so waiting means parking the job forever in a state whose
				// only release (the override button) is QC_FAILED-only. Make
				// the setting an OUTCOME instead: the job lands QC_FAILED
				// with the reason, the override appears, and the documented
				// recovery path works unchanged. Checked only when there is
				// no AUTO row, so a job whose measurement is already running
				// still waits for it even if the flag flips mid-run.
				// EXPLICIT false only (review-265 131-B1): null means the
				// setting could not be read, and waiting is the recoverable
				// direction — the trigger creates the row as soon as the read
				// works, whereas a wrong fail needs a forced delivery to undo.
				if ((await qcVmafEnabled(deps.prisma)) === false) {
					return {
						kind: "fail",
						reason:
							"QC/VMAF is turned off for this deployment — no measurement will be produced. Deliver anyway to release this job, or enable QC/VMAF in Settings and re-run.",
					};
				}
				return { kind: "wait" };
			}
			if (vmaf.status === "PENDING" || vmaf.status === "RUNNING") {
				return { kind: "wait" };
			}
			if (vmaf.status !== "FINISHED") {
				// Measurement failed ≠ quality failed — both block, the error
				// string says which (design §6).
				return {
					kind: "fail",
					reason: `QC measurement failed: ${vmaf.error ?? "VMAF run errored"}`,
				};
			}
			const verdict = vmaf.gateVerdict as QcVerdict | null;
			if (!verdict) {
				// A FINISHED measurement with no verdict on a gate plan means the
				// runner predates the gate or crashed mid-write — refuse loudly,
				// never deliver on missing data.
				return {
					kind: "fail",
					reason: "QC verdict missing on a finished measurement",
				};
			}
			if (verdict.pass) {
				return { kind: "pass" };
			}
			const failed = verdict.ruleResults.filter((r) => !r.pass).length;
			return {
				kind: "fail",
				reason: `QC gate failed: ${failed} of ${verdict.ruleResults.length} rule(s) below threshold`,
			};
		};

		// Cleared once per processing pass; the deferred group is gated as a
		// GROUP (the first post-qc step consults the verdict, the rest ride).
		let postQcCleared = false;

		try {
			for (const entry of entries) {
				if (entry.status === "DONE") {
					continue;
				}
				// Before-each-step check: honor a cancel that arrived between steps
				// before starting the next one. The job is already RUNNING here, so the
				// finalize flips it to CANCELED.
				if (await checkCancel()) {
					return await finalizeCancel();
				}
				if (entry.phase === "post-qc" && !postQcCleared) {
					// Override-and-deliver : the audited route flips
					// QC_FAILED→QUEUED and stamps qcOverriddenAt; from then on the
					// boundary runs the group WITHOUT consulting the verdict — the
					// verdict still stands in the report, delivery was forced past
					// it, and re-judging here would just park the job again.
					//
					// INVARIANT (review-203 F4, empirically refuted as a hole
					// today, pinned below): AWAITING_QC has exactly ONE writer —
					// this boundary — and the flag short-circuits before it, so a
					// flagged row can never re-park and a STALE flag can never
					// force-deliver a FUTURE verdict. Any second AWAITING_QC
					// writer added later must re-establish this or scope the flag
					// to a measurement id.
					if (row.qcOverriddenAt) {
						postQcCleared = true;
					}
				}
				if (entry.phase === "post-qc" && !postQcCleared) {
					const outcome = await resolveQcBoundary();
					if (outcome.kind === "wait") {
						// Park: deferred steps stay PENDING, the vmaf-runner's
						// continuation re-enqueues this job when the verdict lands.
						// Persist BEFORE firing the trigger — a fast measurement's
						// continuation must find AWAITING_QC or its claim no-ops and
						// nothing ever re-delivers the verdict.
						await persist(encodingJobId, entries, { status: "AWAITING_QC" });
						if (deps.onVodFinished) {
							try {
								await deps.onVodFinished({ encodingJobId, plan });
							} catch (hookErr) {
								// Unlike the FINISHED tail (best-effort), a trigger
								// failure HERE would park the job forever — no VmafJob
								// means no continuation. ERROR is the honest state, and
								// the retry route's ERROR→QUEUED path re-runs this
								// boundary (DONE steps skip) including the trigger.
								const message =
									hookErr instanceof Error
										? hookErr.message
										: "QC trigger failed";
								// The park RELEASED the lease, so this write's token is the
								// shared `null` — which a later attempt's own release also
								// writes. Review-322 C1 reproduced the interleaving: park →
								// trigger call in flight → another attempt claims, finishes
								// the whole job, releases → the trigger promise rejects → this
								// ERROR write matched `null` and landed a stale step log over
								// the finished row. The status is the guard: only a row still
								// PARKED can be errored by the attempt that parked it.
								const landed = await persistIf(
									encodingJobId,
									entries,
									{
										status: "ERROR",
										error: redactSecrets(`QC trigger failed: ${message}`),
									},
									{ status: "AWAITING_QC" },
								);
								if (!landed) {
									// Someone else owns the row now: no ERROR event about a job
									// they may have finished, and no rethrow — BullMQ's failed
									// handler would have nothing of ours to mark.
									return {
										acknowledged: true,
										encodingJobId,
										status: "LEASE_LOST",
									};
								}
								await deps.emitEvent?.({
									kind: "JOB_ERROR",
									jobId: encodingJobId,
									name: row.name,
									labels: row.labels,
									error: redactSecrets(`QC trigger failed: ${message}`),
									path: `/vod/jobs/${encodingJobId}`,
								});
								throw hookErr;
							}
						}
						return { acknowledged: true, encodingJobId, status: "AWAITING_QC" };
					}
					if (outcome.kind === "fail") {
						// QC_FAILED, never ERROR — a correct measurement of a bad
						// encode is not a malfunction (the #42 lesson). Deferred
						// steps stay PENDING so PR4's audited override is a plain
						// resume.
						await persist(encodingJobId, entries, {
							status: "QC_FAILED",
							error: redactSecrets(outcome.reason),
						});
						await deps.emitEvent?.({
							kind: "JOB_QC_FAILED",
							jobId: encodingJobId,
							name: row.name,
							labels: row.labels,
							reason: redactSecrets(outcome.reason),
							path: `/vod/jobs/${encodingJobId}`,
						});
						return { acknowledged: true, encodingJobId, status: "QC_FAILED" };
					}
					postQcCleared = true;
				}
				// RUNNING here means a previous attempt crashed between the SDK
				// call and the DONE write. START_* ops verify resource status
				// before re-starting (wedge prevention); create ops re-execute —
				// accepted P1 risk: benign orphan resources in the Bitmovin
				// account (dedup via customData is a P2 follow-up).
				const wasRunning = entry.status === "RUNNING";
				const hadStartAttempt = entry.startedAt !== undefined;
				const wasVerificationCreateAttempt =
					isVerificationRun &&
					entry.kind === "CREATE_ENCODING" &&
					(entry.startedAt !== undefined || entry.finishedAt !== undefined);
				entry.status = "RUNNING";
				entry.startedAt = deps.now();
				entry.error = undefined;
				await persist(encodingJobId, entries);

				try {
					activeEntry = entry;
					stampStep = entry.step;
					// `/retry` reseeds FAILED/RUNNING to PENDING but deliberately
					// preserves its timing. For a verification provider CREATE, that
					// still means the request may have committed before its response
					// was lost. Reconcile the exact marker; never POST beside it.
					stampAdopt = wasRunning || wasVerificationCreateAttempt;
					/**
					 * the ONE recovery that is not a retry. When a start
					 * dies of the measured 500/1004 signature AFTER the ladder has
					 * exhausted, and the request carried JIT manifest lists, the same
					 * artefacts are reachable by starting plainly and generating those
					 * manifests afterwards. The downgrade rewrites this step and
					 * APPENDS the manifest steps to `entries` — which this very loop
					 * then executes, because a for…of array iterator re-reads length.
					 */
					let jitNote: JitFallbackNote | undefined;
					let result: Awaited<ReturnType<typeof executeStep>>;
					try {
						result = await executeStep(entry, ctx, { wasRunning });
					} catch (stepErr) {
						const outcome = planJitFallback(stepErr, entry, plan, entries);
						if (!outcome?.ok) {
							// A NAMED decline is operator-visible (review-208b I1): four
							// of the six reasons mean "we could have recovered and
							// deliberately did not", and without this the job looks
							// exactly like one where the fallback was never wired.
							if (outcome && !outcome.ok) {
								console.warn(
									`[orchestrator] ${encodingJobId}: start refused 1004 and the JIT downgrade DECLINED (${outcome.reason}) — failing the step`,
								);
							}
							throw stepErr;
						}
						const downgrade = outcome;
						plan = downgrade.plan;
						jitNote = applyJitFallback(
							downgrade,
							entries,
							stepErr instanceof BitmovinCallError
								? stepErr.requestId
								: undefined,
						);
						console.warn(
							`[orchestrator] ${encodingJobId}: start refused 1004 after the retry ladder — downgrading JIT manifests to POST_ENCODING (appending ${jitNote.appendedSteps.join(", ")})`,
						);
						// Persist the new plan, the appended steps, the corrected
						// totalSteps AND the reason BEFORE re-executing (review-208
						// I3/I4). Crash-safety is only half of it: if the retry below
						// also fails, the failure path writes a FAILED start — and
						// without this write the row would carry a POST_ENCODING plan,
						// N new PENDING steps, and no record anywhere of why.
						entry.response = redactSecrets({ jitDowngrade: jitNote });
						await persist(encodingJobId, entries, {
							plan: plan as unknown as Prisma.InputJsonValue,
							totalSteps: entries.length,
						});
						result = await executeStep(entry, ctx, { wasRunning });
					}
					stampStep = undefined;
					stampAdopt = false;
					activeEntry = undefined;
					entry.status = "DONE";
					entry.finishedAt = deps.now();
					entry.resourceId = result.resourceId;
					entry.request = redactSecrets(result.request);
					entry.response = redactSecrets(result.response);
					/**
					 * A downgrade recorded by an EARLIER attempt must survive this
					 * write (review-208b I4): a crash between the pre-execute persist
					 * and the retry leaves the note on a RUNNING entry, and the
					 * resume — which never re-enters the fallback, the plan already
					 * being POST_ENCODING — would otherwise overwrite the only record
					 * that the plan was rewritten at all.
					 */
					const priorNote =
						typeof entry.response === "object" && entry.response !== null
							? (entry.response as { jitDowngrade?: unknown }).jitDowngrade
							: undefined;
					if (!jitNote && priorNote !== undefined) {
						const body =
							typeof result.response === "object" && result.response !== null
								? (result.response as Record<string, unknown>)
								: { result: result.response };
						entry.response = redactSecrets({
							...body,
							jitDowngrade: priorNote,
						});
					}
					if (jitNote) {
						// WHY the plan changed, on the step that changed it — the
						// persisted plan alone shows POST_ENCODING with no account of
						// how it got there. (The pre-execute write above already put
						// the note on the entry; this re-attaches it beside the real
						// response, which the success path has just overwritten.)
						const body =
							typeof result.response === "object" && result.response !== null
								? (result.response as Record<string, unknown>)
								: { result: result.response };
						entry.response = redactSecrets({ ...body, jitDowngrade: jitNote });
					}
					if (result.resourceId) {
						ids.set(entry.step, result.resourceId);
					}
					// `encoding` is the step id only when the plan carries no explicit
					// `encodings` array. One explicitly-named encoding compiles to
					// `encoding:<key>`, so keying on the literal id left
					// `bitmovinEncodingId` null and both reprioritize and reschedule (NOT
					// reprioritize, reschedule, transfer retry) 409'd on an ordinary
					// single-encoding job with an unambiguous id — reprioritize and
					// reschedule, NOT cancel, which is a pure flag claim that never reads
					// this column (review catch). A
					// ladder still leaves it null: `soleEncodingStep` is deliberately
					// silent there, and denormalizing one sibling would point the
					// actions at the wrong encoding.
					const extra =
						entry.step === soleStep && result.resourceId
							? {
									bitmovinEncodingId: result.resourceId,
									// rev431: see the early persist above — same reason.
									encoderStoppedConfirmedFor: null,
								}
							: {};
					await persist(encodingJobId, entries, extra);
				} catch (err) {
					stampStep = undefined;
					stampAdopt = false;
					activeEntry = undefined;
					if (
						err instanceof AttemptLeaseLostError ||
						err instanceof VerificationProviderOwnershipLostError
					) {
						// Not a step failure. Re-raise BEFORE anything below runs:
						// marking FAILED/ERROR, stopping siblings, emitting JOB_ERROR
						// and persisting THIS attempt's now-stale entries would all
						// land on a job another worker is running correctly.
						throw err instanceof AttemptLeaseLostError
							? err
							: new AttemptLeaseLostError(encodingJobId);
					}
					// Cancellation is not a failed step. Preserve uncertain START
					// attempts so recovery never treats a sent request as unsent.
					if (err instanceof CancelRequested) {
						if (
							entry.kind !== "START_ENCODING" ||
							(err.beforeSend && !hadStartAttempt)
						) {
							entry.status = "PENDING";
							entry.startedAt = undefined;
						}
						entry.error = undefined;
						return await finalizeCancel();
					}
					const message = err instanceof Error ? err.message : "step failed";
					if (err instanceof VerificationProviderIdPersistenceError) {
						// The callback learned this id directly from the CREATE response.
						// Its first durable write failed, but the failure-path write below
						// is a second chance to retain both the exact id and what bounded
						// compensation actually achieved. Recovery must distinguish a
						// successfully deleted id (prove it with provider 404) from an
						// unresolved create; prose in `error` is not machine authority.
						entry.resourceId = err.providerId;
						entry.response = redactSecrets({
							providerId: err.providerId,
							source: err.source,
							durability: err.durability,
							compensation: err.compensation,
						});
					}
					entry.status = "FAILED";
					entry.finishedAt = deps.now();
					entry.error = redactSecrets(message);
					// ORCHESTRATOR CONTRACT (compiler await-emission site): when one
					// AWAIT_ENCODING fails, sibling encodings of the same plan are
					// still RUNNING (and billing) — stop them before failing the
					// job, mirroring the ladder scripts' _stop_encodings. The stops
					// land on the failed entry's response snapshot (step log).
					if (entry.kind === "AWAIT_ENCODING") {
						const stopped = await stopSiblingEncodings(
							entry,
							entries,
							ids,
							sdk,
						);
						if (stopped.length > 0) {
							entry.response = redactSecrets({ stoppedSiblings: stopped });
						}
					}
					await persist(encodingJobId, entries, {
						status: "ERROR",
						error: redactSecrets(message),
					});
					await deps.emitEvent?.({
						kind: "JOB_ERROR",
						jobId: encodingJobId,
						name: row.name,
						labels: row.labels,
						error: redactSecrets(message),
						path: `/vod/jobs/${encodingJobId}`,
					});
					throw err;
				}
			}

			await persist(encodingJobId, entries, { status: "FINISHED" });
			await deps.emitEvent?.({
				kind: "JOB_FINISHED",
				jobId: encodingJobId,
				name: row.name,
				labels: row.labels,
				// review-203 N6: a FORCED delivery must be distinguishable on the
				// bus — a downstream consumer treating JOB_FINISHED as "gate
				// passed" would otherwise read an override as a pass.
				...(row.qcOverriddenAt ? { overridden: true } : {}),
				path: `/vod/jobs/${encodingJobId}`,
			});

			// VOD completion hook (VMAF trigger). Best-effort: the encoding is
			// already FINISHED and persisted; a trigger failure is logged and
			// swallowed so it can never revert a green encoding to ERROR.
			if (deps.onVodFinished) {
				try {
					await deps.onVodFinished({ encodingJobId, plan });
				} catch (hookErr) {
					console.error(
						`[orchestrator] onVodFinished hook failed for ${encodingJobId}:`,
						hookErr instanceof Error ? hookErr.message : hookErr,
					);
				}
			}

			return { acknowledged: true, encodingJobId, status: "FINISHED" };
		} catch (err) {
			if (err instanceof AttemptLeaseLostError) {
				/**
				 * Another worker owns this job. Return QUIETLY — exactly as the
				 * top-of-function loser does when its claim finds count 0.
				 *
				 * Not rethrown: BullMQ's `failed` handler flips a QUEUED/RUNNING
				 * row to ERROR with no ownership check and then stops its
				 * encodings, so a rethrow here would have the LOSER mark the
				 * WINNER's job broken and stop the winner's encoding.
				 */
				console.warn(err.message);
				return { acknowledged: true, encodingJobId, status: "LEASE_LOST" };
			}
			throw err;
		}
	};
	return async (jobData: unknown) => {
		const owner: ResetOwnerState = {
			entityKey: "",
			ownerToken: null,
			entries: [],
		};
		try {
			return await process(jobData, owner);
		} finally {
			await finishResetOwner(
				deps,
				owner,
				async () =>
					!(await deps.prisma.encodingJob.findUnique({
						where: { id: owner.entityKey.slice("encodingJob:".length) },
						select: { id: true },
					})),
			);
		}
	};

	/**
	 * Cancel finalize : stops EVERY CREATE_ENCODING of the job that
	 * is still QUEUED/RUNNING on Bitmovin — best-effort. A stop failure (or a
	 * status probe failure) is logged and swallowed, NEVER thrown: the local
	 * CANCELED transition must still happen even if Bitmovin refuses the stop.
	 * Encodings never created (no id in `ids`) or already terminal are skipped,
	 * so a job canceled before any encoding started stops nothing. Unlike
	 * stopSiblingEncodings (which excludes the failed await's own encoding),
	 * this stops all of them — cancel takes the whole job down.
	 */
	/**
	 * the stop's OUTCOME is returned, not just attempted. `confirmed`
	 * is true only when every created encoding was SEEN terminal — either
	 * already terminal before the stop, or terminal on the readback after the
	 * stop call — so a stop that failed, or one the provider had not applied
	 * by the readback, leaves the job unconfirmed and the reset keeps blocking
	 * on its pointer. The reconcile
	 * route can confirm it later from the provider's own status.
	 */
	/**
	 * Stops the job's QUEUED/RUNNING encodings and reports which encoding ids
	 * the provider showed TERMINAL (FINISHED/ERROR/CANCELED) — already
	 * terminal, or terminal on the readback after the stop. A CREATED
	 * encoding is neither stopped nor terminal (a retry can still start it),
	 * and a failed stop or readback proves nothing for that id: only proof
	 * reaches the reset's stamp .
	 */
	async function stopJobEncodings(
		entries: StepLogEntry[],
		ids: Map<string, string>,
		sdk: SdkOps,
	): Promise<{ terminal: Set<string> }> {
		const terminal = new Set<string>();
		for (const entry of entries) {
			if (entry.kind !== "CREATE_ENCODING") {
				continue;
			}
			const encodingId = ids.get(entry.step);
			if (!encodingId) {
				continue; // never created — nothing to stop
			}
			try {
				const before = (await sdk.getEncodingStatus(encodingId)).status;
				if (classifyProviderStatusWord(before) === "TERMINAL") {
					terminal.add(encodingId); // already terminal — leave it
					continue;
				}
				if (before !== "QUEUED" && before !== "RUNNING") {
					continue; // CREATED or unclassified: nothing to stop, nothing proven
				}
				await sdk.stopEncoding(encodingId);
				const after = (await sdk.getEncodingStatus(encodingId)).status;
				if (classifyProviderStatusWord(after) === "TERMINAL") {
					terminal.add(encodingId);
				}
				// else: accepted, not yet applied — unproven, no stamp
			} catch (stopErr) {
				console.error(
					`[orchestrator] cancel: failed to stop encoding ${encodingId}:`,
					stopErr instanceof Error ? stopErr.message : stopErr,
				);
			}
		}
		return { terminal };
	}

	/**
	 * Stops every other CREATE_ENCODING of the job that is still
	 * QUEUED/RUNNING. Stop errors are logged into the result (and the
	 * console), never thrown — the original await failure must surface.
	 */
	async function stopSiblingEncodings(
		failedAwait: StepLogEntry,
		entries: StepLogEntry[],
		ids: Map<string, string>,
		sdk: SdkOps,
	): Promise<Record<string, unknown>[]> {
		const ownEncodingStep =
			typeof failedAwait.refs.encodingId === "string"
				? failedAwait.refs.encodingId
				: undefined;
		const stopped: Record<string, unknown>[] = [];
		for (const entry of entries) {
			if (entry.kind !== "CREATE_ENCODING" || entry.step === ownEncodingStep) {
				continue;
			}
			const encodingId = ids.get(entry.step);
			if (!encodingId) {
				continue; // never created — nothing to stop
			}
			try {
				const task = await sdk.getEncodingStatus(encodingId);
				if (task.status !== "QUEUED" && task.status !== "RUNNING") {
					continue;
				}
				await sdk.stopEncoding(encodingId);
				stopped.push({ step: entry.step, encodingId, status: task.status });
			} catch (stopErr) {
				const reason =
					stopErr instanceof Error ? stopErr.message : "stop failed";
				console.error(
					`[orchestrator] failed to stop sibling encoding ${encodingId}:`,
					reason,
				);
				stopped.push({
					step: entry.step,
					encodingId,
					error: redactSecrets(reason),
				});
			}
		}
		return stopped;
	}
}
