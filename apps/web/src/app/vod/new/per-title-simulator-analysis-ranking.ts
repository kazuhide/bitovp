import type { PerTitleProposal } from "@bitovp/core";
import type { assessPerTitleCountStructure } from "./per-title-simulator-analysis-count";
import type { PerTitleLadderAssessment } from "./per-title-simulator-analysis-ladder";

/** Configuration movement only; these costs measure neither bitrate savings nor quality. */
export function perTitleAnalysisCandidateCosts(
	before: PerTitleProposal,
	after: PerTitleProposal,
	structure: ReturnType<typeof assessPerTitleCountStructure>,
	ladder: PerTitleLadderAssessment,
): Record<string, number> {
	const oldRule = before.api.global.fixedResolutionAndBitrateConfiguration;
	const rule = after.api.global.fixedResolutionAndBitrateConfiguration;
	const forcingChanges = [
		"forcedRenditionAboveHighestFixedRepresentation",
		"forcedRenditionAboveHighestFixedRepresentationFactor",
		"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
	].filter(
		(key) =>
			!Object.is(
				oldRule?.[key as keyof NonNullable<typeof oldRule>],
				rule?.[key as keyof NonNullable<typeof rule>],
			),
	).length;
	let fixedBandMovement = 0;
	for (const row of before.api.streams) {
		if (row.mode !== "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE")
			continue;
		const next = after.api.streams.find(
			(candidate) => candidate.rowId === row.rowId,
		);
		for (const key of ["minBitrate", "maxBitrate"] as const) {
			const a = row.perTitleSettings?.[key];
			const b = next?.perTitleSettings?.[key];
			if (typeof a !== "number" || typeof b !== "number" || a <= 0 || b <= 0) {
				fixedBandMovement = Number.MAX_VALUE;
				break;
			}
			fixedBandMovement += Math.abs(Math.log(b / a));
		}
	}
	const known =
		structure.status === "declared-compatible" &&
		structure.lower !== null &&
		structure.upper !== null &&
		ladder.lowerSlots !== null &&
		ladder.upperSlots !== null;
	const forced = rule?.forcedRenditionAboveHighestFixedRepresentation ?? 0;
	// Normal upper placements and forced fallback share one alternative role.
	// Removing the normal branch cannot earn a smaller upper-role cost by itself.
	const upper = Math.max(ladder.upperSlots?.maximum ?? 256, forced);
	return {
		forcingChanges,
		fixedBandMovement,
		roleBudgetKnown: Number(known),
		roleBudgetExcess: known
			? Math.max(
					0,
					(ladder.lowerSlots?.maximum ?? 256) -
						(structure.lower?.required ?? 0),
				) + Math.max(0, upper - (structure.upper?.required ?? 0))
			: 0,
	};
}
