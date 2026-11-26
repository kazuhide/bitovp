import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { latestRunsFor } from "./latest-runs";

/**
 * . The helper exists because a nested `runs: { orderBy: { seq:
 * "desc" }, take: 1 }` does NOT compile to a per-channel limit: without
 * `previewFeatures = ["relationJoins"]` Prisma emits
 *
 *   SELECT … FROM "LiveChannelRun" WHERE "liveChannelId" IN ($1…$51)
 *   ORDER BY "seq" DESC OFFSET $52
 *
 * — measured on this tree against the compose Postgres, an OFFSET with no
 * LIMIT — and picks the first row per parent in the engine.
 *
 * So the property under test is a property of the SQL TEXT, and these
 * assertions read it. A double cannot prove what Postgres does with the
 * statement, which is why latest-runs.integration.test.ts runs the real thing
 * against PostgreSQL and why the plan numbers live in the helper's own
 * docblock.
 */
function fakePrisma(rows: unknown[] = []) {
	// Variadic on purpose: with `vi.fn(async  => rows)` the inferred call
	// tuple is `[]` and every `calls[0]?.[1]` below is a type error that vitest
	// would run past — typecheck is the detector for that class (AGENT-GUIDE).
	const queryRaw = vi.fn(async (..._args: unknown[]) => rows);
	return {
		prisma: { $queryRaw: queryRaw } as unknown as AppPrismaClient,
		queryRaw,
	};
}

/** The template's SQL with `${}` slots rendered as `$n` (db/step-log.test.ts). */
function sqlOf(call: unknown[]): string {
	const strings = call[0] as string[];
	return strings.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join("");
}

/** Everything between `CROSS JOIN LATERAL (` and the subquery's alias. */
function lateralBody(sql: string): string {
	const open = sql.indexOf("CROSS JOIN LATERAL (");
	const close = sql.indexOf(") AS newest");
	expect(open, "no CROSS JOIN LATERAL in the statement").toBeGreaterThan(-1);
	expect(close, "no `) AS newest` closing the lateral").toBeGreaterThan(open);
	return sql.slice(open, close);
}

const CH_A = "00000000-0000-4000-8000-0000000000a1";
const CH_B = "00000000-0000-4000-8000-0000000000b2";

function row(liveChannelId: string, seq: number) {
	return {
		id: `run-${liveChannelId}-${seq}`,
		liveChannelId,
		seq,
		lastHeartbeat: { at: "2026-08-29T12:00:00.000Z" },
		runningSince: null,
		endedAt: null,
		originObservation: null,
		providerStatus: "RUNNING",
		providerStatusObservedAt: new Date("2026-08-29T12:00:00.000Z"),
		providerUnknownSince: null,
		providerTerminalAt: null,
	};
}

describe("latestRunsFor — the limit lives in the SQL", () => {
	it("bounds each channel to ONE run inside the lateral: ORDER BY seq DESC, LIMIT 1", async () => {
		const { prisma, queryRaw } = fakePrisma();
		await latestRunsFor(prisma, [CH_A, CH_B]);
		const body = lateralBody(sqlOf(queryRaw.mock.calls[0] ?? []));
		// Both INSIDE the lateral — a LIMIT outside it would bound the page,
		// not the channel, which is a different (and wrong) query.
		expect(body).toContain('FROM "LiveChannelRun" r');
		expect(body).toContain('WHERE r."liveChannelId" = channel.id');
		expect(body).toContain('ORDER BY r."seq" DESC');
		expect(body).toContain("LIMIT 1");
		// The defect's own signature: a runs read ordered by seq with no limit.
		expect(sqlOf(queryRaw.mock.calls[0] ?? [])).not.toContain("OFFSET");
	});

	it("drives the lateral off the id array, so the work is O(page) and not O(history)", async () => {
		const { prisma, queryRaw } = fakePrisma();
		await latestRunsFor(prisma, [CH_A, CH_B]);
		const sql = sqlOf(queryRaw.mock.calls[0] ?? []);
		expect(sql).toContain("FROM unnest($1::uuid[]) AS channel(id)");
	});

	it("passes the ids as ONE bound parameter — nothing is built from a value", async () => {
		const ids = [CH_A, CH_B];
		const { prisma, queryRaw } = fakePrisma();
		await latestRunsFor(prisma, ids);
		const call = queryRaw.mock.calls[0] ?? [];
		/*
		 * ONE interpolation, and it is the array. Both halves are load-bearing
		 * and neither is a `sqlOf` assertion, because `sqlOf` cannot see this
		 * class at all: it renders only the template's STATIC strings, so a
		 * splice that puts the ids into the SQL as a value the client expands
		 * — `unnest(ARRAY[${Prisma.raw(ids.map(quote).join(","))}]::uuid[])`,
		 * the idiomatic Prisma way to inject — comes back from `sqlOf` as a
		 * plain `$1` with no id in it. Measured on this tree (review-364 S2):
		 * with that splice applied and the `call[1]` check silenced, the two
		 * `expect(sql).not.toContain(CH_A/CH_B)` lines this replaces BOTH
		 * PASSED. A negative assertion needs a fixture that violates it.
		 */
		expect(call).toHaveLength(2);
		expect(Array.isArray(call[1])).toBe(true);
		expect(call[1]).toEqual(ids);
	});

	it("selects only what the fleet reads — never the run's step log or stream key", async () => {
		const { prisma, queryRaw } = fakePrisma();
		await latestRunsFor(prisma, [CH_A]);
		const sql = sqlOf(queryRaw.mock.calls[0] ?? []);
		for (const column of [
			"liveChannelId",
			"id",
			"seq",
			"lastHeartbeat",
			"runningSince",
			"endedAt",
			"originObservation",
			"providerStatus",
			"providerStatusObservedAt",
			"providerUnknownSince",
			"providerTerminalAt",
		]) {
			expect(sql).toContain(`"${column}"`);
		}
		for (const heavy of ["stepLog", "streamKey", "encoderIp", "ingestMedia"]) {
			expect(sql).not.toContain(heavy);
		}
	});

	it("an empty page asks the database nothing at all", async () => {
		const { prisma, queryRaw } = fakePrisma();
		const map = await latestRunsFor(prisma, []);
		expect(map.size).toBe(0);
		expect(queryRaw).not.toHaveBeenCalled();
	});

	it("keys by channel, so each caller reads its OWN channel's run", async () => {
		const { prisma } = fakePrisma([row(CH_A, 4), row(CH_B, 1)]);
		const map = await latestRunsFor(prisma, [CH_A, CH_B]);
		expect(map.get(CH_A)?.seq).toBe(4);
		expect(map.get(CH_B)?.seq).toBe(1);
		expect(map.get("00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
	});
});
