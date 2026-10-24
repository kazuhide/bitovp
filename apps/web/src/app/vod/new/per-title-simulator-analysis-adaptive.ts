import {
	certifyPerTitleMixedSequence,
	type PerTitleGoal,
	type PerTitleProposal,
} from "@bitovp/core";
import { hasPerTitleEvaluationCountEvidence } from "./per-title-simulator-advice";
import type { PerTitleLadderAssessment } from "./per-title-simulator-analysis-ladder";
import type { PerTitleOrdinaryCapAssessment } from "./per-title-simulator-analysis-ordinary-cap";
import type { PerTitleReachAssessment } from "./per-title-simulator-analysis-reach";
import { assessPerTitleUpperLimit } from "./per-title-simulator-upper-limit";

export function adaptiveCountSatisfied(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): boolean {
	if (goal.countPolicy.kind === "unrestricted") return true;
	if (hasPerTitleEvaluationCountEvidence(goal, proposal)) return true;
	const report = proposal.derivation?.constraints;
	const certificate = certifyPerTitleMixedSequence(goal, proposal.api);
	return (
		proposal.applicable &&
		proposal.status === "candidate" &&
		proposal.derivation?.targetSatisfied === true &&
		report?.status === "checked" &&
		report.scope === "conditional" &&
		certificate !== null &&
		JSON.stringify(certificate) === JSON.stringify(report.conditionalModel)
	);
}

/** Count constraints and cap permission must pass together; native selection stays separate. */
export function adaptiveSatisfied(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	reach: PerTitleReachAssessment,
	cap: PerTitleOrdinaryCapAssessment,
	ladder: PerTitleLadderAssessment,
): boolean {
	if (
		proposal.status === "conflict" ||
		(goal.countPolicy.kind !== "unrestricted" &&
			(!proposal.applicable || proposal.status !== "candidate")) ||
		proposal.diagnostics.some((item) => item.severity === "conflict") ||
		!adaptiveCountSatisfied(goal, proposal)
	)
		return false;
	if (
		proposal.api.streams.length > 0 &&
		proposal.api.streams.every((row) => row.mode === "PER_TITLE_TEMPLATE")
	)
		return (
			proposal.applicable &&
			proposal.status === "candidate" &&
			cap.status === "permitted"
		);
	const proof = ladder.intervals,
		global = proposal.api.global;
	return (
		reach.status === "conditional-reachable" &&
		reach.adaptation === "conditional" &&
		proof !== null &&
		proof.maximumWithinRowRatio + 0.01 < global.minBitrateStepSize &&
		(proof.minimumAdjacentRatio ?? Infinity) >= global.minBitrateStepSize &&
		(proof.maximumAdjacentRatio ?? 0) <= global.maxBitrateStepSize &&
		(goal.countPolicy.kind === "unrestricted" ||
			ladder.lowerConnection?.fitsMaximum !== false) &&
		assessPerTitleUpperLimit(goal, proposal).finding === null
	);
}

/** Editing bitrate constraints does not establish equal quality or measured savings. */
export function preservesAdaptiveRolesAndQuality(
	before: PerTitleProposal,
	after: PerTitleProposal,
): boolean {
	const keys = [
		"targetQualityCrf",
		"targetQualityQp",
		"complexityFactor",
		"resolutionScaleFactor",
		"codecMinBitrateFactor",
		"codecMaxBitrateFactor",
		"codecBufsizeFactor",
	] as const;
	if (
		before.codec !== after.codec ||
		before.api.streams.length !== after.api.streams.length ||
		keys.some(
			(key) => !Object.is(before.api.global[key], after.api.global[key]),
		)
	)
		return false;
	return before.api.streams.every((row) => {
		const next = after.api.streams.find((item) => item.rowId === row.rowId);
		return (
			next !== undefined &&
			next.mode === row.mode &&
			next.height === row.height &&
			next.width === row.width &&
			Object.is(
				next.perTitleSettings?.codecMaxBitrateFactor,
				row.perTitleSettings?.codecMaxBitrateFactor,
			) &&
			Object.is(
				next.perTitleSettings?.codecBufsizeFactor,
				row.perTitleSettings?.codecBufsizeFactor,
			)
		);
	});
}
