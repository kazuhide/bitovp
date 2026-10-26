import type {
	PerTitleSetupInput,
	PerTitleSetupRow,
} from "./per-title-guided-setup-model";

const NOMINAL_MAXIMUM_STEP = 1.9;
const STEP_MARGIN = 0.01;
const validRate = (value: number | undefined): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= 1 &&
	value <= 2_147_483_647;
const validHeight = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Allocate bitrate budgets; this does not estimate source quality or complexity. */
export function allocatePerTitleSetupRanges(
	input: PerTitleSetupInput,
	minimumStep: number,
	factor: number,
	readable = true,
): PerTitleSetupRow[] | null {
	const { minBitrate: lower, maxBitrate: upper } = input;
	if (
		!validRate(lower) ||
		!validRate(upper) ||
		lower > upper ||
		!Number.isFinite(minimumStep) ||
		minimumStep <= 1 + STEP_MARGIN ||
		!Array.isArray(input.rows) ||
		!input.rows.length ||
		input.rows.length > 64 ||
		input.rows.some((row) => !validHeight(row?.height))
	)
		return null;
	const hasLower = input.automaticEdges?.lowerHeight !== undefined;
	const hasUpper = (input.automaticEdges?.upperHeights?.length ?? 0) > 0;
	const beta = (minimumStep - STEP_MARGIN) ** 2;
	if (
		hasUpper &&
		(!Number.isFinite(factor) ||
			factor <= 1 ||
			factor >= minimumStep ||
			minimumStep * factor >= beta)
	)
		return null;
	const ordered = [...input.rows].sort((a, b) => a.height - b.height);
	const rank = new Map(ordered.map((row, index) => [row.id, index]));
	if (rank.size !== ordered.length) return null;
	const finish = (rows: PerTitleSetupRow[]) =>
		rows.every(
			(row) =>
				validRate(row.minBitrate) &&
				validRate(row.maxBitrate) &&
				row.minBitrate >= lower &&
				row.maxBitrate <= upper &&
				row.minBitrate <= row.maxBitrate,
		)
			? rows
			: null;
	if (
		input.rows.every(
			(row) => row.minBitrate !== undefined && row.maxBitrate !== undefined,
		)
	)
		return finish(
			input.rows.map(({ id, height, minBitrate, maxBitrate }) => ({
				id,
				height,
				minBitrate,
				maxBitrate,
			})),
		);
	const round = (value: number, up: boolean) => {
		const quantum = readable
			? Math.max(1, 10 ** (Math.floor(Math.log10(value)) - 2))
			: 1;
		return (
			(up ? Math.ceil(value / quantum) : Math.floor(value / quantum)) * quantum
		);
	};
	const last = ordered.at(-1);
	if (!last) return null;
	// The upper role receives a separate ratio budget. Normal and forced outputs
	// are alternatives; this does not reserve two consecutive upper outputs.
	const baseMinimum = round(
		Math.floor(upper / (hasUpper ? beta : minimumStep - STEP_MARGIN)) + 1,
		true,
	);
	const baseMaximum = hasUpper
		? round(upper / (minimumStep * factor), false)
		: upper;
	const topMinimum =
		last.minBitrate ?? Math.min(baseMinimum, last.maxBitrate ?? upper);
	const topMaximum = last.maxBitrate ?? Math.max(baseMaximum, topMinimum);
	if (
		!validRate(topMinimum) ||
		!validRate(topMaximum) ||
		topMinimum < lower ||
		topMaximum > upper ||
		topMinimum > topMaximum
	)
		return null;
	const gaps = ordered.length - 1;
	// Maximize lower-rendition savings inside the nominal gap budget. The hard
	// side balances multiplicative margins: r/minStep = lowGap/r.
	const lowRoom = gaps
		? (topMinimum / (lower * (hasLower ? minimumStep : 1))) ** (1 / gaps)
		: 1;
	let lowGap = gaps ? Math.min(NOMINAL_MAXIMUM_STEP, lowRoom) : 1;
	if (gaps && lowGap < minimumStep) return null;
	let highGap = gaps
		? Math.max(
				Math.sqrt(minimumStep * lowGap),
				hasLower
					? (topMaximum / (lower * Math.max(4, minimumStep))) ** (1 / gaps)
					: 1,
			)
		: 1;
	// Short ladders may need larger gaps to connect the lower template. Relax
	// the nominal budget only as far as that connection and the lower floor need.
	if (gaps && highGap > lowGap) {
		lowGap = Math.min(highGap, lowRoom);
		highGap = Math.max(highGap, Math.sqrt(minimumStep * lowGap));
	}
	const rows = input.rows.map((row) => {
		const remaining = gaps - (rank.get(row.id) ?? 0);
		let minBitrate =
			row.minBitrate ??
			Math.max(lower, round(topMinimum / lowGap ** remaining, true));
		let maxBitrate =
			row.maxBitrate ??
			Math.min(upper, round(topMaximum / highGap ** remaining, false));
		if (row.minBitrate === undefined && row.maxBitrate !== undefined)
			minBitrate = Math.min(minBitrate, maxBitrate);
		if (row.maxBitrate === undefined && row.minBitrate !== undefined)
			maxBitrate = Math.max(maxBitrate, minBitrate);
		return { id: row.id, height: row.height, minBitrate, maxBitrate };
	});
	return finish(rows);
}
