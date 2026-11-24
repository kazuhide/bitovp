import { type StepLogEntry, stepLogSchema } from "../plan/steplog";
import { hasAisaLiveStepLog } from "./aisa-finalization";

const paidSteps = new Set([
	"CREATE_ENCODING",
	"CREATE_AISA_LIVE_ANALYSIS",
	"RESOLVE_AISA_LIVE_ENCODING",
	"START_AISA_LIVE_ANALYSIS",
]);
const hasResponse = (entry: StepLogEntry) =>
	entry.response != null &&
	(typeof entry.response !== "object" ||
		Object.keys(entry.response).length > 0);

/** Restore positive provider evidence from the exact same airing before replaying its
 * compiler log. A contradictory ID or unmappable paid step cannot authorize a retry. */
export function restoreLiveProvisionEvidence(
	channelLog: unknown,
	runLog: unknown,
	primary?: string | null,
): StepLogEntry[] | null {
	const current = stepLogSchema.safeParse(channelLog);
	if (!current.success) return null;
	if (runLog == null || (Array.isArray(runLog) && !runLog.length))
		return current.data;
	const prior = stepLogSchema.safeParse(runLog);
	if (!prior.success) return null;
	if (!current.data.length) {
		const paid = prior.data.filter(
			(entry) =>
				paidSteps.has(entry.kind) &&
				(entry.resourceId || hasResponse(entry) || entry.status === "DONE"),
		);
		if (
			primary &&
			paid.some(
				(e) =>
					e.kind === "CREATE_ENCODING" &&
					e.resourceId &&
					e.resourceId !== primary,
			)
		)
			return null;
		return paid.length ||
			prior.data.some((entry) => entry.kind === "AWAIT_LIVE_RUNNING")
			? prior.data
			: current.data;
	}
	const managed =
		hasAisaLiveStepLog(current.data) || hasAisaLiveStepLog(prior.data);
	for (const saved of prior.data) {
		if (
			!paidSteps.has(saved.kind) ||
			(!saved.resourceId && !hasResponse(saved) && saved.status !== "DONE")
		)
			continue;
		// An intentionally displaced native RTMP encoder has its own retirement history.
		if (
			saved.kind === "CREATE_ENCODING" &&
			(!primary || saved.resourceId !== primary)
		)
			continue;
		const target = current.data.find(
			(e) => e.kind === saved.kind && e.step === saved.step,
		);
		if (
			!target ||
			(target.resourceId &&
				saved.resourceId &&
				target.resourceId !== saved.resourceId)
		)
			return null;
		if (saved.resourceId && !target.resourceId)
			target.resourceId = saved.resourceId;
		if (
			saved.status === "DONE" &&
			(target.resourceId || saved.kind === "START_AISA_LIVE_ANALYSIS")
		)
			target.status = "DONE";
		if (managed && hasResponse(saved)) {
			const marker =
				saved.kind === "CREATE_AISA_LIVE_ANALYSIS"
					? "aisaCreateDispatched"
					: saved.kind === "START_AISA_LIVE_ANALYSIS"
						? "aisaStartDispatched"
						: null;
			if (
				marker &&
				typeof saved.response === "object" &&
				saved.response &&
				marker in saved.response &&
				!target.resourceId
			) {
				target.response = {
					...(typeof target.response === "object" &&
					!Array.isArray(target.response)
						? target.response
						: {}),
					[marker]: true,
				};
			} else if (!hasResponse(target)) target.response = saved.response;
		}
	}
	return current.data;
}
