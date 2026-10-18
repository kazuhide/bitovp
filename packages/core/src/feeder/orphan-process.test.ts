import { describe, expect, it } from "vitest";
import {
	FEEDER_PROCESS_MAY_BE_ALIVE_WHERE,
	FEEDER_PROCESS_RECLAIMED_WHERE,
	feederProcessMayBeAlive,
} from "./orphan-process";

describe("feederProcessMayBeAlive", () => {
	it("is true for the dead-job shape: a recorded pid nobody has proven gone", () => {
		// Exactly what apps/worker/src/index.ts's failed handler leaves behind
		// when a START job dies outside the processor — status ERROR, pid KEPT.
		expect(feederProcessMayBeAlive({ pid: 4242, processGoneAt: null })).toBe(
			true,
		);
	});

	it("is false once a verified kill ladder stamped processGoneAt", () => {
		expect(
			feederProcessMayBeAlive({
				pid: 4242,
				processGoneAt: new Date("2026-08-29T00:00:00.000Z"),
			}),
		).toBe(false);
		// The API hands the same fact back as an ISO string.
		expect(
			feederProcessMayBeAlive({
				pid: 4242,
				processGoneAt: "2026-08-29T00:00:00.000Z",
			}),
		).toBe(false);
	});

	it("is false for the ordinary terminal shape (pid released)", () => {
		expect(feederProcessMayBeAlive({ pid: null, processGoneAt: null })).toBe(
			false,
		);
	});

	it("treats an ABSENT processGoneAt as unproven, never as proof", () => {
		// A projection that forgot the column must refuse the delete, not
		// authorise it: the fail-safe direction costs one stop, the other
		// direction costs an unattended infinite push nobody can find.
		expect(
			feederProcessMayBeAlive({
				pid: 4242,
				processGoneAt: undefined as unknown as null,
			}),
		).toBe(true);
	});
});

/**
 * Review MEDIUM-2 — the two `where` fragments must mean exactly what the
 * predicate means.
 *
 * Three call sites (the DELETE guard, the channel-stop coupling, the boot
 * sweep) used to hand-translate the predicate into Prisma. A hand translation
 * that drifts by one key does not throw: it silently selects the wrong
 * population, and for the sweep that means an orphaned ffmpeg nobody ever
 * visits again. So the fragments are derived from one source and pinned to the
 * predicate ROW BY ROW here.
 */
type TableRow = {
	label: string;
	pid: number | null;
	processGoneAt: Date | null;
	status: "PUSHING" | "ERROR";
};

/**
 * A deliberately tiny `where` evaluator. It models EXACTLY the shapes the two
 * fragments use and THROWS on anything else — a fragment that grows a new
 * operator has to teach this evaluator about it rather than slipping past a
 * permissive matcher that answers "true" for what it does not understand.
 */
function evaluateWhere(where: unknown, row: TableRow): boolean {
	if (where === null || typeof where !== "object") {
		throw new Error(`unsupported where: ${JSON.stringify(where)}`);
	}
	return Object.entries(where as Record<string, unknown>).every(
		([field, condition]) => {
			if (field === "OR") {
				if (!Array.isArray(condition)) {
					throw new Error("OR must be an array");
				}
				return condition.some((clause) => evaluateWhere(clause, row));
			}
			if (field !== "pid" && field !== "processGoneAt") {
				throw new Error(`unsupported field: ${field}`);
			}
			const value = row[field];
			if (condition === null) {
				return value === null;
			}
			if (
				typeof condition === "object" &&
				condition !== null &&
				"not" in condition &&
				(condition as { not: unknown }).not === null
			) {
				return value !== null;
			}
			throw new Error(
				`unsupported condition on ${field}: ${JSON.stringify(condition)}`,
			);
		},
	);
}

const GONE_AT = new Date("2026-08-29T00:00:00.000Z");
/**
 * Every combination that matters — and `status` varies deliberately, to make
 * the point the whole audit finding rests on: the answer does NOT depend on it.
 */
const TABLE: TableRow[] = [
	{
		label: "dead-job ERROR, pid kept",
		pid: 4242,
		processGoneAt: null,
		status: "ERROR",
	},
	{
		label: "pushing, pid live",
		pid: 4242,
		processGoneAt: null,
		status: "PUSHING",
	},
	{
		label: "ERROR, pid proven gone",
		pid: 4242,
		processGoneAt: GONE_AT,
		status: "ERROR",
	},
	{
		label: "pushing row carrying proof (racing writer)",
		pid: 4242,
		processGoneAt: GONE_AT,
		status: "PUSHING",
	},
	{
		label: "ordinary terminal, pid released",
		pid: null,
		processGoneAt: null,
		status: "ERROR",
	},
	{
		label: "no pid yet (never reached PUSHING)",
		pid: null,
		processGoneAt: null,
		status: "PUSHING",
	},
	{
		label: "released AND proven",
		pid: null,
		processGoneAt: GONE_AT,
		status: "ERROR",
	},
	{
		label: "released AND proven, still marked pushing",
		pid: null,
		processGoneAt: GONE_AT,
		status: "PUSHING",
	},
];

describe("the where-fragments are the predicate, in Prisma's spelling", () => {
	it.each(
		TABLE,
	)("$label: the alive fragment selects exactly what the predicate calls alive", (row) => {
		expect(evaluateWhere(FEEDER_PROCESS_MAY_BE_ALIVE_WHERE, row)).toBe(
			feederProcessMayBeAlive(row),
		);
	});

	it.each(
		TABLE,
	)("$label: the reclaimed fragment selects exactly the complement", (row) => {
		expect(evaluateWhere(FEEDER_PROCESS_RECLAIMED_WHERE, row)).toBe(
			!feederProcessMayBeAlive(row),
		);
	});

	it("the two fragments partition the table (no row in both, none in neither)", () => {
		for (const row of TABLE) {
			expect(evaluateWhere(FEEDER_PROCESS_MAY_BE_ALIVE_WHERE, row)).not.toBe(
				evaluateWhere(FEEDER_PROCESS_RECLAIMED_WHERE, row),
			);
		}
	});

	it("the evaluator REFUSES a shape it does not model (a grown fragment cannot pass silently)", () => {
		const row = TABLE[0] as TableRow;
		expect(() => evaluateWhere({ status: "ERROR" }, row)).toThrow(
			/unsupported field/,
		);
		expect(() => evaluateWhere({ pid: { gt: 1 } }, row)).toThrow(
			/unsupported condition/,
		);
	});
});
