import {
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";

export type PerTitleSuggestion = {
	id: string;
	reason: "global-range" | "required-count" | "fixed-only" | "without-forced";
	goal: PerTitleGoal;
	proposal: PerTitleProposal;
	changedFields: string[];
};

function meetsGoal(goal: PerTitleGoal, proposal: PerTitleProposal): boolean {
	if (!proposal.applicable || proposal.status !== "candidate") return false;
	const high = proposal.scenarios.find((scenario) => scenario.fraction === 1);
	if (high?.status !== "modelled" || !high.modelCountRange) return false;
	if (goal.countPolicy.kind === "unrestricted") return true;
	if (
		high.modelCountRange.maximum > goal.countPolicy.count ||
		high.modelCountRange.minimum > goal.countPolicy.count
	)
		return false;
	return (
		goal.countPolicy.kind !== "exact" ||
		high.modelRungs.length === goal.countPolicy.count
	);
}
function changedFields(before: PerTitleGoal, after: PerTitleGoal): string[] {
	const fields = (Object.keys(after) as Array<keyof PerTitleGoal>).concat(
		Object.keys(before) as Array<keyof PerTitleGoal>,
	);
	return [...new Set(fields)]
		.filter(
			(field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
		)
		.map((field) =>
			field === "countPolicy" &&
			before.countPolicy.kind === after.countPolicy.kind
				? "countPolicy.count"
				: field,
		)
		.sort();
}

/** Offers at most four explicit model tradeoffs; it does not predict native quality or output. */
export function perTitleSuggestions(goal: PerTitleGoal): PerTitleSuggestion[] {
	// Bound all core helper work before cloning or enumerating candidate rows.
	if (
		(goal.rows?.length ?? 0) + (goal.automaticTemplates?.length ?? 0) > 64 ||
		(goal.scenarioFractions?.length ?? 0) > 9
	)
		return [];
	try {
		const original = structuredClone(goal);
		if (meetsGoal(original, recommendPerTitleSettings(original))) return [];
		const variants: Array<{
			reason: PerTitleSuggestion["reason"];
			goal: PerTitleGoal;
		}> = [];
		const rows =
			original.strategy === "automatic" || original.strategy === "count"
				? []
				: (original.rows ?? []);
		if (
			rows.length &&
			rows.every(
				(row) =>
					Number.isSafeInteger(row.minBitrate) &&
					Number.isSafeInteger(row.maxBitrate) &&
					(row.minBitrate ?? 0) > 0 &&
					(row.maxBitrate ?? 0) >= (row.minBitrate ?? 0),
			)
		) {
			const minBitrate = Math.min(
				original.minBitrate,
				...rows.map((row) => row.minBitrate as number),
			);
			const maxBitrate = Math.max(
				original.maxBitrate,
				...rows.map((row) => row.maxBitrate as number),
			);
			if (
				minBitrate !== original.minBitrate ||
				maxBitrate !== original.maxBitrate
			)
				variants.push({
					reason: "global-range",
					goal: { ...original, minBitrate, maxBitrate },
				});
		}
		if (
			original.countPolicy.kind !== "unrestricted" &&
			original.countPolicy.count < rows.length
		)
			variants.push({
				reason: "required-count",
				goal: {
					...original,
					countPolicy: { ...original.countPolicy, count: rows.length },
				},
			});
		const implicitAutomatic =
			original.strategy !== "fixed-ranges" &&
			original.strategy !== "fixed-resolutions";
		if (
			rows.length &&
			((original.automaticTemplates?.length ?? 0) > 0 || implicitAutomatic) &&
			original.countPolicy.kind !== "unrestricted"
		)
			variants.push({
				reason: "fixed-only",
				goal: {
					...original,
					strategy:
						original.strategy === "fixed-ranges"
							? "fixed-ranges"
							: "fixed-resolutions",
					automaticTemplates: [],
				},
			});
		if (original.fixedResolutionAndBitrateConfiguration !== undefined) {
			const without = { ...original };
			delete without.fixedResolutionAndBitrateConfiguration;
			variants.push({ reason: "without-forced", goal: without });
		}
		const seen = new Set<string>();
		const result: PerTitleSuggestion[] = [];
		// One original check plus at most one helper call per reason (five in total).
		for (const variant of variants) {
			const proposal = recommendPerTitleSettings(variant.goal);
			const explicitCorrection =
				variant.reason !== "fixed-only" &&
				proposal.status !== "conflict" &&
				!proposal.diagnostics.some((item) => item.severity === "conflict");
			if (!meetsGoal(variant.goal, proposal) && !explicitCorrection) continue;
			const checkedGoal: PerTitleGoal = {
				...variant.goal,
				minBitrateStepSize: proposal.api.global.minBitrateStepSize,
				maxBitrateStepSize: proposal.api.global.maxBitrateStepSize,
			};
			const changes = changedFields(original, checkedGoal);
			const key = JSON.stringify(checkedGoal);
			if (!changes.length || seen.has(key)) continue;
			seen.add(key);
			result.push({
				id: variant.reason,
				reason: variant.reason,
				goal: structuredClone(checkedGoal),
				proposal,
				changedFields: changes,
			});
		}
		const tradeoff = (reason: PerTitleSuggestion["reason"]) =>
			reason === "fixed-only" ? 2 : reason === "without-forced" ? 1 : 0;
		return result
			.sort(
				(a, b) =>
					tradeoff(a.reason) - tradeoff(b.reason) ||
					a.changedFields.length - b.changedFields.length ||
					a.id.localeCompare(b.id),
			)
			.slice(0, 4);
	} catch {
		return [];
	}
}
