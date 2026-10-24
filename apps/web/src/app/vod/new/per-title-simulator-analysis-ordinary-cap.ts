import {
	PER_TITLE_MIN_BITRATE,
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";

export type PerTitleOrdinaryCapAssessment = {
	status: "permitted" | "blocked" | "unavailable";
	count: number | null;
	cap: number;
	lastSlot: { minimum: number; maximum: number } | null;
	/** Integer spacing compatibility only, independent of native media selection. */
	scope: "spacing-only";
};

/** A cap-ending chain is separate from the count-cap and native-output checks. */
export function assessPerTitleOrdinaryCap(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
): PerTitleOrdinaryCapAssessment {
	const result: PerTitleOrdinaryCapAssessment = {
		status: "unavailable",
		count: goal.countPolicy.kind === "exact" ? goal.countPolicy.count : null,
		cap: goal.maxBitrate,
		lastSlot: null,
		scope: "spacing-only",
	};
	if (
		goal.countPolicy.kind !== "exact" ||
		proposal.codec !== goal.codec ||
		proposal.api.global.minBitrate !== goal.minBitrate ||
		proposal.api.global.maxBitrate !== goal.maxBitrate ||
		proposal.api.global.minBitrate < PER_TITLE_MIN_BITRATE ||
		proposal.diagnostics.some(
			(diagnostic) =>
				diagnostic.severity === "conflict" &&
				(diagnostic.code === "invalid-setting" ||
					diagnostic.code === "model-limit"),
		) ||
		proposal.api.streams.length === 0 ||
		proposal.api.streams.some((stream) => stream.mode !== "PER_TITLE_TEMPLATE")
	)
		return result;
	const preview = previewPerTitleOutput(proposal, {
		countPolicy: goal.countPolicy,
	});
	if (preview.countProjection?.status !== "conditional") return result;
	const slots = preview.rows.filter((row) => row.kind === "count-slot");
	const last = slots.at(-1);
	if (
		slots.length !== goal.countPolicy.count ||
		last?.minimumBitrate === undefined ||
		last.maximumBitrate === undefined
	)
		return result;
	return {
		...result,
		status: last.maximumBitrate === goal.maxBitrate ? "permitted" : "blocked",
		lastSlot: {
			minimum: last.minimumBitrate,
			maximum: last.maximumBitrate,
		},
	};
}
