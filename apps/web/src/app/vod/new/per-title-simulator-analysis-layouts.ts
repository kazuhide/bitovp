import {
	certifyComplexityIntervals,
	complexityTargetsDoNotDecrease,
	type PerTitleGoal,
	type PerTitleProposal,
} from "@bitovp/core";
import {
	type PerTitleAdviceOptions,
	perTitleAdviceFieldKey,
	protectedPerTitleAdviceFields,
} from "./per-title-simulator-advice-fields";
import { perTitleAnalysisCurve } from "./per-title-simulator-analysis-ladder";
import {
	type PerTitleSettingValue,
	setPerTitleSetting,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const LOW = "lowComplexityBoundaryForMaxBitrate";
const HIGH = "highComplexityBoundaryForMaxBitrate";
const RULE = "fixedResolutionAndBitrateConfiguration.";
const FACTOR = `${RULE}forcedRenditionAboveHighestFixedRepresentationFactor`;
const readable = (value: number, upwards: boolean) => {
	const tick = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 2);
	return (upwards ? Math.ceil(value / tick) : Math.floor(value / tick)) * tick;
};

/** Derived whole-ladder layouts, not assumed optimal rate/quality configurations. */
export function perTitleWholeLadderCandidates(
	goal: PerTitleGoal,
	proposal: PerTitleProposal,
	options: PerTitleAdviceOptions,
): PerTitleGoal[] {
	if (
		goal.strategy !== "fixed-ranges" ||
		!goal.rows?.length ||
		proposal.api.global.autoRepresentations !== undefined
	)
		return [];
	const fixed = proposal.api.streams.filter(
		(row) => row.mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	);
	const basis = fixed.every(
		(row) => row.width === undefined && typeof row.height === "number",
	)
		? "height"
		: fixed.every((row) => typeof row.width === "number")
			? "width"
			: null;
	if (
		!basis ||
		fixed.length !== goal.rows.length ||
		fixed.some((row) => !perTitleAnalysisCurve(row))
	)
		return [];
	const ordered = [...fixed].sort(
		(a, b) =>
			(a[basis] ?? 0) - (b[basis] ?? 0) ||
			(a.perTitleSettings?.minBitrate ?? 0) -
				(b.perTitleSettings?.minBitrate ?? 0),
	);
	const top = ordered.at(-1);
	const first = ordered[0];
	if (!top || !first || (ordered.at(-2)?.[basis] ?? -1) === top[basis])
		return [];
	const topCurve = perTitleAnalysisCurve(top);
	if (!topCurve) return [];
	const held = new Set(
		protectedPerTitleAdviceFields(goal, options).map(perTitleAdviceFieldKey),
	);
	const can = (key: string, rowId?: string) =>
		!held.has(
			perTitleAdviceFieldKey({
				scope: rowId ? "stream" : "global",
				key,
				rowId,
			}),
		);
	const set = (
		next: PerTitleGoal,
		key: string,
		value: PerTitleSettingValue,
		rowId?: string,
	) =>
		can(key, rowId)
			? setPerTitleSetting(next, rowId ? "stream" : "global", key, value, rowId)
			: next;
	const cap = goal.maxBitrate;
	const minimumStep = proposal.api.global.minBitrateStepSize;
	if (!Number.isFinite(minimumStep) || minimumStep <= 1) return [];
	const result: PerTitleGoal[] = [];
	// Extend a curve to M without reducing any of its previous upper targets:
	// u' >= m + (u-m)(M-L)/(H-L). The lowest fixed band is retained, so a
	// larger upper envelope cannot create a new gap below that band.
	let extended = goal;
	for (const row of ordered) {
		const curve = perTitleAnalysisCurve(row);
		if (
			!curve ||
			row.rowId === first.rowId ||
			curve.high >= cap ||
			curve.low >= cap ||
			!can(HIGH, row.rowId) ||
			!can("maxBitrate", row.rowId)
		)
			continue;
		const upper = readable(
			curve.minimum +
				((curve.maximum - curve.minimum) * (cap - curve.low)) /
					(curve.high - curve.low),
			true,
		);
		if (!Number.isSafeInteger(upper) || upper > cap) continue;
		extended = set(
			set(extended, "maxBitrate", upper, row.rowId),
			HIGH,
			cap,
			row.rowId,
		);
	}
	// Joint endpoint repair is only a search seed. Whole-domain certificates,
	// unchanged protected values and the actual emitted API are checked later.
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const row = ordered[index];
		if (!previous || !row || !can("maxBitrate", row.rowId)) continue;
		for (let attempt = 0; attempt < 12; attempt++) {
			const api = tunePerTitleSettings(extended, options.referenceGoal ?? goal)
				.proposal.api;
			const pair = [previous, row]
				.map((source) =>
					api.streams.find((stream) => stream.rowId === source.rowId),
				)
				.map((stream) => stream && perTitleAnalysisCurve(stream));
			if (!pair[0] || !pair[1]) break;
			const certificate = certifyComplexityIntervals(
				[pair[0], pair[1]],
				{ minimum: goal.minBitrate, maximum: cap },
				minimumStep,
			);
			const ratio = certificate?.minimumAdjacentRatio;
			if (!ratio || ratio >= minimumStep) break;
			if (pair[1].minimum / pair[0].minimum < minimumStep) break;
			const upper = readable((pair[1].maximum * minimumStep) / ratio, true);
			if (upper <= pair[1].maximum || upper > cap) break;
			extended = set(extended, "maxBitrate", upper, row.rowId);
		}
	}
	if (extended !== goal) {
		const api = tunePerTitleSettings(extended, options.referenceGoal ?? goal)
			.proposal.api;
		if (
			ordered.every((row) => {
				const before = perTitleAnalysisCurve(row);
				const stream = api.streams.find((value) => value.rowId === row.rowId);
				const after = stream && perTitleAnalysisCurve(stream);
				return (
					before &&
					after &&
					complexityTargetsDoNotDecrease(before, after, {
						minimum: goal.minBitrate,
						maximum: cap,
					})
				);
			})
		)
			result.push(extended);
	}
	// For one LAST_CALCULATED addition, s=f, L=round(m*s), and u<=M/s
	// align the forced low target and the direct-connection domain. The new
	// curve is certified across the ENTIRE domain, never from endpoint samples.
	const rule = proposal.api.global.fixedResolutionAndBitrateConfiguration;
	const sharedLow = ordered.every(
		(row) => perTitleAnalysisCurve(row)?.low === topCurve.low,
	);
	const sharedHigh = ordered.every(
		(row) => perTitleAnalysisCurve(row)?.high === topCurve.high,
	);
	if (
		rule?.forcedRenditionAboveHighestFixedRepresentation === 1 &&
		rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode ===
			"LAST_CALCULATED_BITRATE" &&
		sharedLow &&
		sharedHigh
	) {
		for (const step of [
			...new Set([
				minimumStep,
				rule.forcedRenditionAboveHighestFixedRepresentationFactor,
			]),
		]) {
			if (typeof step !== "number" || !Number.isFinite(step) || step <= 1)
				continue;
			const lower = Math.round(topCurve.minimum * step);
			const upper = readable(Math.floor(cap / step), false);
			if (lower >= cap || upper < topCurve.maximum || upper <= topCurve.minimum)
				continue;
			let aligned = set(set(goal, "minBitrateStepSize", step), FACTOR, step);
			if (
				tunePerTitleSettings(aligned, options.referenceGoal ?? goal).proposal
					.api.global.minBitrateStepSize !== step ||
				aligned.fixedResolutionAndBitrateConfiguration
					?.forcedRenditionAboveHighestFixedRepresentationFactor !== step
			)
				continue;
			for (const row of ordered) {
				const curve = perTitleAnalysisCurve(row);
				if (!curve) continue;
				const maximum =
					row.rowId === first.rowId && row !== top
						? curve.maximum
						: row === top
							? upper
							: readable((curve.maximum * upper) / topCurve.maximum, true);
				if (maximum > cap) continue;
				aligned = set(
					set(set(aligned, LOW, lower, row.rowId), HIGH, cap, row.rowId),
					"maxBitrate",
					maximum,
					row.rowId,
				);
			}
			result.push(aligned);
		}
	}
	// Closed ladders can also correct unused high boundaries without changing
	// endpoint bands. Count preservation is certified by the caller.
	if (!goal.automaticTemplates?.length)
		result.push(
			ordered.reduce((next, row) => set(next, HIGH, cap, row.rowId), goal),
		);
	return result;
}
