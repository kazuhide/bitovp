/**
 * Which live encodings Bitmovin is running that our database cannot account for.
 *
 * Four of them once billed for up to 7h19m while every `LiveChannel` row said
 * STOPPED . The teardown bug that caused it is fixed, and a short
 * forced auto-shutdown now caps any repeat — but a duplicate CREATE can still
 * leave an encoding that appears in NEITHER the channel's column NOR its step log,
 * so the union teardown cannot see it. Until now nothing could: the only tool took
 * the ids as arguments, so it could not find an orphan nobody had already noticed.
 *
 * This is the detection half, and it is deliberately ONLY detection. A job that
 * stops encodings the database cannot account for could stop the owner's own work —
 * that is a decision about blast radius, not a bug fix. What the product owes the
 * operator is the sentence "Bitmovin is running N live encodings we cannot explain",
 * not an automatic response to it.
 */

/** A live encoding as Bitmovin reports it. */
export type RunningLiveEncoding = {
	id: string;
	name?: string;
	status: string;
	/** ISO 8601; absent when the API did not report one. */
	createdAt?: string;
};

/**
 * The channel statuses from which teardown can still stop an encoding.
 *
 * `stopChannel` claims the row with `status: { in: ["RUNNING","STOPPING","ERROR"] }`
 * (live-processor.ts) and the heartbeat sweep queries RUNNING only. From any other
 * status — STOPPED above all — there is no code path that will ever stop that id.
 */
const STOPPABLE_CHANNEL_STATUSES: ReadonlySet<string> = new Set([
	"RUNNING",
	"STOPPING",
	"ERROR",
]);

/**
 * Statuses a channel passes THROUGH on its way to being stoppable.
 *
 * `live-processor.ts` sets PROVISIONING before the step loop, and `CREATE_ENCODING`
 * writes the encoding id mid-loop — so for the whole bring-up a non-terminal encoding
 * exists on a row that is not yet stoppable. Without this set every routine channel
 * start printed the loudest line in the tool ("nothing will ever stop it — this is
 * the  shape"), which is how an operator learns to skip it, and then it is
 * gone exactly when it matters (review catch).
 *
 * PROVISIONING is TRANSIENTLY unreachable and becomes RUNNING or ERROR, both
 * stoppable. STOPPED is TERMINALLY unreachable. Only the second is #48.
 */
const IN_FLIGHT_CHANNEL_STATUSES: ReadonlySet<string> = new Set([
	"CREATED",
	"PROVISIONING",
]);

/**
 * Every encoding id one of our channels knows about — WITH the status of the
 * channel that knows it.
 *
 * The status is the whole point, and leaving it out made the first version of this
 * module report  itself as zero orphans (review catch). In that incident
 * the four billing encodings WERE the step log's ids, on channels whose rows said
 * STOPPED. "A row names it" therefore meant nothing: no path stops an encoding for a
 * STOPPED channel, so the tool built to find that leak could not have found it.
 *
 * Known-of is not the same as reachable, and only the status distinguishes them.
 */
export type KnownEncodingIds = {
	/** id → owning channel's status. `LiveChannel.bitmovinEncodingId`. */
	fromColumn: Map<string, string>;
	/**
	 * id → owning channel's status, from the step logs. The 7h19m leak happened
	 * precisely because these two sources can differ: the column held one id and the
	 * step log's `CREATE_ENCODING` held the one that was actually running.
	 */
	fromStepLog: Map<string, string>;
};

export type OrphanEncoding = RunningLiveEncoding & {
	/** Whole minutes since creation, when the API reported a creation time. */
	ageMinutes?: number;
};

export type OrphanReport = {
	/** Non-terminal LIVE encodings Bitmovin reported. */
	running: number;
	/**
	 * Explained AND reachable: a row names it and that row is in a status teardown
	 * can still act from. `total` is unique ids; `byColumn`/`byStepLog` count each
	 * source and so can sum to more than `total` when both name the same id.
	 */
	accountedFor: { total: number; byColumn: number; byStepLog: number };
	/** The ones nothing explains — these cost money unnoticed. */
	orphans: OrphanEncoding[];
	/**
	 * CONTRADICTED: a row names it, but that row is in a status it will never leave
	 * toward a stoppable one. This is the  shape — rows saying STOPPED
	 * while their encodings billed — and it is deliberately NOT folded into
	 * `accountedFor`, because "we know about it" is what made those four invisible.
	 */
	contradicted: Array<OrphanEncoding & { channelStatus: string }>;
	/**
	 * IN FLIGHT: a row names it and that row is still provisioning. Normal, and
	 * separated from `contradicted` so the alarming bucket stays alarming.
	 */
	inFlight: Array<OrphanEncoding & { channelStatus: string }>;
};

/**
 * Pure: the diff, with no I/O, so the rule for "orphan" is testable on its own.
 *
 * An encoding counts as accounted for if EITHER source names it — the union, not
 * the column alone. Reading only the column is the bug this row exists for.
 */
export function orphanLiveEncodings(
	running: readonly RunningLiveEncoding[],
	known: KnownEncodingIds,
	now: Date,
): OrphanReport {
	let byColumn = 0;
	let byStepLog = 0;
	let total = 0;
	const orphans: OrphanEncoding[] = [];
	const contradicted: Array<OrphanEncoding & { channelStatus: string }> = [];
	const inFlight: Array<OrphanEncoding & { channelStatus: string }> = [];
	for (const encoding of running) {
		const columnStatus = known.fromColumn.get(encoding.id);
		const stepLogStatus = known.fromStepLog.get(encoding.id);
		const ageMinutes = encodingAgeMinutes(encoding, now);
		const withAge = {
			...encoding,
			...(ageMinutes !== undefined ? { ageMinutes } : {}),
		};
		if (columnStatus === undefined && stepLogStatus === undefined) {
			orphans.push(withAge);
			continue;
		}
		// Counted per source, NOT as an else-branch: an id in both is not evidence the
		// sources agree overall, and a disagreement is what this exists to surface.
		const reachableByColumn =
			columnStatus !== undefined &&
			STOPPABLE_CHANNEL_STATUSES.has(columnStatus);
		const reachableByStepLog =
			stepLogStatus !== undefined &&
			STOPPABLE_CHANNEL_STATUSES.has(stepLogStatus);
		if (reachableByColumn) {
			byColumn += 1;
		}
		if (reachableByStepLog) {
			byStepLog += 1;
		}
		if (reachableByColumn || reachableByStepLog) {
			total += 1;
			continue;
		}
		const channelStatus = columnStatus ?? stepLogStatus ?? "UNKNOWN";
		// Known and not yet stoppable. Transient (still provisioning) or terminal
		// (STOPPED, and nothing will ever come back for it) — only the second is the
		// #48 shape, and conflating them is how the alarm gets ignored.
		if (
			(columnStatus !== undefined &&
				IN_FLIGHT_CHANNEL_STATUSES.has(columnStatus)) ||
			(stepLogStatus !== undefined &&
				IN_FLIGHT_CHANNEL_STATUSES.has(stepLogStatus))
		) {
			inFlight.push({ ...withAge, channelStatus });
			continue;
		}
		contradicted.push({ ...withAge, channelStatus });
	}
	// NO `oldestOrphanMinutes`. It was computed over `orphans` only, so for the very
	// incident this module exists for — a 439-minute encoding a STOPPED row names —
	// it reported "no aged orphan" while `contradicted[0].ageMinutes` said 439. Unused
	// by the only consumer, unpinned, and wrong in the one case that matters: a
	// headline number that can drift is worse than none (review catch, agreed).
	return {
		running: running.length,
		accountedFor: { total, byColumn, byStepLog },
		orphans,
		contradicted,
		inFlight,
	};
}

/**
 * Age in whole minutes, or undefined when the API reported no creation time or an
 * unparseable one. Undefined rather than 0: a missing age must not read as "just
 * started", which is the reading that would make an orphan look harmless.
 */
function encodingAgeMinutes(
	encoding: RunningLiveEncoding,
	now: Date,
): number | undefined {
	if (encoding.createdAt === undefined) {
		return undefined;
	}
	const created = Date.parse(encoding.createdAt);
	if (Number.isNaN(created)) {
		return undefined;
	}
	return Math.max(0, Math.floor((now.getTime() - created) / 60_000));
}
