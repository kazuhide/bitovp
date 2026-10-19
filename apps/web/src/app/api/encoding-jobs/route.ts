import {
	masterKeyFromEnv,
	submitEncodingJob,
	VERIFICATION_DISPATCH_FENCE_REJECTED,
	VERIFICATION_DISPATCH_FENCE_REQUIRED,
	VERIFICATION_KEY_SHA_CONFLICT,
	VERIFICATION_REQUEST_SHA_MISMATCH,
	verificationRequestBodySha256,
} from "@bitovp/core";
import type { EncodingJobStatus, Prisma } from "@bitovp/db";
import { listVmafCloudProfiles } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFrom } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import {
	type CreateRequestIdentity,
	createRequestConflictResponse,
	createRequestGoneResponse,
	createRequestIdentity,
	InvalidCreateRequestError,
	isCreateRequestUniqueConflict,
	lookupCreateRequest,
	recordCreateRequest,
} from "@/lib/server/create-request";
import { readFeatureFlags } from "@/lib/server/feature-flags";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import {
	recordUnrestrictedEgress,
	submitterValidationOptions,
} from "@/lib/server/plan-validation";
import { getOrchestratorQueue } from "@/lib/server/queue";
import {
	assertVerificationDispatchFence,
	VerificationDispatchFenceError,
} from "@/lib/server/verification-dispatch";
import {
	isVerificationKeyConflict,
	VERIFICATION_DISPATCH_KEY_PAIR_MESSAGE,
	VERIFICATION_KEY_FIELDS,
	VERIFICATION_KEY_PAIR_MESSAGE,
	verificationDispatchHasKeyPair,
	verificationKeyPairComplete,
	verificationReplay,
} from "@/lib/server/verification-key";

/**
 * `presetId`+`presetRevision`: template provenance from the
 * launcher — both-or-neither. The revision is CLIENT-supplied by design: it is
 * the revision the launcher LOADED (the body it instantiated), which a
 * template edit racing the launch would misreport if the server re-read it.
 *
 * `verificationKey`+`requestSha256`: the
 * verification harness's idempotency pair — see `verification-key.ts`.
 */
const bodySchema = z
	.object({
		plan: z.unknown(),
		presetId: z.uuid().optional(),
		presetRevision: z.number().int().min(1).optional(),
		...VERIFICATION_KEY_FIELDS,
	})
	.refine(
		(v) => (v.presetId === undefined) === (v.presetRevision === undefined),
		{
			message: "presetId and presetRevision go together",
		},
	)
	.refine(verificationKeyPairComplete, {
		message: VERIFICATION_KEY_PAIR_MESSAGE,
	})
	.refine(verificationDispatchHasKeyPair, {
		message: VERIFICATION_DISPATCH_KEY_PAIR_MESSAGE,
	});

const LIST_SELECT = {
	id: true,
	name: true,
	labels: true,
	status: true,
	region: true,
	doneSteps: true,
	totalSteps: true,
	error: true,
	bitmovinEncodingId: true,
	bitmovinAccountId: true,
	// QC gate verdict : the list renders PASS/FAIL from its
	// `pass` field, and the GET mapper below projects the row down to
	// exactly that (review-202 N3: the earlier comment claimed the detail
	// panel reused this cache — it does not, it has its own findUnique —
	// and a 3-rule × 6-rung ladder is ~18 actuals per row × 100 rows of
	// payload nobody reads).
	qcVerdict: true,
	createdAt: true,
	updatedAt: true,
	// : the Duration column derives from THIS, not updatedAt —
	// any late writer (a MARK_ONLY VMAF verdict, a snapshot backfill)
	// rewrites updatedAt and silently inflates a displayed run time.
	finishedAt: true,
} as const;

// @bitovp/db re-exports enums as TYPES only (runtime client is sealed), so the
// filter accepts a local tuple. `satisfies` guards that every tuple member is a
// valid status; the second annotation guards the reverse — that the tuple stays
// exhaustive — so adding an enum value without updating this list won't compile.
const ENCODING_JOB_STATUSES = [
	"DRAFT",
	"QUEUED",
	"RUNNING",
	"AWAITING_QC",
	"FINISHED",
	"ERROR",
	"CANCELED",
	"QC_FAILED",
] as const satisfies readonly EncodingJobStatus[];
type _StatusesExhaustive =
	Exclude<
		EncodingJobStatus,
		(typeof ENCODING_JOB_STATUSES)[number]
	> extends never
		? true
		: ["status filter tuple is missing", EncodingJobStatus];
const _statusesExhaustive: _StatusesExhaustive = true;
void _statusesExhaustive;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	// Filters compose with cursor pagination. Invalid status → 400
	// (validationError); an empty/absent label is simply ignored.
	status: z.enum(ENCODING_JOB_STATUSES).optional(),
	/** QC gate outcome filter : pass | fail. Jobs without a
	 * verdict match neither — the filter answers "what did the gate say",
	    and silence is not an answer. */
	qc: z.enum(["pass", "fail"]).optional(),
	label: z.string().min(1).optional(),
});

/** Lean projection (never plan/stepLog/snapshots in lists — schema contract). */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		status: url.searchParams.get("status") ?? undefined,
		qc: url.searchParams.get("qc") ?? undefined,
		label: url.searchParams.get("label") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor, status, qc, label } = parsed.data;
	const where: Prisma.EncodingJobWhereInput = {
		...(status ? { status } : {}),
		...(label ? { labels: { has: label } } : {}),
		// Json-path filter on the verdict's `pass`. Verdict-less rows (null
		// column) match neither value — deliberate, see the schema comment.
		// VERIFIED against real Postgres 17 (review-202 N5), not just the
		// mocked where-object: three rows (pass/fail/null) in a throwaway DB
		// with this branch's migrations applied — qc=pass matched only the
		// pass row, qc=fail only the fail row, the null row neither. No index
		// backs the path predicate; ledger row 86 carries the at-scale note.
		...(qc ? { qcVerdict: { path: ["pass"], equals: qc === "pass" } } : {}),
	};
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.encodingJob.findMany({
			where,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: LIST_SELECT,
		});
		const items = rows.slice(0, limit).map((row) => ({
			...row,
			// Projection, not the whole verdict (review-202 N3).
			qcVerdict: row.qcVerdict
				? { pass: (row.qcVerdict as { pass?: unknown }).pass === true }
				: null,
		}));
		return NextResponse.json({
			items,
			nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
		});
	} catch (err) {
		return routeError(err);
	}
}

/**
 * EV-01: the row a repeated verification key already created, if any.
 * `verificationReplay` decides between replay (same SHA) and 409.
 */
async function verificationKeyLookup(
	prisma: Awaited<ReturnType<typeof getServerContext>>["prisma"],
	verificationKey: string,
	requestSha256: string,
) {
	const existing = await prisma.encodingJob.findUnique({
		where: { verificationKey },
		select: { ...LIST_SELECT, verificationRequestSha256: true },
	});
	return verificationReplay(existing, requestSha256);
}

function verificationKeyResponse(
	verdict: Awaited<ReturnType<typeof verificationKeyLookup>>,
	verificationKey: string,
) {
	if (verdict.kind === "replay") {
		// The resource the caller already paid for, not a twin. 200, not 201:
		// nothing was created by THIS request.
		return NextResponse.json(
			{ ...verdict.row, issues: [], replayed: true },
			{ status: 200 },
		);
	}
	if (verdict.kind === "conflict") {
		return jsonError(
			409,
			"verificationKey was already used for a different request",
			{ code: VERIFICATION_KEY_SHA_CONFLICT, verificationKey },
		);
	}
	return undefined;
}

/** A receipt remains spent even when its resource has been deleted. */
async function ordinaryCreateReplay(
	prisma: Awaited<ReturnType<typeof getServerContext>>["prisma"],
	identity: CreateRequestIdentity,
) {
	const receipt = await lookupCreateRequest(prisma, "VOD_JOB", identity);
	if (receipt.kind === "none") return undefined;
	if (receipt.kind === "conflict") return createRequestConflictResponse();
	const row = await prisma.encodingJob.findUnique({
		where: { id: receipt.resourceId },
		select: LIST_SELECT,
	});
	if (!row) return createRequestGoneResponse();
	return NextResponse.json(
		{ ...row, issues: [], replayed: true },
		{ status: 200 },
	);
}

/**
 * Creates a job through CORE's submitEncodingJob ( PR1 — ONE
 * pipeline; reRunJob and the watch-folder sweep are the other callers).
 * This route owns the HTTP mapping and the web-process deps only.
 */
export async function POST(req: Request) {
	const rawBody = await readJson(req);
	const body = bodySchema.safeParse(rawBody);
	if (!body.success) {
		return validationError(body.error);
	}
	let ordinaryIdentity: CreateRequestIdentity | undefined;
	let ordinaryContext: Awaited<ReturnType<typeof getServerContext>> | undefined;
	try {
		ordinaryIdentity = createRequestIdentity(req, body.data);
	} catch (err) {
		if (err instanceof InvalidCreateRequestError)
			return jsonError(
				400,
				"Invalid Idempotency-Key or conflicting verification fields",
			);
		throw err;
	}
	const { verificationKey, requestSha256, verificationDispatch } = body.data;
	if (
		verificationKey !== undefined &&
		requestSha256 !== undefined &&
		verificationRequestBodySha256(rawBody) !== requestSha256
	) {
		return jsonError(400, "requestSha256 does not match the request body", {
			code: VERIFICATION_REQUEST_SHA_MISMATCH,
			verificationKey,
		});
	}
	try {
		const ctx = await getServerContext();
		if (ordinaryIdentity) {
			ordinaryContext = ctx;
			const replay = await ordinaryCreateReplay(ctx.prisma, ordinaryIdentity);
			if (replay) return replay;
		}
		// A replay needs no decryption; a new job must fail before persisting
		// QUEUED state if the worker would not be able to decrypt its secrets.
		masterKeyFromEnv();
		if (verificationKey !== undefined && requestSha256 !== undefined) {
			// EV-01: a repeat of a key this deployment already honoured answers
			// with that row (or 409) BEFORE anything is validated or created —
			// the harness whose response was lost must get its job back, never
			// a second paid one.
			const replay = verificationKeyResponse(
				await verificationKeyLookup(ctx.prisma, verificationKey, requestSha256),
				verificationKey,
			);
			if (replay) {
				return replay;
			}
			if (verificationDispatch === undefined) {
				return jsonError(
					409,
					"a current verification dispatch fence is required for a new paid resource",
					{
						code: VERIFICATION_DISPATCH_FENCE_REQUIRED,
						verificationKey,
					},
				);
			}
		}
		if (body.data.presetId !== undefined) {
			// FK would reject an unknown id anyway (P2003 → 500); refuse it as
			// a client error instead, scoped to plan templates like the rest
			// of the /api/presets family.
			const preset = await ctx.prisma.preset.findFirst({
				where: { id: body.data.presetId, kind: "FULL_PLAN" },
				select: { id: true },
			});
			if (!preset) {
				return jsonError(400, "Unknown template");
			}
		}
		const outcome = await submitEncodingJob(body.data.plan, {
			internalHevcV2AccountId: process.env.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
			//  (review-265 131-A2): the gate rides the SHARED
			// submit path now, so every door obeys it — this route, re-run,
			// bulk re-run and the watch sweep.
			qcVmafEnabled: async () => (await readFeatureFlags(ctx.prisma)).qcVmaf,
			cloudVmafProfileAvailable: async (profileId) =>
				(
					await listVmafCloudProfiles(
						ctx.prisma,
						process.env.VMAF_COMPUTE_PROFILES,
					)
				).some((profile) => profile.id === profileId),
			...(body.data.presetId !== undefined &&
			body.data.presetRevision !== undefined
				? {
						provenance: {
							presetId: body.data.presetId,
							presetRevision: body.data.presetRevision,
						},
					}
				: {}),
			validationOptions: await submitterValidationOptions(
				ctx.prisma,
				ctx.credentials,
			),
			recordEgress: (issues, bitmovinAccountId) =>
				recordUnrestrictedEgress(ctx.prisma, issues, {
					path: "/api/encoding-jobs",
					bitmovinAccountId,
					actor: actorFrom(req),
				}),
			loadAccountDefaults: (accountId) => ctx.bitmovinAccounts.get(accountId),
			createJob: async (data) => {
				const createArgs = {
					data: {
						...data,
						// #32 §5: who created this job — user:<id> / token:<id>.
						createdBy: actorFrom(req),
						plan: data.plan as unknown as Prisma.InputJsonValue,
						stepLog: data.stepLog as unknown as Prisma.InputJsonValue,
						// EV-01: the harness's key and its digest of this request,
						// stamped in the SAME insert as the row — so a row that
						// exists carries its key, with no window in between.
						...(verificationKey !== undefined && requestSha256 !== undefined
							? {
									verificationKey,
									verificationRequestSha256: requestSha256,
								}
							: {}),
					},
					select: { id: true },
				} satisfies Prisma.EncodingJobCreateArgs;
				if (
					ordinaryIdentity ||
					(verificationKey !== undefined &&
						requestSha256 !== undefined &&
						verificationDispatch !== undefined)
				) {
					return ctx.prisma.$transaction(async (tx) => {
						if (
							verificationKey !== undefined &&
							requestSha256 !== undefined &&
							verificationDispatch !== undefined
						) {
							await assertVerificationDispatchFence(tx, {
								fence: verificationDispatch,
								kind: "VOD_JOB",
								verificationKey,
								requestSha256,
							});
						}
						const row = await tx.encodingJob.create(createArgs);
						if (ordinaryIdentity)
							await recordCreateRequest(
								tx,
								"VOD_JOB",
								ordinaryIdentity,
								row.id,
							);
						return row;
					});
				}
				return ctx.prisma.encodingJob.create(createArgs);
			},
			enqueue: async (jobId) => {
				// A fenced create commits its local row while holding the parent run
				// lock. Recovery therefore sees and cancels that durable row before a
				// delayed enqueue; the processor's CANCELED guard forbids resurrection.
				await getOrchestratorQueue().add(
					"orchestrate",
					{ encodingJobId: jobId },
					{ jobId, removeOnComplete: 1000, removeOnFail: 1000 },
				);
			},
			markEnqueueFailed: async (jobId) => {
				// Recovery may have canceled the durable row while queue.add was in
				// flight. Only the original QUEUED state may become ERROR.
				await ctx.prisma.encodingJob.updateMany({
					where: { id: jobId, status: "QUEUED" },
					data: { status: "ERROR", error: "Enqueue failed — retry the job" },
				});
			},
		});
		if (!outcome.ok) {
			if (outcome.code === "PARSE") {
				return validationError(outcome.details as z.ZodError);
			}
			if (outcome.code === "QC_CLOUD_UNAVAILABLE") {
				return jsonError(503, outcome.message);
			}
			if (outcome.code === "QC_DISABLED") {
				// 422, not 400: the plan is well-formed and would be accepted
				// on a deployment with QC on — it is the SETTING that refuses.
				return jsonError(422, outcome.message);
			}
			return jsonError(
				400,
				outcome.message,
				outcome.issues ? { issues: outcome.issues } : undefined,
			);
		}
		// Re-read through the list projection so the response shape is
		// byte-identical to what this route always returned.
		const row = await ctx.prisma.encodingJob.findUniqueOrThrow({
			where: { id: outcome.id },
			select: LIST_SELECT,
		});
		return NextResponse.json(
			{ ...row, issues: outcome.issues },
			{
				status: 201,
			},
		);
	} catch (err) {
		if (
			ordinaryIdentity &&
			ordinaryContext &&
			isCreateRequestUniqueConflict(err)
		) {
			try {
				const replay = await ordinaryCreateReplay(
					ordinaryContext.prisma,
					ordinaryIdentity,
				);
				if (replay) return replay;
			} catch (lookupErr) {
				return routeError(lookupErr);
			}
		}
		if (err instanceof VerificationDispatchFenceError) {
			return jsonError(
				409,
				"verification dispatch authority changed; paid create refused",
				{
					code: VERIFICATION_DISPATCH_FENCE_REJECTED,
					...(verificationKey !== undefined ? { verificationKey } : {}),
				},
			);
		}
		if (
			verificationKey !== undefined &&
			requestSha256 !== undefined &&
			isVerificationKeyConflict(err)
		) {
			// EV-01: two sends of one key raced past the pre-check; the loser's
			// insert hit the unique key. The winner's row is this request's
			// answer — the same replay-or-409 decision, taken again.
			try {
				const replay = verificationKeyResponse(
					await verificationKeyLookup(
						(await getServerContext()).prisma,
						verificationKey,
						requestSha256,
					),
					verificationKey,
				);
				if (replay) {
					return replay;
				}
			} catch (lookupErr) {
				return routeError(lookupErr);
			}
		}
		return routeError(err);
	}
}
