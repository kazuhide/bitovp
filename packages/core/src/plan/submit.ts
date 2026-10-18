import { applyAccountDefaultsToPlan } from "./account-defaults";
import { compilePlan } from "./compiler";
import {
	checkDeliverySpec,
	DELIVERY_SPECS,
	deliverySpec,
} from "./delivery-presets";
import { isInternalHevcV2Account } from "./internal-hevc-v2";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { initStepLog, type StepLogEntry } from "./steplog";
import {
	type PlanIssue,
	type PlanValidationOptions,
	planHasErrors,
	validatePlan,
} from "./validate";

/**
 * THE job-submission pipeline  — one implementation, three
 * callers: POST /api/encoding-jobs, reRunJob, and the watch-folder sweep
 * (PR2). Extracted because the route and the re-run helper had already
 * drifted into two near-copies, and a third caller was the tipping point
 * (design §4).
 *
 * Core owns the LOGIC (parse → validate → inject account defaults →
 * compile → init step log); the caller owns the IO through `deps` —
 * persistence, queue, egress audit — so web and worker satisfy it without
 * core importing either. MASTER_KEY fail-fast stays with callers (the
 * route does it before invoking; so does the re-run route).
 *
 * Sequencing is the ROUTE's (its order is the API contract): validation
 * errors refuse BEFORE the egress record is filed, and a plan without an
 * account id refuses before it too. reRunJob previously filed the egress
 * record before its account-id check — for a validated plan missing an
 * account id it wrote one row this pipeline no longer writes; recorded
 * here rather than silently changed.
 *
 * Enqueue failure: the created row is marked ERROR (recoverable via
 * /retry) and the error RETHROWN — both existing callers surface it as a
 * 500 and the sweep will surface it as a failed sweep item.
 */

export type SubmitRefusal = {
	ok: false;
	code:
		| "PARSE"
		| "VALIDATION"
		| "DELIVERY_DEVIATION"
		| "NO_ACCOUNT_ID"
		| "ACCOUNT_MISSING"
		| "INTERNAL_FEATURE_DISABLED"
		| "QC_DISABLED"
		| "QC_CLOUD_UNAVAILABLE"
		| "QC_CLOUD_PROFILE_INVALID";
	message: string;
	details?: unknown;
	issues?: PlanIssue[];
};

export type SubmitSuccess = {
	ok: true;
	id: string;
	plan: EncodingPlan;
	issues: PlanIssue[];
};

export type SubmitOutcome = SubmitSuccess | SubmitRefusal;

/** The exact create payload — pinned by the cross-pinning test. */
export type EncodingJobCreateData = {
	name: string;
	status: "QUEUED";
	plan: EncodingPlan;
	stepLog: StepLogEntry[];
	bitmovinAccountId: string;
	region: string | null;
	/**
	 * Row-level copy of plan.bitmovin.labels. Before this pipeline existed
	 * NOTHING wrote the column at create — the jobs list's Labels column and
	 * ?label= filter ran over a field that stayed [] (latent gap, found while
	 * wiring watch:<rule> labels, ). One write site now.
	 */
	labels: string[];
	totalSteps: number;
	doneSteps: 0;
	/**
	 * Template provenance : a COPY record, not a live reference —
	 * the plan was snapshotted at launch and nothing reads through these at
	 * runtime. Null for non-template submissions. Both-or-neither.
	 */
	presetId: string | null;
	presetRevision: number | null;
};

export type SubmitEncodingJobDeps = {
	validationOptions: PlanValidationOptions;
	/** Absent means disabled, including replay/watch/copy submission paths. */
	internalHevcV2AccountId?: string;
	/**
	 * , review-265 131-A2: the QC/VMAF feature gate, asked HERE
	 * rather than at one route.
	 *
	 * The first cut refused a qc-bearing plan in `POST /api/encoding-jobs`
	 * only — and four other doors reach this same function with a plan they
	 * did not author: re-run-as-new, bulk-re-run, the watch-folder sweep (a
	 * 30-second unattended loop) and re-arm. With QC off, each of them minted
	 * jobs that park at AWAITING_QC forever. The population is submissions,
	 * so the rule belongs where they converge.
	 *
	 * Absent ⇒ no gate (the corpus runner and the fixtures submit plans with
	 * no app-settings row behind them).
	 */
	qcVmafEnabled?: () => Promise<boolean>;
	/** Cloud selection must resolve an enabled tenant profile before creating any job.
	 * Absence or lookup failure refuses cloud work; legacy/LOCAL skips this IO. */
	cloudVmafProfileAvailable?: (profileId: string) => Promise<boolean>;
	/**
	 * Re-run only: do not re-litigate a delivery commitment recorded when the
	 * job was first submitted (the spec may have been tightened since).
	 */
	skipDeliveryCommitment?: boolean;
	/** C22 POLICY row — filed once the plan is ACCEPTED, before persisting. */
	recordEgress(issues: PlanIssue[], bitmovinAccountId: string): Promise<void>;
	/** null ⇒ the account does not exist (refusal, not throw). */
	loadAccountDefaults(accountId: string): Promise<{ defaults: unknown } | null>;
	createJob(data: EncodingJobCreateData): Promise<{ id: string }>;
	/**
	 * Template provenance to stamp on the row  — the launcher and
	 * the watch sweep pass the template they instantiated; ad-hoc submissions
	 * omit it. Per-request data riding deps, like skipDeliveryCommitment.
	 */
	provenance?: { presetId: string; presetRevision: number };
	enqueue(jobId: string): Promise<void>;
	/** Marks the created row ERROR after an enqueue failure (then rethrow). */
	markEnqueueFailed(jobId: string): Promise<void>;
};

/**
 * : enforce a plan's delivery commitment HERE, at the submit
 * boundary — not in `validatePlan`.
 *
 * validatePlan is dual-purpose: the wizard runs it live on every keystroke
 * and the server runs it as a gate. A policy commitment does not belong in
 * the client's structural rail (review-210 I3) — it made a delivery-carrying
 * plan unopenable in the wizard form and made the PRESET-SAVE route refuse a
 * spec-seeded template, contradicting `importDeliveryPreset`'s own policy
 * that a self-deviation does not reject an import.
 *
 * The refusal carries the deviations in `issues` AND spells them into
 * `message`, because the watch sweep persists only the message (review-210
 * C2): an unattended submitter must be able to act on it without opening
 * the UI.
 *
 * `onDeviation: "WARN"` downgrades EVERYTHING this check can say — including
 * an unknown spec id, which the first cut refused unconditionally because
 * the level was computed after that branch returned (review-210 C1).
 */
function deliveryVerdict(plan: EncodingPlan): {
	refusal?: SubmitRefusal;
	warnings?: PlanIssue[];
} {
	const commitment = plan.delivery;
	if (!commitment) {
		return {};
	}
	const warnOnly = commitment.onDeviation === "WARN";
	const spec = deliverySpec(commitment.specId);
	if (!spec) {
		const issue: PlanIssue = {
			code: "PLAN_DELIVERY_SPEC_UNKNOWN",
			level: warnOnly ? "warning" : "error",
			message: `unknown delivery spec "${commitment.specId}"`,
			path: "delivery.specId",
		};
		if (warnOnly) {
			// WARN RECORDS (review-210 I2): the first cut returned silently, so a
			// WARN commitment was byte-identical to no commitment for the one
			// submitter this feature exists for.
			return { warnings: [issue] };
		}
		return {
			refusal: {
				ok: false,
				code: "DELIVERY_DEVIATION",
				message: `plan.delivery.specId "${commitment.specId}" is not a known delivery spec (${DELIVERY_SPECS.map((s) => s.id).join(", ")})`,
				issues: [issue],
			},
		};
	}
	const deviations = checkDeliverySpec(plan, spec);
	if (deviations.length === 0) {
		return {};
	}
	const lines = deviations.map((d) => {
		const bound =
			d.expected.eq !== undefined
				? `= ${JSON.stringify(d.expected.eq)}`
				: d.expected.oneOf !== undefined
					? `one of ${JSON.stringify(d.expected.oneOf)}`
					: [
							d.expected.gte !== undefined ? `>= ${d.expected.gte}` : "",
							d.expected.lte !== undefined ? `<= ${d.expected.lte}` : "",
						]
							.filter(Boolean)
							.join(" and ") || "(no bound expressed)";
		return `${d.requirement} — ${d.path} expected ${bound}, plan has ${JSON.stringify(d.actual)}`;
	});
	const issues: PlanIssue[] = deviations.map((d, index) => ({
		code: "PLAN_DELIVERY_DEVIATION",
		level: warnOnly ? ("warning" as const) : ("error" as const),
		message: lines[index] as string,
		path: d.path,
	}));
	if (warnOnly) {
		return { warnings: issues };
	}
	return {
		refusal: {
			ok: false,
			code: "DELIVERY_DEVIATION",
			// A HEADLINE, not the whole list (review-210 I1): the sweep appends
			// the issues to the message it persists, so spelling them here
			// printed every deviation twice with a mangled separator.
			message: `Plan does not meet ${spec.name} (${deviations.length} deviation${deviations.length === 1 ? "" : "s"})`,
			issues,
		},
	};
}

export async function submitEncodingJob(
	rawPlanInput: unknown,
	deps: SubmitEncodingJobDeps,
): Promise<SubmitOutcome> {
	const parsed = encodingPlanSchema.safeParse(rawPlanInput);
	if (!parsed.success) {
		return {
			ok: false,
			code: "PARSE",
			message: "Plan failed to parse",
			details: parsed.error,
		};
	}
	const rawPlan = parsed.data;
	if (
		rawPlan.internal?.hevcV2 &&
		!isInternalHevcV2Account(
			rawPlan.bitmovin.accountId,
			deps.internalHevcV2AccountId,
		)
	) {
		return {
			ok: false,
			code: "INTERNAL_FEATURE_DISABLED",
			message: "Internal HEVC v2 is not enabled for this account",
		};
	}
	// Refused, never stripped: three of the five doors hand us a plan someone
	// else authored (a template, an import, a previous run), and encoding
	// something other than the plan the audit trail keeps is the outcome this
	// refusal exists to prevent.
	if (
		deps.qcVmafEnabled &&
		(rawPlan.qc?.vmaf || rawPlan.qc?.psnr || rawPlan.qc?.gate) &&
		!(await deps.qcVmafEnabled())
	) {
		return {
			ok: false,
			code: "QC_DISABLED",
			message:
				"This deployment has QC/VMAF turned off — enable it in Settings, or remove the plan's qc block",
		};
	}
	if (rawPlan.qc?.execution?.backend === "CLOUD") {
		const unavailable: SubmitRefusal = {
			ok: false,
			code: "QC_CLOUD_UNAVAILABLE",
			message: "Cloud compute profiles are unavailable",
		};
		if (!deps.cloudVmafProfileAvailable) return unavailable;
		let available: boolean;
		try {
			available = await deps.cloudVmafProfileAvailable(
				rawPlan.qc.execution.profileId,
			);
		} catch {
			return unavailable;
		}
		if (available !== true) {
			return {
				ok: false,
				code: "QC_CLOUD_PROFILE_INVALID",
				message: "Unknown or disabled cloud compute profile",
			};
		}
	}
	const accountId = rawPlan.bitmovin.accountId;
	if (!accountId) {
		return {
			ok: false,
			code: "NO_ACCOUNT_ID",
			message: "plan.bitmovin.accountId is required to start an encoding",
		};
	}
	const account = await deps.loadAccountDefaults(accountId);
	if (!account) {
		return {
			ok: false,
			code: "ACCOUNT_MISSING",
			message: "Bitmovin account does not exist",
		};
	}
	// Inject the account's submission defaults (fallback regions / scheduling
	// priority / prewarmed pools) BEFORE validation — (e): the
	// first cut validated rawPlan and injected afterwards, so account-default
	// values (fallbackCloudRegions above all) were never validated and the
	// deployment profile could be bypassed by exactly the values nobody
	// typed — the #38 stamping-layer class, one layer up. What compiles and
	// persists below is what got validated, by construction.
	const plan = applyAccountDefaultsToPlan(rawPlan, account.defaults);
	const issues = validatePlan(plan, deps.validationOptions);
	if (planHasErrors(issues)) {
		return {
			ok: false,
			code: "VALIDATION",
			message: "Plan validation failed",
			issues,
		};
	}
	/**
	 * Skippable ONLY for re-run (review-210 C1): a spec is ordinary code, so a
	 * later tightening would retroactively make a FINISHED job un-re-runnable
	 * and there is no in-app way to strip the field. History is not
	 * re-litigated; new submissions are.
	 */
	let deliveryWarnings: PlanIssue[] = [];
	if (!deps.skipDeliveryCommitment) {
		const verdict = deliveryVerdict(plan);
		if (verdict.refusal) {
			return verdict.refusal;
		}
		deliveryWarnings = verdict.warnings ?? [];
	}
	// WARN deviations ride the same observability channel as every other
	// non-blocking issue (review-210 I2): a WARN commitment must not be
	// byte-identical to no commitment.
	await deps.recordEgress([...issues, ...deliveryWarnings], accountId);
	const stepLog = initStepLog(compilePlan(plan));
	const row = await deps.createJob({
		name: plan.name,
		status: "QUEUED",
		plan,
		stepLog,
		bitmovinAccountId: accountId,
		region: plan.bitmovin.cloudRegion ?? null,
		labels: plan.bitmovin.labels ?? [],
		totalSteps: stepLog.length,
		doneSteps: 0,
		presetId: deps.provenance?.presetId ?? null,
		presetRevision: deps.provenance?.presetRevision ?? null,
	});
	try {
		await deps.enqueue(row.id);
	} catch (enqueueErr) {
		// Redis down: mark ERROR so /retry can recover the row instead of
		// stranding it in QUEUED forever.
		await deps.markEnqueueFailed(row.id);
		throw enqueueErr;
	}
	return { ok: true, id: row.id, plan, issues };
}
