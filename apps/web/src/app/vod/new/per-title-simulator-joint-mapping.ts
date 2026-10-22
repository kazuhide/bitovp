import type { PerTitleGoal } from "@bitovp/core";
import { perTitleAdviceFieldKey } from "./per-title-simulator-advice-fields";

/** A piecewise logarithmic layout anchored at protected rendition endpoints. */
export function protectedPerTitleRangeMap(
	before: PerTitleGoal,
	current: PerTitleGoal,
	protectedKeys: ReadonlySet<string>,
	rangeMaximum = current.maxBitrate,
) {
	if (
		!Number.isSafeInteger(rangeMaximum) ||
		rangeMaximum < before.maxBitrate ||
		rangeMaximum > current.maxBitrate
	)
		return null;
	const anchors = new Map<number, number>([
		[before.minBitrate, current.minBitrate],
	]);
	for (const row of before.rows ?? []) {
		const now = current.rows?.find((item) => item.id === row.id);
		for (const key of ["minBitrate", "maxBitrate"] as const) {
			if (
				!protectedKeys.has(
					perTitleAdviceFieldKey({ scope: "stream", key, rowId: row.id }),
				)
			)
				continue;
			const from = row[key],
				to = now?.[key];
			if (
				from === undefined ||
				to === undefined ||
				!Number.isSafeInteger(from) ||
				!Number.isSafeInteger(to) ||
				from < before.minBitrate ||
				from > before.maxBitrate ||
				to < current.minBitrate ||
				to > current.maxBitrate
			)
				return null;
			if (anchors.has(from) && anchors.get(from) !== to) return null;
			anchors.set(from, to);
		}
	}
	// A fixed row at the old cap can stay there while the independent global cap grows.
	if (!anchors.has(before.maxBitrate))
		anchors.set(before.maxBitrate, rangeMaximum);
	const points = [...anchors.entries()].sort(([a], [b]) => a - b);
	if (
		points.some(
			([x, y], i) =>
				i > 0 &&
				(x <= (points[i - 1]?.[0] ?? Infinity) ||
					y <= (points[i - 1]?.[1] ?? Infinity)),
		)
	)
		return null;
	return (value: number) => {
		if (anchors.has(value)) return anchors.get(value) as number;
		const right = points.findIndex(([x]) => x > value);
		const a = points[right - 1],
			b = points[right];
		if (!a || !b) throw new Error("Rate outside advice mapping.");
		const power = Math.log(b[1] / a[1]) / Math.log(b[0] / a[0]);
		return Math.round(a[1] * (value / a[0]) ** power);
	};
}
