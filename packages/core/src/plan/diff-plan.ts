/**
 * Pure, structural field-level diff between two plans (or any two JSON-ish
 * values) for the wizard's "diff vs preset" panel. UI-free: the React panel
 * renders this shape. Used to compare a baseline preset body (a sample or a
 * saved user preset — both secret-free EncodingPlan JSON) against the plan the
 * wizard currently has built.
 *
 * The result is a flat list of leaf-level changes addressed by dotted/bracketed
 * path (e.g. `outputs[0].acl[1].permission`). Two objects/arrays are walked
 * recursively; arrays are compared by index, objects by key (stable key order,
 * so the diff is deterministic regardless of insertion order). When the two
 * sides disagree on shape at a node (object vs array vs scalar), that node is a
 * single "changed" leaf rather than being descended into.
 */

export type PlanDiffChange = "added" | "removed" | "changed";

export type PlanDiffEntry = {
	/** Dotted/bracketed path to the leaf, e.g. `a.b[2].c`. "" is the root. */
	path: string;
	change: PlanDiffChange;
	/** Present for "removed" and "changed". */
	before?: unknown;
	/** Present for "added" and "changed". */
	after?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** path[0] for arrays, path.key (or just key at the root) for objects. */
function childPath(parent: string, key: string, isIndex: boolean): string {
	if (isIndex) {
		return `${parent}[${key}]`;
	}
	return parent === "" ? key : `${parent}.${key}`;
}

/** Structural equality for the "unchanged leaf" decision (stable key order). */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) {
			return false;
		}
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys) {
			if (!deepEqual(a[key], b[key])) {
				return false;
			}
		}
		return true;
	}
	return false;
}

function walk(before: unknown, after: unknown, path: string): PlanDiffEntry[] {
	if (deepEqual(before, after)) {
		return [];
	}

	// Both arrays → compare by index (added/removed tail, changed in place).
	if (Array.isArray(before) && Array.isArray(after)) {
		const entries: PlanDiffEntry[] = [];
		const max = Math.max(before.length, after.length);
		for (let i = 0; i < max; i++) {
			const childKey = String(i);
			if (i >= before.length) {
				entries.push({
					path: childPath(path, childKey, true),
					change: "added",
					after: after[i],
				});
			} else if (i >= after.length) {
				entries.push({
					path: childPath(path, childKey, true),
					change: "removed",
					before: before[i],
				});
			} else {
				entries.push(
					...walk(before[i], after[i], childPath(path, childKey, true)),
				);
			}
		}
		return entries;
	}

	// Both objects → compare by union of keys, stable (sorted) order.
	if (isPlainObject(before) && isPlainObject(after)) {
		const entries: PlanDiffEntry[] = [];
		const keys = [
			...new Set([...Object.keys(before), ...Object.keys(after)]),
		].sort();
		for (const key of keys) {
			const inBefore = Object.hasOwn(before, key);
			const inAfter = Object.hasOwn(after, key);
			const childKeyPath = childPath(path, key, false);
			if (!inBefore) {
				entries.push({
					path: childKeyPath,
					change: "added",
					after: after[key],
				});
			} else if (!inAfter) {
				entries.push({
					path: childKeyPath,
					change: "removed",
					before: before[key],
				});
			} else {
				entries.push(...walk(before[key], after[key], childKeyPath));
			}
		}
		return entries;
	}

	// Shape mismatch or differing scalars → a single changed leaf.
	return [{ path, change: "changed", before, after }];
}

/**
 * Field-level diff of `after` relative to `before`. Returns [] when the two
 * are structurally identical. Order is deterministic (object keys sorted,
 * array indices ascending), so callers can render/compare stably.
 */
export function diffPlans(before: unknown, after: unknown): PlanDiffEntry[] {
	return walk(before, after, "");
}
