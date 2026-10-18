import { mapDestinations } from "../plan/destinations";
import { initStepLog, type StepLogEntry } from "../plan/steplog";
import { compileLiveChannel } from "./compiler";
import { type LiveChannelPlan, liveChannelPlanSchema } from "./schema";

/**
 * Per-run output rebase .
 *
 * A live plan pins literal destination paths. A second run writing the same
 * prefix appends to a manifest whose segments the first run also wrote — a
 * corrupted timeline, or silent overwriting (measured on the first real
 * re-air, 2026-08-21). So each run seq ≥ 2 gets its own subtree:
 *
 *     <channel base>/runs/<seq>-<runId8>/…
 *
 * where `<channel base>` is the longest common DIRECTORY prefix of the
 * plan's destination paths. Inserting the same segments at the same shared
 * depth in EVERY path preserves every relative relationship between
 * manifests and their segment directories — the property a plain prepend
 * also has, and the reason no other insertion point is safe. When the paths
 * share no common prefix (multi-output plans with disjoint roots), the base
 * is empty and the insertion degrades to exactly the prepend that template
 * launches (#109) and watch folders (#87) use.
 *
 * Run seq 1 deliberately writes at the plan's OWN paths (outputPrefix ""):
 * that is what the create route compiles, what the #108 backfill recorded
 * for every existing run, and what the plan preview shows the operator —
 * and WITHIN a channel a first run has nothing to collide with. (Two
 * channels sharing a base path still collide at seq 1 exactly as they
 * always did — Duplicate copies the base verbatim; this module separates
 * RUNS, not channels.) Leading slashes normalize away here, matching
 * rebaseDestinations — a plan that pins "/out/x" would see run 1 write
 * the literal and run 2+ write under "out/x"; the wizard never emits
 * leading slashes.
 *
 * AN AKAMAI MSL MANIFEST DOES NOT MOVE (WP-C6, measured 2026-09-02 on channel
 * 0645c2f1, measurement doc Part 9). The rule above moved EVERY destination,
 * the manifest included, and that is exactly what made the run subtree
 * invisible on Akamai: the MSL publisher writes a muxing's objects under its
 * full `outputPath` (run 3's segments were found at
 * `<event>/runs/3-80a8c26b/output/<slug>/video/1080p/…`, fresh) but publishes
 * the manifests at the EVENT ROOT regardless of their `outputPath`, while
 * Bitmovin writes the playlist's segment URIs RELATIVE to the manifest's
 * `outputPath`. Moving both by the same subtree cancels the subtree out of the
 * relative URI (`output/<slug>/video/1080p/seg-…`), and the root-published
 * playlist then names run 1's objects — which the edge served (1080p, stale)
 * or no longer had (720p and below, 404). So a manifest whose destination is
 * an MSL output keeps the plan's path (the event root, per C31's manifest
 * path contract), the base is computed over the paths that DO move, and the
 * muxings land at `output/<slug>/runs/<seq>-<runId8>/…` — which the relative
 * URI now carries and the edge resolves to the airing's own objects. The
 * verifier's "media below event root + run prefix" rule
 * (`live-evidence.ts`) was written for this layout.
 */

/** The path segment a run's subtree lives under: `runs/<seq>-<runId8>`. */
export function liveRunSegment(seq: number, runId: string): string {
	return `runs/${seq}-${runId.replace(/-/g, "").slice(0, 8)}`;
}

/** Split a path into segments, dropping empties (leading/trailing/double slashes). */
function segmentsOf(path: string): string[] {
	return path.split("/").filter((s) => s !== "");
}

/** Longest common directory prefix of the paths, as segments. */
function commonBaseSegments(paths: readonly string[]): string[] {
	if (paths.length === 0) {
		return [];
	}
	let base = segmentsOf(paths[0] as string);
	for (const path of paths.slice(1)) {
		const segments = segmentsOf(path);
		let shared = 0;
		while (
			shared < base.length &&
			shared < segments.length &&
			base[shared] === segments[shared]
		) {
			shared += 1;
		}
		base = base.slice(0, shared);
		if (base.length === 0) {
			break;
		}
	}
	return base;
}

export type LiveRunRebase = {
	plan: LiveChannelPlan;
	/**
	 * The subtree every MOVED destination path starts with — recorded on
	 * `LiveChannelRun.outputPrefix`. `<base>/runs/<seq>-<runId8>`, or just
	 * `runs/<seq>-<runId8>` when the moved paths share no base. Manifests
	 * published to an Akamai MSL output are the one thing that does not move
	 * (see the header) and are not covered by it.
	 */
	outputPrefix: string;
};

/** One destination's identity for the pin set — unambiguous for any key/path. */
function destinationKey(dest: { outputKey: string; path: string }): string {
	return JSON.stringify([dest.outputKey, dest.path]);
}

/**
 * The manifest destination paths this rebase must leave where the plan put
 * them: those whose output is Akamai MSL, which publishes manifests at the
 * event root whatever their `outputPath` says (header). Returned as the
 * `outputKey`+`path` pairs the walk can recognise, because the walk sees a
 * destination without knowing whether a manifest or a muxing owns it.
 */
function pinnedMslManifestDestinations(plan: LiveChannelPlan): Set<string> {
	const mslOutputs = new Set(
		plan.outputs.filter((o) => o.kind === "AKAMAI_MSL").map((o) => o.key),
	);
	const pinned = new Set<string>();
	for (const manifest of plan.liveManifests) {
		if (mslOutputs.has(manifest.destination.outputKey)) {
			pinned.add(destinationKey(manifest.destination));
		}
	}
	return pinned;
}

/**
 * Rebase every destination path in the plan into the run's subtree.
 * Invariant (pinned by tests): every MOVED destination path in the returned
 * plan starts with `outputPrefix`, moved paths' relative relationships to
 * each other are unchanged, and a manifest bound to an Akamai MSL output
 * keeps the plan's own path.
 *
 * The pin is keyed by (outputKey, path), not by manifest identity, because
 * `mapDestinations` walks the structure and sees only destinations. A muxing
 * whose destination happens to EQUAL an MSL manifest's (same output, same
 * path) would therefore stay put too; the wizard never builds that shape —
 * segments live under `output/<slug>/…`, the MSL manifest at "" — and a plan
 * that does has its muxing and manifest inseparable on the wire anyway.
 */
export function rebaseLivePlanForRun(
	plan: LiveChannelPlan,
	run: { seq: number; runId: string },
): LiveRunRebase {
	const pinned = pinnedMslManifestDestinations(plan);
	const isPinned = (dest: { outputKey: string; path: string }) =>
		pinned.has(destinationKey(dest));
	const moving: string[] = [];
	mapDestinations(plan, (dest) => {
		if (!isPinned(dest)) {
			moving.push(dest.path);
		}
		return dest;
	});
	const base = commonBaseSegments(moving);
	const segment = liveRunSegment(run.seq, run.runId);
	const outputPrefix =
		base.length > 0 ? `${base.join("/")}/${segment}` : segment;
	const rebased = mapDestinations(plan, (dest) => {
		if (isPinned(dest)) {
			return dest;
		}
		const rest = segmentsOf(dest.path).slice(base.length);
		return {
			...dest,
			path:
				rest.length > 0 ? `${outputPrefix}/${rest.join("/")}` : outputPrefix,
		};
	});
	// The walk rewrites strings in place structurally; re-parse so the result
	// is typed by the schema, not by assertion. Non-empty strings stay
	// non-empty, so this cannot fail for a plan that parsed on the way in.
	return { plan: liveChannelPlanSchema.parse(rebased), outputPrefix };
}

/**
 * The step log a FRESH run starts from — the single brain shared by every
 * fresh-compile site (the actions route's re-air and corpse-revival arms,
 * and the scheduler sweep's STOPPED and empty-log arms), so the seq rule
 * cannot drift between them: seq ≥ 2 compiles the REBASED plan and names
 * its prefix; seq 1 compiles the plan as-is with prefix "" (the create
 * route's own construction).
 */
/**
 * What EVERY door that claims a live channel into PROVISIONING must also write.
 *
 * There are three such doors — the web start action and the scheduler's two
 * arms (CREATED|ERROR and STOPPED) — and the first cut of the provisioning
 * lease released it in only ONE of them. The other two claimed the row without
 * clearing the previous run's lease, so an unattended re-air took the claim,
 * enqueued its provision job, and that job then refused the still-live lease
 * and returned successfully. The channel sat in PROVISIONING with no retry and
 * no alarm: for an unattended scheduler, a silently missed airing.
 *
 * One constant so the three cannot drift, and a derived test asserts every
 * `liveChannel` claim that writes PROVISIONING also spreads this.
 *
 * rev431 : the same claim clears `encoderStoppedConfirmedFor`. A
 * channel claimed into PROVISIONING is about to (re)start an encoding — a
 * REVIVE keeps the previous run's CREATED encoding under the same id — so
 * no stop/CREATED confirmation for that pointer can stand past this write.
 */
export const PROVISION_LEASE_RELEASE = {
	provisionClaimedAt: null,
	encoderStoppedConfirmedFor: null,
} as const;

/**
 * Is this output MSL5?
 *
 * , Track 2b. Written for Track 2a's experimental gate, which was
 * RETIRED when MSL5 went GA (SDK 1.278.0 / encoder 2.283.0) — the predicate
 * outlives the gate because the rails that replace it ask the same question
 * for the opposite reason. A gate asked "is this the thing we refuse"; a rail
 * asks "is this the thing whose extra requirements apply" (publishing auth is
 * MSL5-only, and MSL5 is live-only).
 *
 * The read stays STRUCTURAL rather than typed on purpose: callers hold plans
 * at different stages of parsing, and a raw persisted `Job.plan` is one of
 * them. Its consumers land with the enum widening in the same ledger row; in
 * the interim a parsed plan cannot carry "MSL5" at all, because
 * `AKAMAI_MSL_VERSIONS` is still `["MSL4"]` and the zod enum derives from it.
 */
export function outputHasMsl5Marker(output: {
	kind: string;
	mslVersion?: unknown;
}): boolean {
	return (
		output.kind === "AKAMAI_MSL" &&
		(output as { mslVersion?: unknown }).mslVersion === "MSL5"
	);
}

export function hasMsl5Marker(plan: LiveChannelPlan): boolean {
	return plan.outputs.some((output) => outputHasMsl5Marker(output));
}

export function compileLiveRunStepLog(
	plan: LiveChannelPlan,
	run: { seq: number; runId: string },
): { entries: StepLogEntry[]; outputPrefix: string } {
	if (run.seq >= 2) {
		const rebased = rebaseLivePlanForRun(plan, run);
		return {
			entries: initStepLog(compileLiveChannel(rebased.plan)),
			outputPrefix: rebased.outputPrefix,
		};
	}
	return { entries: initStepLog(compileLiveChannel(plan)), outputPrefix: "" };
}

/**
 * The plan a RUN actually wrote — for consumers deriving from paths
 * (playback links, VMAF capture). `outputPrefix === ""` means the run wrote
 * at the plan's own paths (seq 1, or a run from before #155). Otherwise the
 * rebase is recomputed — exact, because the channel plan is immutable after
 * create (PATCH edits only maxRunMinutes) — and IDENTITY-CHECKED against
 * the stored prefix: a mismatch means the run was started by a build whose
 * derivation differed, and returning null (no links, a named capture error)
 * is honest where guessed paths would not be.
 */
export function effectiveLivePlanForRun(
	plan: unknown,
	run: { seq: number; id: string; outputPrefix: string },
): LiveChannelPlan | null {
	const parsed = liveChannelPlanSchema.safeParse(plan);
	if (!parsed.success) {
		return null;
	}
	if (run.outputPrefix === "") {
		return parsed.data;
	}
	const rebased = rebaseLivePlanForRun(parsed.data, {
		seq: run.seq,
		runId: run.id,
	});
	return rebased.outputPrefix === run.outputPrefix ? rebased.plan : null;
}
