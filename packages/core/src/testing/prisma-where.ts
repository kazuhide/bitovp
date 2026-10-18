/**
 * An HONEST in-memory reading of a Prisma `where` / `select` / `orderBy` for
 * test doubles (rev409 R1, rev413 R1, rev412 R1 — three review rounds found
 * the same shape: a fake that ignored `where` let a lost filter, a lost row
 * binding and a dead CAS branch pass green). Shared so every route/worker
 * double judges the same query shapes the same way; a shape this file does
 * not understand THROWS instead of matching everything.
 *
 * Semantics follow the DATABASE, not JavaScript (rev416):
 *   - a column the fixture never set is NULL (equal to `null`, not `undefined`);
 *   - a filter value of `undefined` is NO filter (Prisma drops the key);
 *   - three-valued logic: any comparison against a NULL column is UNKNOWN,
 *     and an UNKNOWN predicate never selects the row — `not`, `notIn`, `NOT`
 *     and the ordering operators all exclude NULL columns; only `IS NULL`
 *     (`{ col: null }`, `{ equals: null }`) and `IS NOT NULL` (`{ not: null }`)
 *     are defined on them;
 *   - ordering (lt/lte/gt/gte, orderBy) is the column's: numbers numerically,
 *     Dates by time, strings lexicographically; mixed kinds THROW;
 *   - a to-one relation filter is the LEFT JOIN Prisma 6.19 generates (read
 *     off the query log against Postgres, 2026-09-05): plain and `is` are
 *     `pred(j0) AND j0.id IS NOT NULL` — a missing relation never matches and
 *     an UNKNOWN on the related row stays UNKNOWN; `isNot` is
 *     `NOT pred(j0) OR j0.id IS NULL` — a missing relation IS selected;
 *   - `select` of a known relation yields the related record (or null);
 *   - known blind spot: a schemaless double cannot tell a typo from a column
 *     the fixture never set, so `select` of a nonexistent column yields null
 *     where Prisma raises a validation error.
 */
export type Row = Record<string, unknown>;

/**
 * Resolve a relation filter (`{ liveChannel: { id: … } }`) to the related row:
 * `null` = the relation is known but no row is linked; `undefined` = this is
 * not a relation the double knows, so the filter is an unsupported shape.
 */
export type RelationResolver = (
	row: Row,
	relation: string,
) => Row | null | undefined;

/** SQL's three values: true, false, or UNKNOWN (null). */
type Tri = boolean | null;

const OPERATORS = new Set([
	"equals",
	"not",
	"in",
	"notIn",
	"lt",
	"lte",
	"gt",
	"gte",
	"contains",
	"startsWith",
	"endsWith",
]);

function isNull(value: unknown): boolean {
	return value === null || value === undefined;
}

/**
 * A Prisma field reference (`prisma.model.fields.column` — column against
 * column in SQL). Duck-typed on the shape the client's `FieldRefImpl`
 * exposes, so the real client's refs and `fieldRef` fakes both resolve.
 */
type FieldRefLike = { modelName: string; name: string; typeName: string };
function isFieldRef(value: unknown): value is FieldRefLike {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as FieldRefLike).name === "string" &&
		typeof (value as FieldRefLike).modelName === "string" &&
		typeof (value as FieldRefLike).typeName === "string"
	);
}

/** A fake field reference, for a double's `fields` map. */
export function fieldRef(modelName: string, name: string): FieldRefLike {
	return { modelName, name, typeName: "String" };
}

/** `fields: fieldRefs("EncodingJob", ["bitmovinEncodingId"])` on a fake model. */
export function fieldRefs<N extends string>(
	modelName: string,
	names: readonly N[],
): Record<N, FieldRefLike> {
	return Object.fromEntries(
		names.map((n) => [n, fieldRef(modelName, n)]),
	) as Record<N, FieldRefLike>;
}

function timeOf(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	throw new Error(`prisma-where: cannot order ${JSON.stringify(value)}`);
}

/**
 * Order two NON-NULL values the way Postgres orders the column: numbers
 * numerically, Dates (or a Date against a date string/number) by time,
 * strings lexicographically. Mixed kinds throw — `{ n: { gt: "5" } }` on a
 * numeric column is a fixture defect, not a comparison.
 */
function compareValues(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (a instanceof Date || b instanceof Date) return timeOf(a) - timeOf(b);
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (typeof a === "boolean" && typeof b === "boolean") {
		return Number(a) - Number(b);
	}
	throw new Error(
		`prisma-where: cannot order ${JSON.stringify(a)} against ${JSON.stringify(b)}`,
	);
}

/** Equality of two NON-NULL values (Dates by time). */
function sameValue(a: unknown, b: unknown): boolean {
	if (a instanceof Date || b instanceof Date) return timeOf(a) === timeOf(b);
	return a === b;
}

const not = (t: Tri): Tri => (t === null ? null : !t);
const and = (ts: Tri[]): Tri =>
	ts.some((t) => t === false)
		? false
		: ts.some((t) => t === null)
			? null
			: true;
const or = (ts: Tri[]): Tri =>
	ts.some((t) => t === true) ? true : ts.some((t) => t === null) ? null : false;

/** `value <op> arg` under three-valued logic. */
function evalOperator(value: unknown, cond: Row, row: Row): Tri {
	const parts: Tri[] = [];
	for (const [op, arg] of Object.entries(cond)) {
		if (!OPERATORS.has(op)) {
			throw new Error(`prisma-where: unsupported operator ${op}`);
		}
		if (arg === undefined) continue; // Prisma drops an undefined operand
		if (isFieldRef(arg)) {
			// Column against column: `a <op> b` is UNKNOWN when either is NULL
			// (Postgres `<>`/`=` never yields true or false against NULL).
			const other = row[arg.name];
			if (isNull(value) || isNull(other)) {
				parts.push(null);
				continue;
			}
			if (op === "equals" || op === "not") {
				const same = sameValue(value, other);
				parts.push(op === "equals" ? same : !same);
				continue;
			}
			if (op === "lt" || op === "lte" || op === "gt" || op === "gte") {
				const cmp = compareValues(value, other);
				parts.push(
					op === "lt"
						? cmp < 0
						: op === "lte"
							? cmp <= 0
							: op === "gt"
								? cmp > 0
								: cmp >= 0,
				);
				continue;
			}
			throw new Error(
				`prisma-where: a field reference under ${op} is not modelled`,
			);
		}
		switch (op) {
			case "equals":
				parts.push(
					arg === null
						? isNull(value)
						: isNull(value)
							? null
							: sameValue(value, arg),
				);
				break;
			case "not":
				if (arg !== null && typeof arg === "object" && !(arg instanceof Date)) {
					parts.push(not(evalOperator(value, arg as Row, row)));
				} else {
					parts.push(
						arg === null
							? !isNull(value)
							: isNull(value)
								? null
								: !sameValue(value, arg),
					);
				}
				break;
			case "in":
				parts.push(
					isNull(value)
						? null
						: (arg as unknown[]).some((v) => !isNull(v) && sameValue(value, v)),
				);
				break;
			case "notIn":
				parts.push(
					isNull(value)
						? null
						: !(arg as unknown[]).some(
								(v) => !isNull(v) && sameValue(value, v),
							),
				);
				break;
			case "lt":
			case "lte":
			case "gt":
			case "gte": {
				if (isNull(value) || isNull(arg)) {
					parts.push(null);
					break;
				}
				const cmp = compareValues(value, arg);
				parts.push(
					op === "lt"
						? cmp < 0
						: op === "lte"
							? cmp <= 0
							: op === "gt"
								? cmp > 0
								: cmp >= 0,
				);
				break;
			}
			case "contains":
			case "startsWith":
			case "endsWith": {
				if (isNull(value)) {
					parts.push(null);
					break;
				}
				const s = String(value);
				const needle = String(arg);
				parts.push(
					op === "contains"
						? s.includes(needle)
						: op === "startsWith"
							? s.startsWith(needle)
							: s.endsWith(needle),
				);
				break;
			}
		}
	}
	return and(parts);
}

function evalWhere(
	row: Row,
	where: Row | undefined,
	rel: RelationResolver,
): Tri {
	if (!where) return true;
	const parts: Tri[] = [];
	for (const [key, cond] of Object.entries(where)) {
		if (cond === undefined) continue; // `{ col: undefined }` is no filter
		if (key === "OR") {
			parts.push(or((cond as Row[]).map((alt) => evalWhere(row, alt, rel))));
			continue;
		}
		if (key === "AND") {
			const list = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
			parts.push(and(list.map((alt) => evalWhere(row, alt, rel))));
			continue;
		}
		if (key === "NOT") {
			const list = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
			// NOT (a OR b): the row is selected only when every alternative is
			// definitely false; an UNKNOWN alternative leaves the NOT unknown.
			parts.push(not(or(list.map((alt) => evalWhere(row, alt, rel)))));
			continue;
		}
		const value = row[key];
		if (isFieldRef(cond)) {
			// `{ col: prisma.m.fields.other }` is the equals shorthand.
			parts.push(evalOperator(value, { equals: cond }, row));
			continue;
		}
		if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
			const c = cond as Row;
			const keys = Object.keys(c);
			if (keys.length === 0) continue; // `{ col: {} }` is no filter
			if (keys.every((k) => OPERATORS.has(k))) {
				parts.push(evalOperator(value, c, row));
				continue;
			}
			// A relation filter: `{ liveChannel: { id: "…" } }` (or `is` / `isNot`).
			const related = rel(row, key);
			if (related === undefined) {
				throw new Error(
					`prisma-where: unsupported operator or unknown relation ${key}: ${JSON.stringify(c)}`,
				);
			}
			// Prisma drops a key whose value is undefined, so `{ is: undefined, name }`
			// is the plain field filter.
			const present = keys.filter((k) => c[k] !== undefined);
			// `{ rel: {} }` and `{ rel: { is: undefined } }` both compile to `1=1`
			// (no condition) — read off Prisma 6.19's query log; `is: {}` is
			// `1=1 AND j0.id IS NOT NULL` and `isNot: {}` its complement.
			if (present.length === 0) continue;
			if (present.includes("is") || present.includes("isNot")) {
				const extra = present.filter((k) => k !== "is" && k !== "isNot");
				if (extra.length > 0) {
					throw new Error(
						`prisma-where: ${key} mixes is/isNot with ${extra.join(", ")} — Prisma rejects that shape`,
					);
				}
				// `is`: pred(j0) AND j0.id IS NOT NULL; `isNot`: NOT pred(j0) OR j0.id IS NULL.
				if (c.is !== undefined) {
					parts.push(
						c.is === null
							? related === null
							: related === null
								? false
								: evalWhere(related, c.is as Row, rel),
					);
				}
				if (c.isNot !== undefined) {
					parts.push(
						c.isNot === null
							? related !== null
							: related === null
								? true
								: not(evalWhere(related, c.isNot as Row, rel)),
					);
				}
				continue;
			}
			// Plain relation filter: pred(j0) AND j0.id IS NOT NULL.
			parts.push(related === null ? false : evalWhere(related, c, rel));
			continue;
		}
		// Scalar: `{ col: null }` is IS NULL; anything else is UNKNOWN on a NULL column.
		parts.push(
			cond === null
				? isNull(value)
				: isNull(value)
					? null
					: sameValue(value, cond),
		);
	}
	return and(parts);
}

/**
 * Does `row` satisfy `where`? True only when the predicate is definitely
 * true under three-valued logic. Understands scalar equality (NULL-aware),
 * `{ equals, not, in, notIn, lt, lte, gt, gte, contains, startsWith,
 * endsWith }`, `OR` / `AND` / `NOT` lists, and one level of relation filter
 * through `rel`. Anything else throws — silence is how a double lies.
 */
export function matchesWhere(
	row: Row,
	where: Row | undefined,
	rel: RelationResolver = () => undefined,
): boolean {
	return evalWhere(row, where, rel) === true;
}

/** Apply a Prisma `select` (nested relation selects through `rel`). */
export function projectSelect(
	row: Row,
	select: Row | undefined,
	rel: RelationResolver = () => undefined,
): Row {
	if (!select) return { ...row };
	const out: Row = {};
	for (const [key, spec] of Object.entries(select)) {
		if (spec === true) {
			const related = rel(row, key);
			out[key] =
				related === undefined
					? (row[key] ?? null)
					: related
						? { ...related }
						: null;
		} else if (spec && typeof spec === "object") {
			const related = rel(row, key) ?? null;
			out[key] = related
				? projectSelect(related, (spec as Row).select as Row | undefined, rel)
				: null;
		}
	}
	return out;
}

/** Sort rows by a Prisma `orderBy` (object or list of objects). */
export function orderRows<T extends Row>(
	rows: readonly T[],
	orderBy: Row | Row[] | undefined,
): T[] {
	const keys =
		orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
	for (const spec of keys) {
		for (const [field, dir] of Object.entries(spec)) {
			if (dir !== "asc" && dir !== "desc") {
				throw new Error(
					`prisma-where: unsupported orderBy ${field}: ${JSON.stringify(dir)} (relation or nulls ordering)`,
				);
			}
		}
	}
	const sorted = [...rows];
	sorted.sort((a, b) => {
		for (const spec of keys) {
			for (const [field, dir] of Object.entries(spec)) {
				const av = a[field];
				const bv = b[field];
				if (isNull(av) && isNull(bv)) continue;
				// NULLs sort last ascending, first descending, as Postgres does.
				if (isNull(av)) return dir === "desc" ? -1 : 1;
				if (isNull(bv)) return dir === "desc" ? 1 : -1;
				const cmp = compareValues(av, bv);
				if (cmp === 0) continue;
				return dir === "desc" ? -cmp : cmp;
			}
		}
		return 0;
	});
	return sorted;
}
