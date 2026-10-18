import {
	addUtcDays,
	type ProviderDailyStatistics,
	utcDayKey,
} from "@bitovp/core";

type LiveOptionsStatistics = {
	summary?: { hd?: { unitsUsed?: number } };
	breakdown?: { date?: Date | string; hd?: { unitsUsed?: number } }[];
};

function dayKey(value: Date | string | undefined): string | null {
	const date =
		value instanceof Date
			? value
			: typeof value === "string"
				? new Date(value)
				: null;
	return date &&
		Number.isFinite(date.getTime()) &&
		date.toISOString().endsWith("T00:00:00.000Z")
		? utcDayKey(date)
		: null;
}

/** Options is summary + a dated breakdown, not the daily endpoint's items page.
 * Reject partial/ambiguous windows before the sweep can advance its cursor.
 * The caller bounds the request to 25 inclusive UTC days (limit <= 100).
 */
export function mergeLiveOptionsStatistics(
	daily: ProviderDailyStatistics[],
	options: LiveOptionsStatistics,
	from: string,
	to: string,
): ProviderDailyStatistics[] {
	const units = new Map<string, number>();
	if (!Array.isArray(options?.breakdown))
		throw new Error("Live options breakdown unavailable");
	for (const entry of options.breakdown) {
		const day = dayKey(entry?.date),
			value = entry?.hd?.unitsUsed;
		if (
			!day ||
			day < from ||
			day > to ||
			units.has(day) ||
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0
		) {
			throw new Error("Live options contains invalid or duplicate daily units");
		}
		units.set(day, value);
	}
	for (let day = from; day <= to; day = addUtcDays(day, 1)) {
		if (!units.has(day)) throw new Error("Live options window is incomplete");
	}
	const summary = options.summary?.hd?.unitsUsed;
	const sum = [...units.values()].reduce((total, value) => total + value, 0);
	if (
		typeof summary !== "number" ||
		!Number.isFinite(summary) ||
		Math.abs(summary - sum) > 1e-6
	) {
		throw new Error("Live options summary does not match the daily units");
	}
	const rows = new Map<string, ProviderDailyStatistics>();
	for (const row of daily) {
		const day = dayKey(row.date);
		if (!day || !units.has(day) || rows.has(day))
			throw new Error("Live daily contains invalid or duplicate dates");
		rows.set(day, row);
	}
	return [...units]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, liveHdUnits]) => ({ ...rows.get(date), date, liveHdUnits }));
}
