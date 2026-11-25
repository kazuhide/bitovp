import {
	isRuntimeRecordKind,
	type StepLogEntry,
	stepLogSchema,
} from "../plan/steplog";

const paidSteps = new Set([
	"CREATE_ENCODING",
	"START_LIVE_ENCODING",
	"CREATE_AISA_LIVE_ANALYSIS",
	"RESOLVE_AISA_LIVE_ENCODING",
	"START_AISA_LIVE_ANALYSIS",
]);
const native = (entry: StepLogEntry) =>
	entry.kind === "CREATE_ENCODING" || entry.kind === "START_LIVE_ENCODING";
const start = (entry: StepLogEntry) =>
	entry.kind === "START_LIVE_ENCODING" ||
	entry.kind === "START_AISA_LIVE_ANALYSIS";
const response = (entry: StepLogEntry): Record<string, unknown> =>
	entry.response &&
	typeof entry.response === "object" &&
	!Array.isArray(entry.response)
		? (entry.response as Record<string, unknown>)
		: {};

/** Whether this ordinary CREATE or START crossed its local attempt boundary. */
export function nativeProvisionMayHaveSent(entry: StepLogEntry): boolean {
	return (
		native(entry) &&
		(!!entry.startedAt ||
			!!entry.resourceId ||
			entry.status === "RUNNING" ||
			entry.status === "DONE" ||
			response(entry).started === true)
	);
}
/** Stream, muxing and DRM children use adoptOrCreateStamped under their
 * exact parent. An older reseed can have kept only the original start time. */
export function interruptedLiveChildCreate(entry: StepLogEntry): boolean {
	return (
		(entry.kind === "CREATE_STREAM" ||
			entry.kind.startsWith("CREATE_MUXING_") ||
			entry.kind.startsWith("CREATE_DRM_")) &&
		entry.status !== "DONE" &&
		(entry.adoptExistingOnly === true ||
			entry.status === "RUNNING" ||
			(entry.status === "PENDING" && !!entry.startedAt && !entry.finishedAt))
	);
}

function runtimeIdentity(entry: StepLogEntry): string {
	const { status: _status, error: _error, ...record } = entry;
	return JSON.stringify(record, (_key, value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([left], [right]) =>
						left < right ? -1 : left > right ? 1 : 0,
					),
				)
			: value,
	);
}

/** Runtime rows are event occurrences. Their historical timestamp-based keys
 * can coincide. Match occurrences between mirrors, including repeated identical
 * events, while preserving the order of each journal's missing history. */
function restoreRuntimeHistory(
	current: StepLogEntry[],
	saved: StepLogEntry[],
): boolean {
	const executable = new Set(
		[...current, ...saved]
			.filter((row) => !isRuntimeRecordKind(row.kind))
			.map((row) => row.step),
	);
	const occurrences = new Map<
		string,
		{ rows: StepLogEntry[]; consumed: number }
	>();
	for (const row of current) {
		if (!isRuntimeRecordKind(row.kind)) continue;
		if (executable.has(row.step)) return false;
		const identity = runtimeIdentity(row);
		const group = occurrences.get(identity);
		if (group) group.rows.push(row);
		else occurrences.set(identity, { rows: [row], consumed: 0 });
	}
	for (const row of saved) {
		if (!isRuntimeRecordKind(row.kind)) continue;
		if (executable.has(row.step)) return false;
		const group = occurrences.get(runtimeIdentity(row));
		const mirror = group?.rows[group.consumed++];
		if (!mirror) current.push(row);
		else if (row.status === "DONE" && mirror.status !== "DONE")
			Object.assign(mirror, row);
	}
	return true;
}

function evidence(entry: StepLogEntry) {
	return (
		paidSteps.has(entry.kind) &&
		(nativeProvisionMayHaveSent(entry) ||
			!!entry.resourceId ||
			entry.status === "DONE" ||
			Object.keys(response(entry)).length > 0)
	);
}

/** A freshly compiled graph has no generation. Only the locked same-airing run
 * journal can supply it. RTMP rebuilds advance the input and its entire suffix
 * together; the archive is written before the new journal. A disagreement
 * across that write boundary must not resurrect an abandoned resource. */
export function restoreCompiledLiveProvisionGraph(
	compiledLog: unknown,
	runLog: unknown,
	primary: string | null,
	archivedRtmpAttempt: number,
): StepLogEntry[] | null {
	const compiled = stepLogSchema.safeParse(compiledLog);
	const run = stepLogSchema.safeParse(runLog ?? []);
	if (
		!compiled.success ||
		!run.success ||
		!Number.isSafeInteger(archivedRtmpAttempt) ||
		archivedRtmpAttempt < 0
	)
		return null;
	const graph = compiled.data;
	if (
		graph.some(
			(entry) =>
				entry.status !== "PENDING" ||
				entry.attempt ||
				entry.resourceId ||
				entry.startedAt ||
				isRuntimeRecordKind(entry.kind),
		)
	)
		return null;
	const executable = run.data.filter(
		(entry) => !isRuntimeRecordKind(entry.kind),
	);
	const byStep = new Map(executable.map((entry) => [entry.step, entry]));
	if (
		byStep.size !== executable.length ||
		(primary &&
			run.data.some(
				(entry) =>
					entry.kind === "CREATE_ENCODING" &&
					entry.resourceId &&
					entry.resourceId !== primary,
			))
	)
		return null;
	const boundary = graph.findIndex(
		(entry) => entry.kind === "CREATE_INPUT_RTMP",
	);
	if (archivedRtmpAttempt > 0) {
		const input = graph[boundary];
		const recorded = input && byStep.get(input.step);
		if (
			recorded?.kind !== "CREATE_INPUT_RTMP" ||
			recorded.attempt !== archivedRtmpAttempt
		)
			return null;
	}
	for (const [index, entry] of graph.entries()) {
		const generation =
			boundary >= 0 && index >= boundary ? archivedRtmpAttempt : 0;
		const recorded = byStep.get(entry.step);
		if (
			recorded &&
			(recorded.kind !== entry.kind || (recorded.attempt ?? 0) !== generation)
		)
			return null;
		if (generation) entry.attempt = generation;
		// Preserve the exact same-attempt request and timestamp, also for a
		// non-paid CREATE whose crash adoption will use that send window.
		if (recorded) Object.assign(entry, recorded);
	}
	return restoreLiveProvisionEvidence(graph, run.data, primary, true);
}

/** Restore positive provider evidence from this airing and RTMP generation.
 * A successful send supersedes its in-flight marker. A newer generation, an
 * incompatible provider ID, or a paid step absent from the graph cannot be replayed. */
export function restoreLiveProvisionEvidence(
	channelLog: unknown,
	runLog: unknown,
	primary?: string | null,
	restoreCompletedGraph = false,
): StepLogEntry[] | null {
	const current = stepLogSchema.safeParse(channelLog);
	if (!current.success) return null;
	if (runLog == null || (Array.isArray(runLog) && !runLog.length))
		return current.data;
	const prior = stepLogSchema.safeParse(runLog);
	if (!prior.success) return null;
	const receipts = prior.data.filter(
		(step) =>
			evidence(step) ||
			(restoreCompletedGraph &&
				(step.status === "DONE" ||
					isRuntimeRecordKind(step.kind) ||
					interruptedLiveChildCreate(step))),
	);
	if (!current.data.length) {
		if (
			primary &&
			receipts.some(
				(e) =>
					e.kind === "CREATE_ENCODING" &&
					e.resourceId &&
					e.resourceId !== primary,
			)
		)
			return null;
		return receipts.length ||
			prior.data.some((e) => e.kind === "AWAIT_LIVE_RUNNING")
			? prior.data
			: current.data;
	}
	if (restoreCompletedGraph && !restoreRuntimeHistory(current.data, prior.data))
		return null;
	for (const saved of receipts) {
		if (isRuntimeRecordKind(saved.kind)) continue;
		const target = current.data.find(
			(e) => e.kind === saved.kind && e.step === saved.step,
		);
		// Older runs can retain additional completed CREATE receipts after a rebuild.
		// The run snapshot and retirement inventory preserve these separate IDs.
		if (
			!target &&
			saved.kind === "CREATE_ENCODING" &&
			saved.status === "DONE" &&
			saved.resourceId &&
			primary &&
			saved.resourceId !== primary
		)
			continue;
		if (!target) return null;
		if ((saved.attempt ?? 0) < (target.attempt ?? 0)) continue;
		if (
			(saved.attempt ?? 0) > (target.attempt ?? 0) ||
			(target.resourceId &&
				saved.resourceId &&
				target.resourceId !== saved.resourceId) ||
			(saved.kind === "CREATE_ENCODING" &&
				primary &&
				saved.resourceId &&
				saved.resourceId !== primary)
		)
			return null;
		if (
			restoreCompletedGraph &&
			!paidSteps.has(saved.kind) &&
			saved.status === "DONE"
		) {
			// A same-airing revival can start from a freshly compiled graph.
			// Its pending copy must retain the exact completed stream, muxing,
			// manifest or other step from this generation, including its payload.
			if (target.status !== "DONE") Object.assign(target, saved);
			continue;
		}
		if (
			restoreCompletedGraph &&
			interruptedLiveChildCreate(saved) &&
			target.status !== "DONE"
		) {
			target.adoptExistingOnly = true;
		}
		if (saved.resourceId && !target.resourceId)
			target.resourceId = saved.resourceId;
		if (saved.status === "DONE" && (target.resourceId || start(saved)))
			target.status = "DONE";
		const receipt = response(target);
		if (
			native(saved) &&
			saved.startedAt &&
			receipt.cancelledBeforeSendAt === saved.startedAt &&
			!saved.resourceId &&
			saved.status !== "DONE" &&
			response(saved).started !== true
		)
			continue;
		if (saved.startedAt && !target.startedAt)
			target.startedAt = saved.startedAt;
		if (
			native(saved) &&
			target.status === "PENDING" &&
			saved.status === "RUNNING"
		)
			target.status = "RUNNING";
		const acceptedStart =
			start(target) && target.status === "DONE" && receipt.started === true;
		if (acceptedStart || !Object.keys(response(saved)).length) continue;
		if (start(saved) && response(saved).started === true) {
			target.response = saved.response;
			target.status = "DONE";
			continue;
		}
		const marker =
			saved.kind === "CREATE_AISA_LIVE_ANALYSIS"
				? "aisaCreateDispatched"
				: saved.kind === "START_AISA_LIVE_ANALYSIS"
					? "aisaStartDispatched"
					: null;
		if (marker && response(saved)[marker] === true && !target.resourceId)
			target.response = { ...receipt, [marker]: true };
		else if (
			!Object.keys(receipt).length &&
			(!marker || response(saved)[marker] !== true)
		)
			target.response = saved.response;
	}
	return current.data;
}
