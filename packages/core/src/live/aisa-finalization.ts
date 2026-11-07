import { z } from "zod";
import { aisaResultSchema } from "./aisa-result";

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
