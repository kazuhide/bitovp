import { parseFeederError } from "@bitovp/core";

/**
 * Legacy feeder rows may contain support diagnostics instead of customer
 * guidance. Keep the classifier server-safe and locale-free so API projections
 * can withhold that raw text before it crosses the customer boundary; the UI
 * uses the same predicate as a mixed-version defence.
 */
const INTERNAL_FEEDER_ERROR =
	/\b(?:workers?|ffmpeg|pids?|sigterm|sigkill|cli|redis|brokers?|orchestrators?)\b|(?:^|\s)-stream_loop\b|\bbitovp\b/i;

export function isInternalFeederError(stored: string): boolean {
	// Structured refusals are customer contracts: the UI translates their code
	// and renders only defined parameters. Do not let a technical word inside a
	// media-difference parameter turn that whole actionable refusal generic.
	if (parseFeederError(stored)) {
		return false;
	}
	return INTERNAL_FEEDER_ERROR.test(stored);
}
