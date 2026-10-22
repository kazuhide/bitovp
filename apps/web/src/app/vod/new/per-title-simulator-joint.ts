import {
	certifyComplexityIntervals,
	complexityTargetsDoNotDecrease,
	evaluateForcedRenditions,
	type PerTitleGoal,
	type PerTitleGoalRow,
} from "@bitovp/core";
import {
	initializePerTitleSettings,
	setPerTitleSetting,
} from "./per-title-simulator-tuning";

const rate = (n: unknown): n is number =>
	typeof n === "number" &&
	Number.isSafeInteger(n) &&
	n > 0 &&
	n <= 2_147_483_647;
const step = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 1;
const curve = (row: PerTitleGoalRow) => ({
	minimum: row.minBitrate ?? 0,
	maximum: row.maxBitrate ?? 0,
	low: row.lowComplexityBoundaryForMaxBitrate ?? 0,
	high: row.highComplexityBoundaryForMaxBitrate ?? 0,
});

// Arithmetic placement room, using repeated integer rounding; never an output count.
function capacity(minimum: number, maximum: number, spacing: number) {
	if (!rate(minimum) || !rate(maximum) || !step(spacing) || minimum > maximum)
		return Infinity;
	let value = minimum;
	for (let count = 1; count <= 256; count++) {
		const next = Math.round(value * spacing);
		if (next > maximum) return count;
		if (next <= value) return Infinity;
		value = next;
	}
	return Infinity;
}

function withinCapacity(ratio: number, spacing: number, minimum: number) {
	// round(x*s) >= x*(s - 0.5/minimum) for x >= minimum.
	const lowerStep = spacing - 0.5 / minimum;
	if (!Number.isFinite(ratio) || ratio < 1 || !step(lowerStep)) return Infinity;
	let bound = 1;
	for (let count = 1; count <= 256; count++) {
		bound *= lowerStep;
		if (bound > ratio) return count;
	}
	return Infinity;
}

function connections(goal: PerTitleGoal) {
	const rows = goal.rows ?? [];
	if (
		rows.length < 2 ||
		rows.some((row) => row.bitrateSelectionMode !== "COMPLEXITY_RANGE")
	)
		return null;
	const basis = rows.every((row) => rate(row.width))
		? "width"
		: rows.every((row) => row.width === undefined && rate(row.height))
			? "height"
			: null;
	if (!basis) return null;
	const ordered = [...rows].sort(
		(a, b) =>
			(a[basis] as number) - (b[basis] as number) ||
			(a.minBitrate ?? 0) - (b.minBitrate ?? 0),
	);
	return certifyComplexityIntervals(
		ordered.map(curve),
		{ minimum: 1, maximum: goal.maxBitrate },
		goal.minBitrateStepSize ?? 0,
	);
}

// The full interval check is not monotone in s. Recheck each derived limit instead of bisecting it.
function connect(
	goal: PerTitleGoal,
	lowerStep: boolean,
	fits: (spacing: number) => boolean | undefined,
) {
	let next = goal;
	for (let attempt = 0; attempt < 32; attempt++) {
		const certificate = connections(next);
		if (!certificate) break;
		const s = next.minBitrateStepSize ?? 0;
		const t = Math.max(
			next.maxBitrateStepSize ?? 0,
			s,
			certificate.maximumAdjacentRatio ?? 0,
		);
		if (!step(t)) break;
		next = setPerTitleSetting(next, "global", "maxBitrateStepSize", t);
		const limit = certificate.minimumAdjacentRatio ?? s;
		if (limit >= s || !lowerStep || !step(limit) || !fits(limit)) break;
		next = setPerTitleSetting(next, "global", "minBitrateStepSize", limit);
	}
	return next;
}

/** Source-analysis units are independent of the global cap. Maximize H only after checking the curve. */
function expandedHigh(
	before: PerTitleGoalRow,
	after: PerTitleGoalRow,
	oldCap: number,
	cap: number,
) {
	if (before.highComplexityBoundaryForMaxBitrate !== oldCap) return after;
	const input = { minimum: 1, maximum: oldCap };
	const valid = (high: number) =>
		complexityTargetsDoNotDecrease(
			curve(before),
			{
				...curve(after),
				high,
			},
			input,
		);
	let low = Math.max(
		oldCap,
		(after.lowComplexityBoundaryForMaxBitrate ?? 0) + 1,
	);
	if (low > cap || !valid(low)) return null;
	let high = cap;
	while (low < high) {
		const middle = low + Math.ceil((high - low) / 2);
		if (valid(middle)) low = middle;
		else high = middle - 1;
	}
	return { ...after, highComplexityBoundaryForMaxBitrate: low };
}

type Evaluation = { facts: Record<string, number>; rank: number[] };
function evaluate(
	before: PerTitleGoal,
	after: PerTitleGoal,
): Evaluation | null {
	const oldStep = before.minBitrateStepSize ?? 0,
		newStep = after.minBitrateStepSize ?? 0;
	const oldRows = before.rows ?? [],
		rows = after.rows ?? [];
	const oldCapacity = capacity(before.minBitrate, before.maxBitrate, oldStep);
	const newCapacity = capacity(after.minBitrate, after.maxBitrate, newStep);
	if (!Number.isFinite(oldCapacity) || newCapacity > oldCapacity) return null;
	let adjustedCurves = 0,
		connectionRisk = 0;
	for (let i = 0; i < oldRows.length; i++) {
		const old = oldRows[i],
			row = rows[i];
		if (
			!old ||
			!row ||
			!rate(old.minBitrate) ||
			!rate(old.maxBitrate) ||
			!rate(row.minBitrate) ||
			!rate(row.maxBitrate)
		)
			return null;
		const oldRowCapacity = capacity(old.minBitrate, old.maxBitrate, oldStep);
		if (
			!Number.isFinite(oldRowCapacity) ||
			capacity(row.minBitrate, row.maxBitrate, newStep) > oldRowCapacity
		)
			return null;
		if (old.bitrateSelectionMode !== "COMPLEXITY_RANGE") continue;
		if (
			!complexityTargetsDoNotDecrease(curve(old), curve(row), {
				minimum: 1,
				maximum: before.maxBitrate,
			})
		)
			return null;
		const oldCertificate = certifyComplexityIntervals(
			[curve(old)],
			{ minimum: 1, maximum: before.maxBitrate },
			oldStep,
		);
		const certificate = certifyComplexityIntervals(
			[curve(row)],
			{ minimum: 1, maximum: after.maxBitrate },
			newStep,
		);
		if (
			!oldCertificate ||
			!certificate ||
			withinCapacity(
				certificate.maximumWithinRowRatio,
				newStep,
				row.minBitrate,
			) >
				withinCapacity(
					oldCertificate.maximumWithinRowRatio,
					oldStep,
					old.minBitrate,
				)
		)
			return null;
		adjustedCurves++;
	}
	// A sufficient certificate can retain a known connection, but an unknown one is not a count proof.
	if (rows.length > 1 && adjustedCurves === rows.length) {
		const oldCertificate = connections(before);
		const certificate = connections(after);
		if (!oldCertificate || !certificate) return null;
		const connected = (c: typeof certificate, s: number, t: number) =>
			(c.minimumAdjacentRatio ?? Infinity) >= s &&
			(c.maximumAdjacentRatio ?? 0) <= t;
		const oldConnected = connected(
			oldCertificate,
			oldStep,
			before.maxBitrateStepSize ?? 0,
		);
		const newConnected = connected(
			certificate,
			newStep,
			after.maxBitrateStepSize ?? 0,
		);
		if (oldConnected && !newConnected) return null;
		connectionRisk = newConnected ? 0 : 1;
	}
	const rule = after.fixedResolutionAndBitrateConfiguration;
	const n = rule?.forcedRenditionAboveHighestFixedRepresentation ?? 0;
	if (n) {
		const top = Math.max(...rows.map((row) => row.maxBitrate ?? 0));
		const forced = evaluateForcedRenditions({
			base: { minimum: top, maximum: top },
			count: n,
			factor: rule?.forcedRenditionAboveHighestFixedRepresentationFactor ?? 0,
		});
		if (
			!forced ||
			forced.some(
				(range, i) =>
					range.maximum > after.maxBitrate ||
					range.minimum <= (i ? (forced[i - 1]?.maximum ?? Infinity) : top),
			)
		)
			return null;
	}
	const coupled = oldRows.filter(
		(row) =>
			row.bitrateSelectionMode === "COMPLEXITY_RANGE" &&
			row.highComplexityBoundaryForMaxBitrate === before.maxBitrate,
	);
	const boundaryGap = coupled.reduce(
		(sum, row) =>
			sum +
			(after.maxBitrate -
				(rows.find((next) => next.id === row.id)
					?.highComplexityBoundaryForMaxBitrate ?? 0)) /
				after.maxBitrate,
		0,
	);
	return {
		facts: {
			previousMaximum: before.maxBitrate,
			maximum: after.maxBitrate,
			minimum: after.minBitrate,
			previousCapacity: oldCapacity,
			capacity: newCapacity,
			checkedCurveRows: adjustedCurves,
			connectionRisk,
			boundaryGap,
		},
		rank: [connectionRisk, newCapacity, boundaryGap],
	};
}

/** Bounded setting candidates, not a reconstruction of the encoder's content analysis. */
export function jointPerTitleExpansion(
	previous: PerTitleGoal,
	current: PerTitleGoal,
) {
	const before = initializePerTitleSettings(previous);
	if (
		before.strategy !== "fixed-ranges" ||
		!before.rows?.length ||
		before.rows.length > 64 ||
		!rate(before.minBitrate) ||
		!rate(before.maxBitrate) ||
		!rate(current.maxBitrate) ||
		before.minBitrate >= before.maxBitrate ||
		current.maxBitrate <= before.maxBitrate ||
		!step(before.minBitrateStepSize) ||
		!step(before.maxBitrateStepSize) ||
		before.maxBitrateStepSize < before.minBitrateStepSize ||
		before.rows.some(
			(row) =>
				!rate(row.minBitrate) ||
				!rate(row.maxBitrate) ||
				row.minBitrate < before.minBitrate ||
				row.maxBitrate > before.maxBitrate ||
				row.minBitrate > row.maxBitrate,
		)
	)
		return [];
	const p =
		Math.log(current.maxBitrate / before.minBitrate) /
		Math.log(before.maxBitrate / before.minBitrate);
	const map = (value: number) =>
		Math.round(before.minBitrate * (value / before.minBitrate) ** p);
	let base = initializePerTitleSettings(current);
	for (const row of before.rows) {
		for (const key of ["minBitrate", "maxBitrate"] as const)
			base = setPerTitleSetting(
				base,
				"stream",
				key,
				map(row[key] as number),
				row.id,
			);
	}
	let s = before.minBitrateStepSize ** p;
	if (!step(s) || !step(before.maxBitrateStepSize ** p)) return [];
	const fits = (spacing: number) =>
		capacity(base.minBitrate, base.maxBitrate, spacing) <=
			capacity(
				before.minBitrate,
				before.maxBitrate,
				before.minBitrateStepSize as number,
			) &&
		before.rows?.every(
			(row, i) =>
				capacity(
					base.rows?.[i]?.minBitrate ?? 0,
					base.rows?.[i]?.maxBitrate ?? 0,
					spacing,
				) <=
				capacity(
					row.minBitrate ?? 0,
					row.maxBitrate ?? 0,
					before.minBitrateStepSize as number,
				),
		);
	if (!fits(s)) {
		let lower = s,
			upper = Math.max(s, base.maxBitrate / base.minBitrate + 1);
		for (let i = 0; i < 64; i++) {
			const middle = (lower + upper) / 2;
			if (middle === lower || middle === upper) break;
			if (fits(middle)) upper = middle;
			else lower = middle;
		}
		s = upper;
	}
	base = setPerTitleSetting(base, "global", "minBitrateStepSize", s);
	base = setPerTitleSetting(
		base,
		"global",
		"maxBitrateStepSize",
		Math.max(s, before.maxBitrateStepSize ** p),
	);
	const rule = before.fixedResolutionAndBitrateConfiguration;
	if (rule && rule.forcedRenditionAboveHighestFixedRepresentation !== 0) {
		if (
			!Number.isSafeInteger(
				rule.forcedRenditionAboveHighestFixedRepresentation,
			) ||
			!step(rule.forcedRenditionAboveHighestFixedRepresentationFactor) ||
			!rule.forcedRenditionAboveHighestFixedRepresentationCalculationMode
		)
			return [];
		let factor = rule.forcedRenditionAboveHighestFixedRepresentationFactor ** p;
		if (!step(factor)) return [];
		const top = Math.max(
			...(base.rows ?? []).map((row) => row.maxBitrate ?? 0),
		);
		const fitsCap = (value: number) => {
			const forced = evaluateForcedRenditions({
				base: { minimum: top, maximum: top },
				count: rule.forcedRenditionAboveHighestFixedRepresentation as number,
				factor: value,
			});
			return (
				forced?.every((range) => range.maximum <= current.maxBitrate) ?? false
			);
		};
		if (!fitsCap(factor)) {
			let lower = 1,
				upper = factor;
			for (let i = 0; i < 64; i++) {
				const middle = (lower + upper) / 2;
				if (middle === lower || middle === upper) break;
				if (fitsCap(middle)) lower = middle;
				else upper = middle;
			}
			factor = lower;
		}
		base = setPerTitleSetting(
			base,
			"global",
			"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor",
			factor,
		);
	}
	const top = [...before.rows].sort((a, b) => b.height - a.height);
	const highest = top[0];
	const recipe =
		highest &&
		top[1]?.height !== highest.height &&
		rate(highest.minBitrate) &&
		before.autoRepresentations === false &&
		before.automaticTemplates?.some(
			(row) => row.width === undefined && (row.height ?? 0) > highest.height,
		) &&
		before.rows.every((row) => row.width === undefined);
	const oldLow = recipe
		? Math.trunc((highest.minBitrate as number) * before.minBitrateStepSize)
		: undefined;
	const newLow = recipe
		? Math.trunc(map(highest.minBitrate as number) * s)
		: undefined;
	const candidates = [];
	for (const policy of [
		...(newLow !== undefined && rate(newLow)
			? [
					{ recipe: true, expand: true },
					{ recipe: true, expand: false },
				]
			: []),
		{ recipe: false, expand: true },
		{ recipe: false, expand: false },
	]) {
		let goal = base;
		let valid = true;
		for (const row of before.rows) {
			if (row.bitrateSelectionMode !== "COMPLEXITY_RANGE") continue;
			let next = goal.rows?.find((item) => item.id === row.id);
			if (!next) {
				valid = false;
				break;
			}
			if (policy.recipe && row.lowComplexityBoundaryForMaxBitrate === oldLow)
				next = { ...next, lowComplexityBoundaryForMaxBitrate: newLow };
			const calibrated = policy.expand
				? expandedHigh(row, next, before.maxBitrate, current.maxBitrate)
				: next;
			if (!calibrated) {
				valid = false;
				break;
			}
			for (const key of [
				"lowComplexityBoundaryForMaxBitrate",
				"highComplexityBoundaryForMaxBitrate",
			] as const)
				goal = setPerTitleSetting(goal, "stream", key, calibrated[key], row.id);
		}
		if (!valid) continue;
		goal = connect(goal, !policy.recipe, fits);
		const evaluated = evaluate(before, goal);
		if (evaluated)
			candidates.push({
				goal,
				facts: { ...evaluated.facts, exponent: p },
				rank: [...evaluated.rank, policy.recipe ? 0 : 1],
			});
	}
	return candidates.sort((a, b) => {
		for (let i = 0; i < a.rank.length; i++) {
			const delta = (a.rank[i] ?? 0) - (b.rank[i] ?? 0);
			if (delta) return delta;
		}
		return 0;
	});
}
