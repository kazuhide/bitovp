import type { PerTitleGoal } from "@bitovp/core";
import { perTitleAdviceFieldKey } from "./per-title-simulator-advice-fields";
import {
	getPerTitleGoalSetting,
	type PerTitleSettingScope,
	setPerTitleSetting,
} from "./per-title-simulator-tuning";

const LOW = "lowComplexityBoundaryForMaxBitrate";
const HIGH = "highComplexityBoundaryForMaxBitrate";
const FACTOR =
	"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor";

/** Round actual changed settings; callers must recheck the entire candidate. */
export function roundedPerTitleJointGoal(
	previous: PerTitleGoal,
	current: PerTitleGoal,
	goal: PerTitleGoal,
	digits: number,
	protectedKeys: ReadonlySet<string>,
): PerTitleGoal | null {
	let next = goal;
	const put = (
		scope: PerTitleSettingScope,
		key: string,
		direction: "up" | "down",
		rate: boolean,
		rowId?: string,
	) => {
		const value = getPerTitleGoalSetting(goal, scope, key, rowId);
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value <= 0 ||
			Object.is(value, getPerTitleGoalSetting(current, scope, key, rowId)) ||
			protectedKeys.has(perTitleAdviceFieldKey({ scope, key, rowId }))
		)
			return;
		const unit = rate
			? 10 ** Math.max(0, Math.floor(Math.log10(value)) - digits + 1)
			: 10 ** -digits;
		const integer = direction === "up" ? Math.ceil : Math.floor;
		const rounded = rate
			? integer(value / unit) * unit
			: value === Number(value.toFixed(digits))
				? value
				: integer(value * 10 ** digits) / 10 ** digits;
		next = setPerTitleSetting(next, scope, key, rounded, rowId);
	};
	for (const row of goal.rows ?? []) {
		put("stream", "minBitrate", "up", true, row.id);
		put("stream", "maxBitrate", "up", true, row.id);
		put("stream", LOW, "down", true, row.id);
		put("stream", HIGH, "down", true, row.id);
	}
	put("global", "minBitrateStepSize", "up", false);
	put("global", "maxBitrateStepSize", "up", false);
	put("global", FACTOR, "down", false);
	for (const row of next.rows ?? []) {
		const old = previous.rows?.find((item) => item.id === row.id);
		if (
			(row.minBitrate ?? 0) < current.minBitrate ||
			(row.maxBitrate ?? Infinity) > current.maxBitrate ||
			(row.minBitrate ?? Infinity) > (row.maxBitrate ?? 0) ||
			(old?.highComplexityBoundaryForMaxBitrate === previous.maxBitrate &&
				(row.highComplexityBoundaryForMaxBitrate ?? 0) < previous.maxBitrate)
		)
			return null;
	}
	return next;
}

/** Intersect already calibrated H limits only for previously coupled, movable rows. */
export function sharedPerTitleJointHigh(
	previous: PerTitleGoal,
	goal: PerTitleGoal,
	protectedKeys: ReadonlySet<string>,
): PerTitleGoal | null {
	const rows = (goal.rows ?? []).filter(
		(row) =>
			row.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
			previous.rows?.find((old) => old.id === row.id)
				?.highComplexityBoundaryForMaxBitrate === previous.maxBitrate &&
			!protectedKeys.has(
				perTitleAdviceFieldKey({ scope: "stream", key: HIGH, rowId: row.id }),
			),
	);
	if (rows.length < 2) return null;
	const high = Math.min(
		...rows.map((row) => row.highComplexityBoundaryForMaxBitrate ?? 0),
	);
	const lower = Math.max(
		previous.maxBitrate,
		...rows.map((row) => (row.lowComplexityBoundaryForMaxBitrate ?? 0) + 1),
	);
	if (!Number.isSafeInteger(high) || high < lower) return null;
	return rows.reduce(
		(next, row) => setPerTitleSetting(next, "stream", HIGH, high, row.id),
		goal,
	);
}
