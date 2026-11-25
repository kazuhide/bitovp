import { type StepLogEntry, stepLogSchema } from "../plan/steplog";

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
function evidence(entry: StepLogEntry) {
	return (
		paidSteps.has(entry.kind) &&
		(nativeProvisionMayHaveSent(entry) ||
			!!entry.resourceId ||
			entry.status === "DONE" ||
			Object.keys(response(entry)).length > 0)
	);
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
			evidence(step) || (restoreCompletedGraph && step.status === "DONE"),
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
	for (const saved of receipts) {
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
