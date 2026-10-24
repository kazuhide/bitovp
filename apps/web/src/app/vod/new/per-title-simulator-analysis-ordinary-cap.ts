import {
	PER_TITLE_MIN_BITRATE,
	type PerTitleGoal,
	type PerTitleProposal,
	previewPerTitleOutput,
} from "@bitovp/core";

export type PerTitleOrdinaryCapAssessment = {
	status: "permitted" | "blocked" | "unavailable";
	/** Available spacing bound's placement length, not a predicted output count. */
	count: number | null;
	cap: number;
	lastSlot: { minimum: number; maximum: number } | null;
	reason?: "placement-limit";
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
	const limit =
		goal.countPolicy.kind === "unrestricted" ? 256 : goal.countPolicy.count;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 256 ||
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
	// These are placement hypotheses, not changes to the actual count policy.
	const project = (count: number) =>
		previewPerTitleOutput(proposal, {
			countPolicy: { kind: "exact", count },
		});
	let count = limit;
	if (goal.countPolicy.kind !== "exact") {
		if (project(1).countProjection?.status !== "conditional") return result;
		let lower = 1,
			upper = limit;
		// Feasibility is prefix-closed. Among feasible lengths the final upper
		// bound never decreases, so the longest chain also decides cap permission.
		while (lower < upper) {
			const middle = Math.ceil((lower + upper) / 2);
			const status = project(middle).countProjection?.status;
			if (status === "conditional") lower = middle;
			else if (status === "infeasible") upper = middle - 1;
			else return result;
		}
		count = lower;
	}
	const preview = project(count);
	if (preview.countProjection?.status !== "conditional") return result;
	const slots = preview.rows.filter((row) => row.kind === "count-slot");
	const last = slots.at(-1);
	if (
		slots.length !== count ||
		last?.minimumBitrate === undefined ||
		last.maximumBitrate === undefined
	)
		return result;
	const permitted = last.maximumBitrate === goal.maxBitrate;
	// A longer unrestricted chain may still work beyond the finite model bound.
	if (!permitted && goal.countPolicy.kind === "unrestricted" && count === limit)
		return { ...result, reason: "placement-limit" };
	return {
		...result,
		count,
		status: permitted ? "permitted" : "blocked",
		lastSlot: { minimum: last.minimumBitrate, maximum: last.maximumBitrate },
	};
}
