import {
	type AppPrismaClient,
	type AuditEntry,
	writeAuditLog,
} from "@bitovp/db";
import type { InternalHevcV2 } from "./internal-hevc-v2";
import type { AuditRecorder } from "./sdk-ops";
import { createBitmovinSdkOps, type SdkOps } from "./sdk-ops";
import type { CreateStamp } from "./stamping-fetch";

/**
 * The production `makeSdk` — lifted out of index.ts so the seam is TESTABLE.
 *
 * The defect this exists to prevent shipped once already: index.ts's inline
 * lambda destructured three fields out of the args and silently dropped the
 * fourth (`stamp`), with a green suite and a clean typecheck — contravariance
 * lets a narrower-arg function satisfy the dep type, and no test crossed the
 * seam (review of PR #163, C1, proven at the wire; the reviewer's Mutation A —
 * reverting exactly that destructure — survived every test until this module
 * existed). Now the SAME function object index.ts wires is the one
 * `make-sdk.test.ts` drives to the wire, so reintroducing the destructure
 * fails a test instead of a production run.
 */
/**
 * Who the orchestrator is, in the audit trail. `entry.actor` still wins if a
 * caller ever resolves a finer identity — the spread order says so.
 */
export const WORKER_ACTOR = "worker:orchestrator";

export function makeWorkerSdk(prisma: AppPrismaClient) {
	return (args: {
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
		stamp?: CreateStamp;
		orphanStopOnly?: true;
		monitoringSignal?: AbortSignal;
		internalHevcV2?: InternalHevcV2;
	}): SdkOps =>
		createBitmovinSdkOps(args, (entry) =>
			writeAuditLog(prisma, withWorkerActor(entry)),
		);
}

/**
 * Resolve the orchestrator's identity onto an audit entry.
 *
 * Named and exported so it can be PINNED, which the inline version was not.
 * This is the highest-volume audit writer in the system and it has no Request
 * to read an actor from — the orchestrator runs unattended off a queue — so it
 * states a sentinel rather than leaving a silent NULL that would be
 * indistinguishable from 's original defect, where attribution was
 * simply never wired (security-review-212).
 *
 * `entry` spreads FIRST and the sentinel resolves with `??`. The reverse,
 * `{actor: WORKER_ACTOR, ...entry}`, is wiped by an entry that NAMES `actor`
 * with an undefined value, because object spread copies a key that EXISTS
 * whatever its value — the exact trap that disabled every feeder default in
 * . review-final reverted this to that vulnerable form and measured
 * tsc 0 with 965/965 green: correct, but unpinned. The `??` makes it safe
 * under either ordering, and an explicit actor still wins.
 */
export function withWorkerActor(
	entry: Parameters<AuditRecorder>[0],
): AuditEntry {
	// The return type is the DB's entry, whose `actor` is required: this
	// function's whole job is turning a recorder entry (actor optional) into
	// one, so the compiler checks that it always does.
	return { ...entry, actor: entry.actor ?? WORKER_ACTOR };
}
