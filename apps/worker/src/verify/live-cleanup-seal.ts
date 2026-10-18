import { feederProcessMayBeAlive } from "@bitovp/core";

/**
 * The durable Live cleanup seal

 *
 * The live runner used to wait only for the LOCAL channel row to read
 * STOPPED/ERROR after a stop 2xx and then report the run normally. That proved
 * nothing about the PROVIDER, nothing about the feeder's ffmpeg, and nothing
 * about a stop that never left the queue: in the paid re-audit every feeder row
 * carried `processGoneAt = null`, so process-terminal could be shown only by a
 * separate host-level ffmpeg scan the product never ran — a feeder stop that
 * never reached another host would leave a push running while the channel side
 * read STOPPED and the report looked clean.
 *
 * This module turns teardown into ONE first-class artefact instead of an
 * inference. It records the local product/process projection first; EV-01's
 * exact provider-set readback then finalises the provider element:
 *
 * 1. productStopProjection — the local channel row projects STOPPED with no
 * error. This is useful product evidence, but NEVER provider evidence.
 * 2. providerTerminal — EV-01 discovered the exact marker-bound provider set,
 * stopped it and read every member terminal. The pure local read below
 * deliberately leaves this false; `finalizeLiveCleanupSeal` is the only
 * promotion point.
 * 3. localTerminal — the local channel row reached a terminal state.
 * 4. feederProcessGone — every feeder session that ENGAGED a process carries
 * a positive `processGoneAt` (stamped on a proven
 * kill ladder or an ESRCH probe). This is the element the audit's hole
 * turned on: a feeder that pushed, went terminal (pid nulled) but was
 * never proven gone reads as "nothing to do" everywhere else.
 * 5. hostProcessGone — no feeder session still points at a pid nobody proved
 * gone (`feederProcessMayBeAlive`): the DB analogue of "0 ffmpeg for this
 * run".
 * 6. queueDrained — no pending feeder job remains for this channel's
 * sessions.
 *
 * `localClean` is the local/product/process conjunction and is what the polling
 * loop can establish. `clean` additionally requires EV-01 provider evidence and
 * therefore stays false until finalisation. A MISSING element is NOT run
 * success: the runner seals the run INVALID when `clean` is false rather than
 * letting an unconfirmed teardown degrade into a green report.
 */

/** One element of the seal: was it POSITIVELY established, and the evidence. */
export type SealElement = {
	established: boolean;
	detail: string;
};

/** The durable seal, as it rides onto the live scenario outcome. */
export type LiveCleanupSeal = {
	channelId: string;
	/**
	 * The airing (LiveChannelRun.id) and the provider encoding the channel
	 * detail reported, carried on the seal so the evidence tuple
	 * can bind provider → cleanup without a second
	 * read. Absent when the detail could not be read — the tuple then names it.
	 */
	liveChannelRunId?: string;
	providerEncodingId?: string;
	providerStreamIds: Record<string, string>;
	providerOutputIds: Record<string, string>;
	/** Local STOPPED/null projection; explicitly not provider proof. */
	productStopProjection: SealElement;
	/** Established only by EV-01's exact provider-set terminal dossier. */
	providerTerminal: SealElement;
	localTerminal: SealElement;
	feederProcessGone: SealElement;
	hostProcessGone: SealElement;
	queueDrained: SealElement;
	tokenRequired: boolean;
	tokenCleanup: SealElement;
	/** All local product/process/queue/token elements established. */
	localClean: boolean;
	/** Every element established. A false here is a teardown that did not prove
	 *  itself, including exact provider readback, and the run may not seal PASS. */
	clean: boolean;
};

/** One feeder session's cleanup-relevant fields, as the product reports them. */
export type LiveCleanupFeeder = {
	id: string;
	pid: number | null;
	processGoneAt: string | Date | null;
	/** Set on first push; a positive value means the session ran an ffmpeg. */
	startedAt?: string | Date | null;
	/** The feeder queue holds a pending job for this session; `null` = the
	 *  queue could not be read (Redis down), which cannot prove drained. */
	queued: boolean | null;
};

/** The raw facts a seal is computed from — gathered over HTTP by the runner. */
export type LiveCleanupFacts = {
	channelId: string;
	/** The current airing's id, when the detail exposed one (EV-02). */
	liveChannelRunId?: string;
	/** The provider encoding id the channel row / airing carries (EV-02). */
	providerEncodingId?: string;
	providerStreamIds?: Record<string, string>;
	providerOutputIds?: Record<string, string>;
	/** Temporary static-ingest stream key disposition. */
	tokenCleanup?: { required: boolean; confirmed: boolean; detail: string };
	/** The local channel row's terminal status (STOPPED | ERROR | …). */
	channelStatus: string | undefined;
	/** The worker's stop-confirmation word: null = confirmed, non-null = not. */
	channelError: string | null | undefined;
	/** False when the feeder list could not be read — the three feeder-derived
	 *  elements then cannot be established (unknown is never proven). */
	feederListRead: boolean;
	feeders: readonly LiveCleanupFeeder[];
};

const TERMINAL_STATUSES = new Set(["STOPPED", "ERROR"]);

/**
 * Did this feeder ever run a process? A pid (holds one now), a `processGoneAt`
 * (held one, reclaimed) or a `startedAt` (began pushing) each say yes. It is
 * the `startedAt` half that catches the audit's shape: a feeder that pushed and
 * went terminal with its pid nulled but was NEVER proven gone — which without
 * `startedAt` would be indistinguishable from a session that never pushed.
 */
function everEngagedProcess(feeder: LiveCleanupFeeder): boolean {
	return (
		feeder.pid != null ||
		feeder.processGoneAt != null ||
		feeder.startedAt != null
	);
}

export function liveCleanupSeal(facts: LiveCleanupFacts): LiveCleanupSeal {
	const { channelStatus } = facts;
	const identity = {
		...(facts.liveChannelRunId !== undefined
			? { liveChannelRunId: facts.liveChannelRunId }
			: {}),
		...(facts.providerEncodingId !== undefined
			? { providerEncodingId: facts.providerEncodingId }
			: {}),
	};
	const providerResources = {
		providerStreamIds: { ...(facts.providerStreamIds ?? {}) },
		providerOutputIds: { ...(facts.providerOutputIds ?? {}) },
	};

	const localEstablished =
		channelStatus != null && TERMINAL_STATUSES.has(channelStatus);
	const localTerminal: SealElement = {
		established: localEstablished,
		detail: localEstablished
			? `local channel row is ${channelStatus}`
			: `local channel row is ${channelStatus ?? "unknown"}, not terminal`,
	};

	// STOPPED + null is only the product's local projection. EV-01 re-discovers
	// and reads the exact provider set after teardown; until that dossier exists,
	// this module must not translate the projection into a provider claim.
	const productStopEstablished =
		channelStatus === "STOPPED" && facts.channelError == null;
	const productStopProjection: SealElement = {
		established: productStopEstablished,
		detail: productStopEstablished
			? "local product projects STOPPED with no channel error"
			: channelStatus === "STOPPED"
				? "local product projects STOPPED but records a channel error"
				: `local product projects ${channelStatus ?? "unknown"}, not STOPPED`,
	};
	const providerTerminal: SealElement = {
		established: false,
		detail: "awaiting EV-01 exact resource-set readback",
	};
	const tokenRequired = facts.tokenCleanup?.required ?? false;
	const tokenCleanup: SealElement = facts.tokenCleanup
		? {
				established:
					!facts.tokenCleanup.required || facts.tokenCleanup.confirmed,
				detail: facts.tokenCleanup.detail,
			}
		: {
				established: true,
				detail: "this ingest created no temporary stream key",
			};
	// The three feeder-derived elements need the list. Absent it, they are
	// UNKNOWN — and unknown never counts as established (the safe direction: a
	// teardown you could not read is not a teardown you proved).
	if (!facts.feederListRead) {
		const unread: SealElement = {
			established: false,
			detail:
				"the channel's feeder sessions could not be read — cannot prove the push is gone",
		};
		return {
			channelId: facts.channelId,
			...identity,
			...providerResources,
			productStopProjection,
			providerTerminal,
			localTerminal,
			feederProcessGone: unread,
			hostProcessGone: unread,
			queueDrained: unread,
			tokenRequired,
			tokenCleanup,
			localClean: false,
			clean: false,
		};
	}

	const engagedNotProven = facts.feeders.filter(
		(f) => everEngagedProcess(f) && f.processGoneAt == null,
	);
	const feederProcessGone: SealElement = {
		established: engagedNotProven.length === 0,
		detail:
			engagedNotProven.length === 0
				? `${facts.feeders.length} feeder session(s), none engaged a process still unproven gone`
				: `feeder session(s) engaged a process never proven gone: ${engagedNotProven
						.map((f) => f.id)
						.join(", ")}`,
	};

	const stillAlive = facts.feeders.filter((f) => feederProcessMayBeAlive(f));
	const hostProcessGone: SealElement = {
		established: stillAlive.length === 0,
		detail:
			stillAlive.length === 0
				? "no feeder session still points at an unreclaimed pid"
				: `feeder session(s) still point at an unreclaimed pid: ${stillAlive
						.map((f) => `${f.id} (pid ${f.pid})`)
						.join(", ")}`,
	};

	const pending = facts.feeders.filter((f) => f.queued === true);
	const queueUnknown = facts.feeders.filter((f) => f.queued === null);
	const queueEstablished = pending.length === 0 && queueUnknown.length === 0;
	const queueDrained: SealElement = {
		established: queueEstablished,
		detail: queueEstablished
			? "no pending feeder job remains for this channel"
			: pending.length > 0
				? `feeder job(s) still pending: ${pending.map((f) => f.id).join(", ")}`
				: `feeder queue state could not be read for: ${queueUnknown
						.map((f) => f.id)
						.join(", ")}`,
	};

	const localClean =
		productStopProjection.established &&
		localTerminal.established &&
		feederProcessGone.established &&
		hostProcessGone.established &&
		queueDrained.established &&
		tokenCleanup.established;

	return {
		channelId: facts.channelId,
		...identity,
		...providerResources,
		productStopProjection,
		providerTerminal,
		localTerminal,
		feederProcessGone,
		hostProcessGone,
		queueDrained,
		tokenRequired,
		tokenCleanup,
		localClean,
		// Exact provider evidence does not exist at this phase.
		clean: false,
	};
}

/**
 * Join the local seal to the provider result derived from EV-01's exact,
 * post-teardown dossier. This is deliberately the only way `clean` can become
 * true; a local STOPPED projection alone can never call this evidence complete.
 */
export function finalizeLiveCleanupSeal(
	seal: LiveCleanupSeal,
	providerTerminal: SealElement,
): LiveCleanupSeal {
	return {
		...seal,
		providerTerminal,
		clean: seal.localClean && providerTerminal.established,
	};
}

/** The elements a seal could NOT establish, "name: detail" each — the reason a
 *  run seals INVALID instead of PASS. */
export function unestablishedCleanupElements(seal: LiveCleanupSeal): string[] {
	const named: [name: string, element: SealElement][] = [
		["local product stop projection", seal.productStopProjection],
		["provider terminal", seal.providerTerminal],
		["local terminal", seal.localTerminal],
		["feeder process gone", seal.feederProcessGone],
		["host process gone", seal.hostProcessGone],
		["queue drained", seal.queueDrained],
		["temporary token cleanup", seal.tokenCleanup],
	];
	return named
		.filter(([, element]) => !element.established)
		.map(([name, element]) => `${name}: ${element.detail}`);
}
