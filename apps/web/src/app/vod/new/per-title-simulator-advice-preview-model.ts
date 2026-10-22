import type { PerTitleGoal, PerTitleProposal } from "@bitovp/core";
import {
	applyPerTitleAdvice,
	applySelectedPerTitleAdvice,
	type PerTitleAdvice,
	type PerTitleAdviceField,
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
} from "./per-title-simulator-advice";
import { protectedPerTitleAdviceFields } from "./per-title-simulator-advice-fields";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";

export type PerTitleAdvicePreviewSelection = {
	selected: readonly PerTitleAdviceField[];
	kept: readonly PerTitleAdviceField[];
};

export type PerTitleAdvicePreviewModel = {
	current: PerTitleProposal;
	after: PerTitleProposal | null;
	mode: "all" | "selected" | "keep";
	status: "ready" | "conflict" | "unavailable";
	axis?: { minimum: number; maximum: number };
};

function canonicalFields(
	goal: PerTitleGoal,
	fields: readonly PerTitleAdviceField[],
) {
	const canonical = protectedPerTitleAdviceFields(goal, {
		protectedFields: fields,
	});
	if (canonical.length !== fields.length)
		throw new Error("Duplicate preview decisions.");
	return canonical;
}

/** Preview configuration changes only; this neither adopts nor protects fields. */
export function perTitleAdvicePreview(
	goal: PerTitleGoal,
	advice: PerTitleAdvice,
	selection: PerTitleAdvicePreviewSelection,
	options: PerTitleAdviceOptions = {},
): PerTitleAdvicePreviewModel {
	const current = tunePerTitleSettings(goal, goal).proposal;
	const mode =
		Array.isArray(selection?.selected) && selection.selected.length > 0
			? "selected"
			: Array.isArray(selection?.kept) && selection.kept.length > 0
				? "keep"
				: "all";
	const result: PerTitleAdvicePreviewModel = {
		current,
		after: null,
		mode,
		status: "unavailable",
	};
	try {
		const fullGoal = applyPerTitleAdvice(goal, advice, options);
		if (!fullGoal || !Array.isArray(advice.changes) || !advice.changes.length)
			return result;
		const offered = canonicalFields(
			goal,
			advice.changes.map(({ scope, key, rowId }) => ({
				scope,
				key,
				...(rowId === undefined ? {} : { rowId }),
			})),
		);
		// Reuse subset validation to check every offered before/after value and
		// ensure that the full recommendation contains no unlisted API changes.
		const allOffered = applySelectedPerTitleAdvice(
			goal,
			advice,
			offered,
			options,
		);
		if (!allOffered) return result;
		const full = tunePerTitleSettings(fullGoal, fullGoal).proposal;
		if (
			JSON.stringify(
				tunePerTitleSettings(allOffered, allOffered).proposal.api,
			) !== JSON.stringify(full.api)
		)
			return result;
		const minimum = Math.min(
			current.api.global.minBitrate,
			full.api.global.minBitrate,
		);
		const maximum = Math.max(
			current.api.global.maxBitrate,
			full.api.global.maxBitrate,
		);
		if (
			Number.isFinite(minimum) &&
			Number.isFinite(maximum) &&
			minimum > 0 &&
			maximum >= minimum
		)
			result.axis = { minimum, maximum };
		if (!Array.isArray(selection?.selected) || !Array.isArray(selection?.kept))
			return result;
		const selected = canonicalFields(goal, selection.selected);
		const kept = canonicalFields(goal, selection.kept);
		const decisions = [...selected, ...kept];
		const offeredKeys = new Set(offered.map(perTitleAdviceFieldKey));
		const identities = decisions.map(perTitleAdviceFieldKey);
		if (
			new Set(identities).size !== identities.length ||
			identities.some((key) => !offeredKeys.has(key))
		)
			return result;
		let after: PerTitleProposal;
		if (mode === "all") after = full;
		else if (mode === "keep") after = current;
		else {
			const patched = applySelectedPerTitleAdvice(
				goal,
				advice,
				selected,
				options,
			);
			if (!patched) return result;
			after = tunePerTitleSettings(patched, patched).proposal;
		}
		return {
			...result,
			after,
			status:
				after.status === "conflict" ||
				after.diagnostics.some((item) => item.severity === "conflict")
					? "conflict"
					: "ready",
		};
	} catch {
		return result;
	}
}
