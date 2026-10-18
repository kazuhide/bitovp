/**
 * Deterministic one-to-one binding of expected manifest nodes to observed rows
 * (row 284 / audit 5c3d97ca HIGH-5, VF-03).
 *
 * The binding it replaces — `nearestByBandwidth` — picked, for EACH expected
 * rendition independently, the observed child nearest its bitrate, and never
 * consumed the child it picked. So one observed row could satisfy several
 * expected renditions: a same-height two-rung ladder delivered as ONE variant
 * passed both `:present` checks, and `2 expected / 1 observed` was green.
 *
 * This is a maximum-cardinality, minimum-cost assignment over a bipartite
 * graph whose edges are the caller's `compatible` pairs, with a deterministic
 * tie-break: both sides are canonically sorted before the assignment runs, so
 * the result is a function of the KEYS and never of input order. Exact
 * duplicates on the observed side (identical canonical key) are reported and
 * collapsed to one representative BEFORE matching, so a duplicated row cannot
 * pass as two renditions either.
 *
 * Shared by HLS and DASH; the INPUT MODELS are not (`engine.ts` builds each).
 */

/** Measured distances are capped here, so a wild bandwidth stays finite and orderable. */
export const MAX_NORMALIZED_BITRATE_COST = 1_000;
/** Missing evidence sorts behind every finite distance, never at the old false value of zero. */
export const UNKNOWN_BITRATE_COST = MAX_NORMALIZED_BITRATE_COST + 1;
/** Caller-specific evidence penalties may sit above bitrate distance, within this bound. */
const MAX_ASSIGNMENT_COST = 1_000_000;
/**
 * Integer scaling for the assignment: finite costs live in [0, MEASURED_COST_CAP],
 * scaled to millesimal precision; cardinality penalties are derived from the
 * actual matrix size so one missing pair can never become cheaper than a large
 * set of finite matches.
 */
const COST_SCALE = 1_000;

/**
 * `|observed − target| / target`, or the UNKNOWN cost when no bandwidth was
 * declared. Never 0 for an absent value: a row that declares nothing must not
 * out-rank a row that declares something merely because 0 is "closest".
 */
export function normalizedBitrateCost(
	target: number,
	observed: number | undefined,
): number {
	if (observed === undefined || !(target > 0)) {
		return UNKNOWN_BITRATE_COST;
	}
	return Math.min(
		Math.abs(observed - target) / target,
		MAX_NORMALIZED_BITRATE_COST,
	);
}

export type OneToOneInput<E, O> = {
	expected: readonly E[];
	observed: readonly O[];
	/** Canonical key of an expected node — unique within the manifest (a duplicate is a caller bug). */
	expectedKey: (e: E) => string;
	/** Canonical key of an observed row — identical keys are one row observed twice. */
	observedKey: (o: O) => string;
	compatible: (e: E, o: O) => boolean;
	/** Finite, ≥ 0; consulted only for compatible pairs. */
	cost: (e: E, o: O) => number;
};

export type OneToOneResult<E, O> = {
	/** Bound pairs, in expected canonical-key order. */
	pairs: { expected: E; observed: O; cost: number }[];
	/** Expected nodes no observed row could be bound to, canonical order. */
	unmatchedExpected: E[];
	/** Observed rows (one per canonical key) bound to no expected node, canonical order. */
	unmatchedObserved: O[];
	/** Observed canonical keys seen more than once, with every row that carried them. */
	duplicates: { key: string; rows: O[] }[];
};

export function matchOneToOne<E, O>(
	input: OneToOneInput<E, O>,
): OneToOneResult<E, O> {
	const expected = [...input.expected]
		.map((e) => ({ e, key: input.expectedKey(e) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	for (let i = 1; i < expected.length; i += 1) {
		if (expected[i]?.key === expected[i - 1]?.key) {
			throw new Error(
				`matchOneToOne: duplicate expected key ${JSON.stringify(expected[i]?.key)} — expected nodes must be unique`,
			);
		}
	}
	// Collapse exact duplicates on the observed side first: they are ONE row
	// observed twice, and reporting them is a separate verdict from binding.
	const byKey = new Map<string, O[]>();
	for (const o of input.observed) {
		const key = input.observedKey(o);
		byKey.set(key, [...(byKey.get(key) ?? []), o]);
	}
	const observedKeys = [...byKey.keys()].sort();
	const duplicates = observedKeys.flatMap((key) => {
		const rows = byKey.get(key) ?? [];
		return rows.length > 1 ? [{ key, rows }] : [];
	});
	const observed = observedKeys.map((key) => {
		const rows = byKey.get(key);
		const o = rows?.[0];
		if (o === undefined) {
			throw new Error("matchOneToOne: an observed key with no rows");
		}
		return { o, key };
	});

	const n = expected.length;
	const m = observed.length;
	const k = n + m;
	const maxScaledPairCost = MAX_ASSIGNMENT_COST * COST_SCALE;
	const unmatched = (Math.min(n, m) + 1) * maxScaledPairCost + 1;
	const incompatible = 2 * unmatched + maxScaledPairCost + 1;
	if (!Number.isSafeInteger(incompatible)) {
		throw new Error(
			`matchOneToOne: ${n} expected + ${m} observed nodes exceed the exact assignment-cost range`,
		);
	}
	// Square matrix: real rows/cols plus one dummy per real node on the other
	// side, so every real node can always be left unmatched at a known price.
	const a: number[][] = [];
	for (let i = 0; i < k; i += 1) {
		const row: number[] = [];
		for (let j = 0; j < k; j += 1) {
			if (i < n && j < m) {
				const e = expected[i]?.e as E;
				const o = observed[j]?.o as O;
				row.push(
					input.compatible(e, o)
						? Math.round(
								Math.min(Math.max(input.cost(e, o), 0), MAX_ASSIGNMENT_COST) *
									COST_SCALE,
							)
						: incompatible,
				);
			} else if (i < n || j < m) {
				row.push(unmatched);
			} else {
				row.push(0);
			}
		}
		a.push(row);
	}
	const assignment = hungarian(a);

	const pairs: OneToOneResult<E, O>["pairs"] = [];
	const unmatchedExpected: E[] = [];
	const matchedObserved = new Set<number>();
	for (let i = 0; i < n; i += 1) {
		const j = assignment[i];
		const e = expected[i]?.e as E;
		if (j !== undefined && j < m && a[i]?.[j] !== incompatible) {
			const o = observed[j]?.o as O;
			matchedObserved.add(j);
			pairs.push({ expected: e, observed: o, cost: input.cost(e, o) });
		} else {
			unmatchedExpected.push(e);
		}
	}
	const unmatchedObserved = observed
		.filter((_, j) => !matchedObserved.has(j))
		.map((x) => x.o);
	return { pairs, unmatchedExpected, unmatchedObserved, duplicates };
}

/**
 * The Hungarian (Kuhn–Munkres) assignment on a square cost matrix, O(k³):
 * returns `col[row]`. Deterministic for a given matrix — ties resolve toward
 * the lowest column index, which after the caller's canonical sort is the
 * lowest observed key.
 */
function hungarian(a: number[][]): number[] {
	const k = a.length;
	if (k === 0) {
		return [];
	}
	const INF = Number.POSITIVE_INFINITY;
	const u = new Array<number>(k + 1).fill(0);
	const v = new Array<number>(k + 1).fill(0);
	const p = new Array<number>(k + 1).fill(0);
	const way = new Array<number>(k + 1).fill(0);
	const cell = (i: number, j: number): number => {
		const value = a[i - 1]?.[j - 1];
		if (value === undefined) {
			throw new Error("hungarian: matrix is not square");
		}
		return value;
	};
	for (let i = 1; i <= k; i += 1) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array<number>(k + 1).fill(INF);
		const used = new Array<boolean>(k + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0] as number;
			let delta = INF;
			let j1 = 0;
			for (let j = 1; j <= k; j += 1) {
				if (used[j]) {
					continue;
				}
				const cur = cell(i0, j) - (u[i0] as number) - (v[j] as number);
				if (cur < (minv[j] as number)) {
					minv[j] = cur;
					way[j] = j0;
				}
				if ((minv[j] as number) < delta) {
					delta = minv[j] as number;
					j1 = j;
				}
			}
			for (let j = 0; j <= k; j += 1) {
				if (used[j]) {
					u[p[j] as number] = (u[p[j] as number] as number) + delta;
					v[j] = (v[j] as number) - delta;
				} else {
					minv[j] = (minv[j] as number) - delta;
				}
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0] as number;
			p[j0] = p[j1] as number;
			j0 = j1;
		} while (j0 !== 0);
	}
	const col = new Array<number>(k).fill(-1);
	for (let j = 1; j <= k; j += 1) {
		const row = p[j] as number;
		if (row > 0) {
			col[row - 1] = j - 1;
		}
	}
	return col;
}
