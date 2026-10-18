/**
 * Minimal in-memory stand-in for a Prisma model delegate — just enough of
 * the create/findMany/findUnique/update/delete + omit/select semantics for
 * unit-testing the store layer's encryption boundary without Postgres.
 * `globalOmit` mirrors the constructor-level omit configured in
 * createPrismaClient: stripped from every read unless an explicit `select`
 * asks for the column (Prisma's documented precedence).
 */

type Row = Record<string, unknown>;

type DelegateArgs = {
	where?: { id: string };
	data?: Row;
	omit?: Record<string, boolean>;
	select?: Record<string, boolean>;
	orderBy?: unknown;
};

export function fakeTable(globalOmit: string[] = []) {
	const rows = new Map<string, Row>();

	function strip(row: Row, omit?: Record<string, boolean>): Row {
		const copy = { ...row };
		for (const key of globalOmit) {
			delete copy[key];
		}
		for (const [key, on] of Object.entries(omit ?? {})) {
			// omit: { x: false } means "include despite a global omit".
			if (on) {
				delete copy[key];
			}
		}
		return copy;
	}

	function pick(row: Row, select: Record<string, boolean>): Row {
		const out: Row = {};
		for (const [key, on] of Object.entries(select)) {
			if (on) {
				out[key] = row[key];
			}
		}
		return out;
	}

	const delegate = {
		rows,
		async create(args: DelegateArgs): Promise<Row> {
			const data = args.data ?? {};
			const id = data.id as string;
			const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
			rows.set(id, row);
			return strip(row, args.omit);
		},
		async findMany(args: DelegateArgs = {}): Promise<Row[]> {
			return [...rows.values()].map((row) => strip(row, args.omit));
		},
		async findUnique(args: DelegateArgs): Promise<Row | null> {
			const row = args.where ? rows.get(args.where.id) : undefined;
			if (!row) {
				return null;
			}
			return args.select ? pick(row, args.select) : strip(row, args.omit);
		},
		async findUniqueOrThrow(args: DelegateArgs): Promise<Row> {
			const row = await delegate.findUnique(args);
			if (!row) {
				throw new Error("Record not found");
			}
			return row;
		},
		async update(args: DelegateArgs): Promise<Row> {
			const row = args.where ? rows.get(args.where.id) : undefined;
			if (!row) {
				throw new Error("Record not found");
			}
			Object.assign(row, args.data, { updatedAt: new Date() });
			return strip(row, args.omit);
		},
		async delete(args: DelegateArgs): Promise<Row> {
			const row = args.where ? rows.get(args.where.id) : undefined;
			if (!row) {
				// Prisma throws P2025 on deleting a missing record.
				throw new Error("Record to delete does not exist");
			}
			rows.delete((args.where as { id: string }).id);
			return strip(row);
		},
	};
	return delegate;
}

/**
 * Prisma test doubles that HONOUR `select`.
 *
 * A hand-rolled mock like `findFirst: vi.fn(async  => row)` returns the whole
 * row whatever the caller asked for, which makes a wrong `select` invisible to
 * the suite. Measured across the worker on 2026-08-15 (review of  and
 * #86): six of twelve worker Prisma mocks never mention `select` at all, and a
 * production `select` field could be deleted in six different subsystems with
 * every one of their suites staying green.
 *
 * Two of those were not academic:
 *
 *  - `orchestrator/processor.ts` — dropping `gateVerdict` left all 36
 *    gate-specific tests passing while production refused EVERY gated delivery
 *    with "QC verdict missing on a finished measurement".
 *  - `watch/sweep.ts` — dropping `stableCount` makes production compute
 *    `undefined + 1 = NaN` and persist it, so a watch rule never stabilises and
 *    never fires.
 *
 * `tsc` catches most of these on its own — that is the real guard, and a mock
 * fix is defence-in-depth rather than a hole closed. It is NOT the guard where
 * a cast intervenes: `vmaf/processor.ts` laundered a `select`ed query through
 * an `as` cast onto a hand-written row type, and there the compiler reported
 * nothing at all. Projection here covers both cases without having to know
 * which one a given call site is.
 */

/**
 * Narrow a row to the keys a Prisma `select` requested.
 *
 * `undefined` select means "no projection" — Prisma returns the full row — so
 * the double must too, or every existing test that omits `select` breaks.
 * Only keys explicitly set truthy survive, matching Prisma: `{a: false}` omits.
 */
export function projectSelected<T extends Record<string, unknown>>(
	row: T,
	select?: Record<string, unknown>,
): Partial<T> {
	if (!select) {
		return row;
	}
	return Object.fromEntries(
		Object.entries(row).filter(([key]) => Boolean(select[key])),
	) as Partial<T>;
}

/**
 * Wrap a row-returning fake so it projects.
 *
 * Takes the resolver rather than a fixed row so a test can still vary what it
 * returns per call (by `where`, by call count) and get projection for free:
 *
 *   findFirst: vi.fn(projecting(async  => opts.vmafRow ?? null))
 */
export function projecting<A extends { select?: Record<string, unknown> }>(
	resolve: (args: A) => Promise<Record<string, unknown> | null>,
): (args?: A) => Promise<Record<string, unknown> | null> {
	return async (args?: A) => {
		const row = await resolve((args ?? {}) as A);
		return row === null ? null : projectSelected(row, args?.select);
	};
}

/**
 * The list form: projects every row, so a `findMany` double cannot hide a
 * missing field either. `watch/sweep.ts`'s `stableCount` sat behind exactly
 * this shape.
 */
export function projectingMany<A extends { select?: Record<string, unknown> }>(
	resolve: (args: A) => Promise<Record<string, unknown>[]>,
): (args?: A) => Promise<Record<string, unknown>[]> {
	return async (args?: A) => {
		const rows = await resolve((args ?? {}) as A);
		return rows.map((row) => projectSelected(row, args?.select));
	};
}
