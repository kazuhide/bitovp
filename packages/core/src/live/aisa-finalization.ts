import { z } from "zod";
import { type StepLogEntry, stepLogSchema } from "../plan/steplog";
import { aisaResultSchema } from "./aisa-result";

export const aisaNeverStartedProofSchema = z.discriminatedUnion("basis", [
	z.object({
		kind: z.literal("NEVER_STARTED"),
		basis: z.literal("CREATE_NOT_DISPATCHED"),
		runId: z.uuid(),
		observedAt: z.iso.datetime({ offset: true }),
	}),
	z.object({
		kind: z.literal("NEVER_STARTED"),
		basis: z.literal("BOUND_CREATED_NOT_STARTED"),
		runId: z.uuid(),
		analysisId: z.uuid(),
		encodingId: z.uuid(),
		analysisStatus: z.literal("CREATED"),
		encodingStatus: z.literal("CREATED"),
		observedAt: z.iso.datetime({ offset: true }),
	}),
]);
export type AisaNeverStartedProof = z.infer<typeof aisaNeverStartedProofSchema>;
function managedEntries(log: unknown): StepLogEntry[] | null {
	const parsed = stepLogSchema.safeParse(log);
	const kinds = [
		"CREATE_AISA_LIVE_ANALYSIS",
		"RESOLVE_AISA_LIVE_ENCODING",
		"START_AISA_LIVE_ANALYSIS",
		"AWAIT_LIVE_RUNNING",
	];
	return parsed.success &&
		parsed.data.length === kinds.length &&
		parsed.data.every((entry, index) => entry.kind === kinds[index])
		? parsed.data
		: null;
}
const emptyResponse = (entry: StepLogEntry) =>
	entry.response === undefined ||
	entry.response === null ||
	(typeof entry.response === "object" &&
		!Array.isArray(entry.response) &&
		Object.keys(entry.response).length === 0);
/** The durable dispatch marker precedes POST. CREATE timing alone is a preflight read. */
export function aisaCreateNotDispatched(log: unknown): boolean {
	const entries = managedEntries(log);
	return Boolean(
		entries?.every(
			(entry, index) =>
				!entry.resourceId &&
				emptyResponse(entry) &&
				entry.status !== "DONE" &&
				(index === 0 || (!entry.startedAt && entry.status === "PENDING")),
		),
	);
}
export function aisaStartNotDispatched(
	log: unknown,
	analysisId: string,
	encodingId: string,
): boolean {
	const entries = managedEntries(log);
	return Boolean(
		entries &&
			entries[0]?.status === "DONE" &&
			entries[0].resourceId === analysisId &&
			entries[1]?.status === "DONE" &&
			entries[1].resourceId === encodingId &&
			entries[2]?.status !== "DONE" &&
			!entries[2]?.resourceId &&
			emptyResponse(entries[2] as StepLogEntry) &&
			entries[3]?.status === "PENDING" &&
			!entries[3].startedAt &&
			!entries[3].resourceId,
	);
}
export function aisaLiveNeverStarted(
	run: AisaFinalizationRun & {
		id?: unknown;
		stepLog?: unknown;
		encoderStoppedConfirmedFor?: unknown;
	},
	channel: {
		bitmovinEncodingId?: unknown;
		stepLog?: unknown;
		encoderStoppedConfirmedFor?: unknown;
	},
): boolean {
	const proof = aisaNeverStartedProofSchema.safeParse(run.aisaFinalization);
	if (!proof.success || proof.data.runId !== run.id) return false;
	if (proof.data.basis === "CREATE_NOT_DISPATCHED")
		return (
			!run.aisaAnalysisId &&
			!run.bitmovinEncodingId &&
			!channel.bitmovinEncodingId &&
			aisaCreateNotDispatched(run.stepLog) &&
			aisaCreateNotDispatched(channel.stepLog)
		);
	const { analysisId, encodingId } = proof.data;
	return (
		run.aisaAnalysisId === analysisId &&
		run.bitmovinEncodingId === encodingId &&
		channel.bitmovinEncodingId === encodingId &&
		run.aisaStatus === "CREATED" &&
		run.providerStatus === "CREATED" &&
		run.encoderStoppedConfirmedFor === encodingId &&
		channel.encoderStoppedConfirmedFor === encodingId &&
		aisaStartNotDispatched(run.stepLog, analysisId, encodingId) &&
		aisaStartNotDispatched(channel.stepLog, analysisId, encodingId)
	);
}

/** Separate local readback evidence; never mixed into provider result JSON. */
export const aisaFinalizationProofSchema = z.object({
	analysisId: z.uuid(),
	encodingId: z.uuid(),
	status: z.enum(["FINISHED", "ERROR", "CANCELED", "TRANSFER_ERROR"]),
	result: z.enum([
		"FINAL",
		"AVAILABLE_PARTIAL",
		"UNAVAILABLE_TERMINAL_FAILURE",
	]),
	observedAt: z.iso.datetime({ offset: true }),
});
export type AisaFinalizationProof = z.infer<typeof aisaFinalizationProofSchema>;
export type AisaFinalizationRun = {
	aisaAnalysisId?: unknown;
	bitmovinEncodingId?: unknown;
	aisaStatus?: unknown;
	aisaSnapshot?: unknown;
	aisaFinalization?: unknown;
	providerStatus?: unknown;
};

/** Encoder termination and Analysis completion are independent provider facts. */
export function aisaLiveFinalization(
	run: AisaFinalizationRun,
): "UNBOUND" | "PENDING" | "COMPLETE" | "FAILED" {
	if (!run.aisaAnalysisId) return "UNBOUND";
	if (
		typeof run.aisaAnalysisId !== "string" ||
		typeof run.bitmovinEncodingId !== "string" ||
		!["FINISHED", "ERROR", "CANCELED", "TRANSFER_ERROR"].includes(
			String(run.providerStatus),
		)
	)
		return "PENDING";
	const result = aisaResultSchema.safeParse(run.aisaSnapshot);
	const samePair = (value: { analysisId: string; encodingId: string }) =>
		value.analysisId === run.aisaAnalysisId &&
		value.encodingId === run.bitmovinEncodingId;
	if (run.aisaStatus === "FINISHED") {
		if (!result.success || !samePair(result.data) || !result.data.isFinal)
			return "PENDING";
		return run.providerStatus === "FINISHED" ? "COMPLETE" : "FAILED";
	}
	if (!["ERROR", "CANCELED", "TRANSFER_ERROR"].includes(String(run.aisaStatus)))
		return "PENDING";
	if (result.success && samePair(result.data)) return "FAILED";
	const proof = aisaFinalizationProofSchema.safeParse(run.aisaFinalization);
	return proof.success &&
		samePair(proof.data) &&
		proof.data.status === run.aisaStatus &&
		proof.data.result === "UNAVAILABLE_TERMINAL_FAILURE"
		? "FAILED"
		: "PENDING";
}
