import type { PlanInput, PlanOutput } from "../plan/schema";

/**
 * Can VMAF read bytes back out of this plan IO, and from where?
 *
 * Used by BOTH corpora. VOD asks it about the QC mirror MP4s; LIVE asks it
 * about the segment window the capture lists and concatenates — and a live
 * plan's `outputs` is `planOutputSchema`, the very same union, so the question
 * is literally the same one. Live needs `listObjects` on top of `getObject`,
 * which does not narrow the set: every browser the factory returns carries
 * both, and `live-capture.ts` lists through the provider-agnostic
 * `browser.listObjects` rather than any S3-shaped call.
 *
 * VMAF is OUR pipeline, not Bitmovin's (ARCHITECTURE §6): after the encode
 * finishes we download the reference and the distorted renditions and score
 * them locally. That download needs a browsable credential and a container
 * name — a strictly narrower requirement than "Bitmovin can write here".
 *
 * The two requirements were never written down together, so the measurement
 * worker's resolver carried an inline `kind === "S3" || kind === "AZURE"`
 * allowlist while the plan schema, the compiler and the QC mirror synthesis all
 * accepted far more (audit e57f2d3, AKR-E57-008). The consequence is the
 * expensive shape: the plan validates, the compiler builds QC mirrors,
 * **Bitmovin runs and bills the encode**, and only then does the worker refuse
 * the output kind. A blocking QC gate then marks the delivery QC_FAILED for a
 * reason that was knowable before a single operation ran.
 *
 * The audit named `GENERIC_S3`. Deriving the population from the schema union
 * rather than from the reported instance found two more with the identical
 * shape — `GCS` and `GCS_SERVICE_ACCOUNT` — both of which `packages/storage`
 * has browsed since the storage browser landed. The allowlist was not wrong
 * about a vendor limitation; it had simply stopped tracking what the storage
 * layer could already do.
 */

/** Every `kind` the plan's input and output unions can carry. */
type IoKind = PlanInput["kind"] | PlanOutput["kind"];

/** The union member for one discriminant, so each table entry is typed. */
type IoOfKind<K extends IoKind> = Extract<PlanInput | PlanOutput, { kind: K }>;

/** Where the bytes live, once we know we can reach them. */
type Located = { credentialId: string; bucket: string };

/**
 * Per kind: how to locate the bytes, or why VMAF cannot.
 *
 * TOTALITY IS THE POINT — the table is a mapped type over the schema's own
 * discriminants, so adding an IO kind to the plan is a COMPILE error here
 * rather than a late runtime refusal after a billed encode. That is the
 * property the previous allowlist could not have: nothing made it a liar when
 * the schema grew. Each locator is typed by ITS member too, so naming the
 * wrong field (`bucket` on Azure, say) fails to compile rather than resolving
 * to `undefined` at 3am.
 *
 * TOTALITY'S LIMIT, so this comment does not overstate it: the property holds
 * for whoever ASKS this table. The live capture path had two more copies of
 * the same predicate on the same union (`capture-vmaf/route.ts`,
 * `vmaf/live-processor.ts`) — reported separately as AKR-E57-009 and migrated
 * in the PR stacked on this one. Until a call site asks here, adding an IO
 * kind does not make IT go red. Review caught this file claiming otherwise.
 *
 * A refusal is a real answer, not a gap: it carries the reason, so the message
 * says WHY instead of "unsupported". All but `HTTPS` mirror a refusal
 * `packages/storage`'s factory already makes for the same provider; HTTPS is
 * credential-LESS by schema, so it has no provider and no factory case at all
 * (the reason stands, the claimed mirror did not — review catch).
 */
const STREAMABLE_IO: {
	[K in IoKind]: ((io: IoOfKind<K>) => Located) | { refuse: string };
} = {
	S3: (io) => ({ credentialId: io.credentialId, bucket: io.bucket }),
	AZURE: (io) => ({ credentialId: io.credentialId, bucket: io.container }),
	GENERIC_S3: (io) => ({ credentialId: io.credentialId, bucket: io.bucket }),
	GCS: (io) => ({ credentialId: io.credentialId, bucket: io.bucket }),
	GCS_SERVICE_ACCOUNT: (io) => ({
		credentialId: io.credentialId,
		bucket: io.bucket,
	}),
	SFTP: {
		refuse:
			"SFTP is an encoding output only — the storage browser cannot list or GET it, so the encoded bytes cannot be pulled back for scoring",
	},
	AKAMAI_NETSTORAGE: {
		refuse:
			"Akamai NetStorage speaks its own protocol rather than S3, and has no browse driver here — scoring would have nothing to download from",
	},
	LIVE_MEDIA_INGEST: {
		refuse:
			"Live Media Ingest is an Origin publishing target, not readable storage",
	},
	AKAMAI_MSL: {
		refuse:
			"Akamai MSL is an INGEST target with no readable origin — the same fact the live verifier meets, where every MSL delivery check can only SKIP",
	},
	HTTPS: {
		refuse:
			"an HTTPS source carries no credential to sign a GET with, so its bytes cannot be streamed for scoring",
	},
};

export type VmafSource =
	| ({ streamable: true } & Located)
	| { streamable: false; reason: string };

/**
 * Resolve a plan input/output to the (credential, bucket) VMAF needs.
 *
 * Returns the refusal REASON rather than throwing, so both callers can use it
 * for the job they have: the worker turns it into the error it already threw,
 * and the plan validator turns it into a rail that fires before anything is
 * billed. One rule, two moments — which is the whole point, because the two
 * disagreeing is exactly how a billed encode reached a resolver that would
 * always have refused it.
 */
export function vmafSourceFor(io: PlanInput | PlanOutput): VmafSource {
	// One dispatch cast, and it is the narrowing TypeScript cannot express: the
	// table's key IS `io.kind`, so the locator is the one for this member.
	const entry = STREAMABLE_IO[io.kind] as
		| ((v: PlanInput | PlanOutput) => Located)
		| { refuse: string };
	if (typeof entry !== "function") {
		return { streamable: false, reason: entry.refuse };
	}
	// No empty-bucket branch: every locator field is `z.string.min(1)` in the
	// schema and the plan is parsed before it reaches here, so a guard on `""`
	// is unreachable — review demonstrated it by deleting it with the suite
	// green. A guard nothing can trip is a claim about coverage that is not
	// true, so it is gone rather than pinned.
	return { streamable: true, ...entry(io) };
}
