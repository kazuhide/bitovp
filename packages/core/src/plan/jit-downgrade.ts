import { type CompiledOperation, compilePlan } from "./compiler";
import type { EncodingPlan } from "./schema";

/**
 * Convert a just-in-time manifest start to POST_ENCODING generation.
 *
 * A provider start can fail when it contains manifest IDs even when a plain
 * encoding start succeeds. The manifest resources already exist, so recovery
 * can start the encoding without those IDs and generate the same manifests
 * afterwards. This module derives the rewritten start and manifest operations;
 * the worker's jit-fallback decides when the transformation is appropriate.
 */

/**
 * Why a downgrade did not apply. Each refusal is NAMED rather than folded
 * into a bare null: review-208 found that three of these guards could each
 * be deleted with every test still green, because a later guard caught the
 * same case — "refuses X" tests were passing for the wrong reason. A test
 * asserting the REASON pins the guard it names.
 */
export type JitDowngradeRefusal =
	| "ALREADY_POST_ENCODING"
	| "NO_JIT_MANIFESTS"
	| "STEP_NOT_COVERED"
	| "EMPTY_TRANSFORM"
	| "NON_MANIFEST_APPEND"
	| "MULTIPLE_STARTS";

export type JitDowngradeResult =
	| ({ ok: true } & JitDowngrade)
	| { ok: false; reason: JitDowngradeRefusal };

/** The transformation, as data. Apply order: rewrite, then append. */
export type JitDowngrade = {
	/** The same plan with `generation.timing` = POST_ENCODING. Persist it. */
	plan: EncodingPlan;
	/**
	 * step id → recompiled op, for steps the log ALREADY has. Only
	 * START_ENCODING ops appear here: they are the only ops whose payload
	 * legitimately changes (the manifest lists leave the start request), and
	 * a test pins that every other shared step compiles byte-identically in
	 * both timings — so a compiler change that starts moving something else
	 * fails there rather than silently rewriting a DONE step's snapshot.
	 */
	rewritten: Map<string, CompiledOperation>;
	/** Ops the downgraded plan adds, in compile order (manifest start/await). */
	appended: CompiledOperation[];
	/** Manifest keys whose `jitPlacement` the downgrade dropped (C1). */
	droppedPreview: string[];
};

/** The only op kinds a downgrade may append — see the refusal below. */
const APPENDABLE_KIND = /^(START|AWAIT)_MANIFEST_(HLS|DASH|SMOOTH)$/;

/** True when this op's refs make it a start that rides JIT manifests. */
export const JIT_START_REF_KEYS = [
	"vodHlsManifestIds",
	"vodDashManifestIds",
	"vodSmoothManifestIds",
	"previewHlsManifestIds",
	"previewDashManifestIds",
] as const;

export function ridesJitManifests(op: {
	kind: string;
	refs: Record<string, unknown>;
}): boolean {
	if (op.kind !== "START_ENCODING") {
		return false;
	}
	return JIT_START_REF_KEYS.some((key) => {
		const value = op.refs[key];
		return Array.isArray(value) ? value.length > 0 : value !== undefined;
	});
}

/**
 * Compute the downgrade for a plan whose start is failing, or a NAMED
 * refusal. The refusals are deliberate, not silent no-ops:
 *
 *  - the plan is already POST_ENCODING (so a second failure is a REAL
 *    failure — this is what keeps the fallback from looping);
 *  - no manifest rides the start (nothing to move);
 *  - the downgraded compile does not COVER every step the log already has
 *    (a step vanishing under the new timing would strand a DONE resource —
 *    refuse rather than guess).
 *
 * `existingSteps` is the current step log's ids, in any order.
 */
export function downgradeJitManifests(
	plan: EncodingPlan,
	existingSteps: readonly string[],
): JitDowngradeResult {
	if (plan.generation.timing !== "JUST_IN_TIME") {
		return { ok: false, reason: "ALREADY_POST_ENCODING" };
	}
	/**
	 * `jitPlacement` must go with the timing (review of PR #208, C1). A
	 * PREVIEW / VOD_AND_PREVIEW manifest is a start-request list — the
	 * validator makes it an ERROR on a non-JIT plan
	 * (PLAN_PREVIEW_REQUIRES_JIT), so a downgrade that left it in place would
	 * PERSIST a plan the repo's own validator rejects: the job finishes, and
	 * then Re-run refuses it, blaming the operator. Dropping it also states
	 * the semantic loss honestly — a watch-while-encoding manifest generated
	 * AFTER the encode is an ordinary VOD manifest, which is worth saying in
	 * the note rather than pretending nothing changed.
	 */
	// `in` rather than a bare read: SMOOTH manifests have no such field at
	// all (the API has no preview list for them), so the union needs the
	// narrowing.
	const _hasPlacement = (m: EncodingPlan["manifests"][number]) =>
		"jitPlacement" in m && m.jitPlacement !== undefined;
	// Only a PREVIEW placement loses meaning here. An explicit "VOD" is a
	// user-reachable value (the wizard offers it) whose semantics survive the
	// downgrade untouched — naming it as a dropped preview would report a loss
	// that did not happen (review-208b I3). The FIELD is stripped from every
	// manifest either way; that half is C1.
	const droppedPreview = plan.manifests
		.filter(
			(m) =>
				"jitPlacement" in m &&
				(m.jitPlacement === "PREVIEW" || m.jitPlacement === "VOD_AND_PREVIEW"),
		)
		.map((m) => m.key);
	const downgraded: EncodingPlan = {
		...plan,
		generation: { ...plan.generation, timing: "POST_ENCODING" },
		manifests: plan.manifests.map((m) => {
			// Inline `in` (not the helper): only the narrowing form lets TS see
			// the field on the member being destructured.
			if (!("jitPlacement" in m) || m.jitPlacement === undefined) {
				return m;
			}
			const { jitPlacement: _dropped, ...rest } = m;
			return rest;
		}),
	};
	const before = compilePlan(plan);
	if (!before.some(ridesJitManifests)) {
		return { ok: false, reason: "NO_JIT_MANIFESTS" };
	}
	const after = compilePlan(downgraded);
	const known = new Set(existingSteps);
	const afterSteps = new Set(after.map((op) => op.step));
	for (const step of known) {
		if (!afterSteps.has(step)) {
			return { ok: false, reason: "STEP_NOT_COVERED" };
		}
	}
	const rewritten = new Map<string, CompiledOperation>();
	const appended: CompiledOperation[] = [];
	for (const op of after) {
		if (!known.has(op.step)) {
			appended.push(op);
			continue;
		}
		if (op.kind === "START_ENCODING") {
			rewritten.set(op.step, op);
		}
	}
	if (rewritten.size === 0 || appended.length === 0) {
		return { ok: false, reason: "EMPTY_TRANSFORM" };
	}
	/**
	 * One start only. `validate.ts`'s PLAN_MULTI_ENCODING_JIT makes a
	 * multi-encoding JIT plan unsubmittable, so this is unreachable today —
	 * but `rewritten` is a Map, and a persisted plan replayed after that rail
	 * changes would rewrite a SIBLING start that is already DONE, making the
	 * step log describe a request the account never received (review-208 I1's
	 * root, refused here rather than only skipped downstream).
	 */
	if (rewritten.size > 1) {
		return { ok: false, reason: "MULTIPLE_STARTS" };
	}
	/**
	 * The appended set is DERIVED (every op the log lacks), and this is the
	 * codebase's first mid-flight recompile — steplog.ts still says "never
	 * recompile mid-flight". If a deploy lands between the original compile
	 * and this resume, a newer compiler could emit an op the log has never
	 * seen, and appending it would execute (say) a CREATE_STREAM after the
	 * encode. Only manifest generation may ride this path; anything else is
	 * refused rather than guessed (review of PR #208, I2).
	 */
	if (!appended.every((op) => APPENDABLE_KIND.test(op.kind))) {
		return { ok: false, reason: "NON_MANIFEST_APPEND" };
	}
	return { ok: true, plan: downgraded, rewritten, appended, droppedPreview };
}
