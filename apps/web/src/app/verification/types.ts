import {
	isVerificationRunStatus,
	type LiveEvidenceLeg,
	type LiveEvidenceSummary,
	type VerificationRunStatus,
} from "@bitovp/core";

/** `GET /api/verification-runs` — one row of the list projection. */
export type VerificationRunSummary = {
	id: string;
	runId: string;
	kind: string | null;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	commit: string;
	drift: boolean;
	counts: Record<string, number> | null;
	sealed: boolean;
	bitmovinAccountId: string | null;
};

/** One scenario's verdict, as the sealed report carries it. */
export type RunOutcome = {
	scenario: string;
	verdict: string;
	reason?: string;
	jobId?: string;
	encodingId?: string;
	planSha256?: string;
	sourceObject?: string;
	sourceIdentity?: string;
	checks?: Record<string, number>;
	/**
	 * LIVE only (audit 5c3d97ca BLOCKER-4, EV-02): the durable teardown seal
	 *  and the versioned evidence-tuple summary — the SAME shapes the
	 * harness writes, imported from core rather than re-declared here so the
	 * Dashboard cannot drift from the writer.
	 */
	liveCleanup?: {
		channelId: string;
		liveChannelRunId?: string;
		providerEncodingId?: string;
		clean: boolean;
		localClean: boolean;
		productStopProjection: { established: boolean; detail: string };
		providerTerminal: { established: boolean; detail: string };
		localTerminal: { established: boolean; detail: string };
		feederProcessGone: { established: boolean; detail: string };
		hostProcessGone: { established: boolean; detail: string };
		queueDrained: { established: boolean; detail: string };
	};
	liveEvidence?: LiveEvidenceSummary;
};

/** One VerificationLiveEvidence child row, as the detail route includes it. */
export type RunLiveEvidenceRow = {
	id: string;
	scenario: string;
	liveChannelRunId: string;
	outputLeg: string;
	version: number;
	complete: boolean;
	missing: string[];
	tuple: LiveEvidenceLeg;
	createdAt: string;
};

export type RunCleanup = {
	scenario: string;
	jobId: string;
	status: string;
	cancelHttp: number;
	terminal: boolean;
	localTerminal: boolean;
	providerTerminal: boolean | "unread";
	encodingIds: string[];
};

/** `GET /api/verification-runs/[id]` — the whole row. */
export type VerificationRunDetail = VerificationRunSummary & {
	checkoutLatestMigration: string;
	dbLatestMigration: string;
	baseUrlOrigin: string | null;
	actor: string | null;
	sourceObject: string | null;
	sourceIdentity: string | null;
	resumedFromId: string | null;
	resumedFrom: {
		id: string;
		runId: string;
		status: string;
		retentionUntil: string | null;
	} | null;
	resumeDecision: Record<string, unknown> | null;
	outcomes: RunOutcome[] | null;
	providerReadback: Record<string, string> | null;
	cleanup: RunCleanup[] | null;
	/** The Live/MSL evidence tuples (EV-02); absent on rows the API served before they existed. */
	liveEvidence?: RunLiveEvidenceRow[] | null;
	reportPath: string;
	reportSha256: string | null;
	seal: string | null;
	sealAlgorithm: string | null;
	sealKeyId: string | null;
	evidenceVersion: number | null;
	evidenceManifest: Record<string, unknown> | null;
	retentionUntil: string | null;
	sealedAt: string | null;
	error: string | null;
};

type Tone = "neutral" | "ok" | "error";

/**
 * `satisfies Record<VerificationRunStatus, Tone>` so a status added to core's
 * union is a COMPILE error here rather than a silently grey badge — deriving
 * the map from the union, not from the cases this screen happens to have seen.
 */
const STATUS_TONE = {
	RUNNING: "neutral",
	SEALED: "ok",
	INCOMPLETE: "error",
} satisfies Record<VerificationRunStatus, Tone>;

export function statusTone(status: string): Tone {
	return isVerificationRunStatus(status) ? STATUS_TONE[status] : "neutral";
}

/** PASS/SKIP are green-or-neutral; FAIL and INVALID are the run's defects. */
export function verdictTone(verdict: string): Tone {
	if (verdict === "PASS") {
		return "ok";
	}
	if (verdict === "FAIL" || verdict === "INVALID") {
		return "error";
	}
	return "neutral";
}
