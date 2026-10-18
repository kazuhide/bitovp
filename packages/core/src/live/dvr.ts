/**
 * C8 — DVR / timeshift manifest-element budget (COVERAGE §0). Live
 * manifests hold roughly ceil(timeshift / segmentLength) elements per
 * rendition with a practical ceiling around 54,000 total; Bitmovin
 * recommends timeshift ≤ 3h. Pure math for the wizard gauge and the
 * validator — it NEVER clamps: callers get the numbers and decide.
 */

export const LIVE_MANIFEST_ELEMENT_BUDGET = 54000;

/** Bitmovin's recommended timeshift ceiling (3h) — UI copy, not a clamp. */
export const RECOMMENDED_MAX_TIMESHIFT_SEC = 10800;

export type DvrBudgetLevel = "ok" | "warning" | "over";

export type ManifestElementEstimate = {
	segmentsPerRendition: number;
	totalElements: number;
	budget: typeof LIVE_MANIFEST_ELEMENT_BUDGET;
	/** totalElements / budget — exceeds 1 when over (unclamped by design). */
	utilization: number;
	/** warning above 0.8 utilization, over above 1.0 (both exclusive). */
	level: DvrBudgetLevel;
};

function assertPositive(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number`);
	}
}

export function manifestElementEstimate(input: {
	timeshiftSec: number;
	segmentLengthSec: number;
	renditionCount: number;
}): ManifestElementEstimate {
	const { timeshiftSec, segmentLengthSec, renditionCount } = input;
	// timeshift 0 = no DVR window — a valid estimate of zero elements.
	if (!Number.isFinite(timeshiftSec) || timeshiftSec < 0) {
		throw new RangeError("timeshiftSec must be a non-negative finite number");
	}
	assertPositive("segmentLengthSec", segmentLengthSec);
	if (!Number.isInteger(renditionCount) || renditionCount <= 0) {
		throw new RangeError("renditionCount must be a positive integer");
	}
	const segmentsPerRendition = Math.ceil(timeshiftSec / segmentLengthSec);
	const totalElements = segmentsPerRendition * renditionCount;
	const utilization = totalElements / LIVE_MANIFEST_ELEMENT_BUDGET;
	return {
		segmentsPerRendition,
		totalElements,
		budget: LIVE_MANIFEST_ELEMENT_BUDGET,
		utilization,
		level: utilization > 1 ? "over" : utilization > 0.8 ? "warning" : "ok",
	};
}

/**
 * Largest timeshift (seconds) that keeps the estimate within budget for a
 * uniform ladder: floor(budget / renditions) whole segments per rendition.
 */
export function recommendedMaxTimeshiftSec(input: {
	segmentLengthSec: number;
	renditionCount: number;
}): number {
	const { segmentLengthSec, renditionCount } = input;
	assertPositive("segmentLengthSec", segmentLengthSec);
	if (!Number.isInteger(renditionCount) || renditionCount <= 0) {
		throw new RangeError("renditionCount must be a positive integer");
	}
	return (
		Math.floor(LIVE_MANIFEST_ELEMENT_BUDGET / renditionCount) * segmentLengthSec
	);
}
