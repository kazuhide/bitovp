import type { AppPrismaClient } from "@bitovp/db";
import { createPrismaClient } from "@bitovp/db";
import { afterAll, describe, expect, it, vi } from "vitest";
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
 * statement, which is why the last describe runs the real thing against a real
 * database (opt-in, like `reset-live-probe.test.ts`) and why the plan numbers
 * live in the helper's own docblock.
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

/**
 * What no double can answer: does that statement really return one row per
 * channel, and is it really the NEWEST one?
 *
 * Opt-in, exactly like `reset-live-probe.test.ts`: the gate suite is offline by
 * rule, so this is skipped unless PROBE_DATABASE_URL names a probe database —
 * and the name check is also the guard, because this block TRUNCATES the two
 * live tables and must not be able to reach the real one whatever the
 * environment says. TYPECHECK-COVERED ONLY in a normal `pnpm test` run: a green
 * gate is not evidence about anything in here.
 *
 * Run (2026-08-29, Postgres 17 in this compose stack) — recorded because the
 * gate cannot re-run it:
 *
 *   createdb bitovp_run_probe && DATABASE_URL=…/bitovp_run_probe \
 *     pnpm --filter @bitovp/db exec prisma migrate deploy
 *   PROBE_DATABASE_URL=…/bitovp_run_probe pnpm --filter @bitovp/web \
 *     exec vitest run src/lib/server/latest-runs.test.ts
 *   → 2 passed. Mutating `LIMIT 1` → `LIMIT 5` failed the first arm with seq
 *     [1, 1, 3] where [1, 3, 7] was expected (the map keeps the LAST row it is
 *     handed per channel, so extra rows overwrite the newest); mutating
 *     `ORDER BY r."seq" DESC` → `ASC` failed it with [1, 1, 1] — the OLDEST
 *     airing of each channel.
 */
const probeUrl = process.env.PROBE_DATABASE_URL ?? "";
const PROBE = /\/bitovp_run_probe(\?|$)/.test(probeUrl);

describe.skipIf(!PROBE)("latestRunsFor against a real Postgres", () => {
	const prisma = createPrismaClient(probeUrl);
	afterAll(async () => {
		await prisma.$disconnect();
	});

	/** 1, 3 and 7 airings — the shapes a re-aired channel actually reaches. */
	const PLAN = [1, 3, 7];

	async function seed(): Promise<string[]> {
		await prisma.$executeRawUnsafe(
			'TRUNCATE TABLE "LiveChannelRun", "LiveChannel" CASCADE',
		);
		const ids: string[] = [];
		for (const airings of PLAN) {
			const channel = await prisma.liveChannel.create({
				data: { name: `probe-${airings}`, plan: {} },
				select: { id: true },
			});
			ids.push(channel.id);
			for (let seq = 1; seq <= airings; seq += 1) {
				await prisma.liveChannelRun.create({
					data: {
						liveChannelId: channel.id,
						seq,
						// Only the newest may be non-terminal: the partial unique
						// index allows at most one live run per channel (#108 PR1).
						status: seq === airings ? "RUNNING" : "STOPPED",
						outputPrefix: `runs/${seq}`,
						lastHeartbeat: { at: `2026-08-29T00:00:0${seq}.000Z` },
					},
				});
			}
		}
		return ids;
	}

	it("returns exactly one row per channel, and it is the newest seq", async () => {
		const ids = await seed();
		const map = await latestRunsFor(prisma, ids);
		expect(map.size).toBe(ids.length);
		expect(ids.map((id) => map.get(id)?.seq)).toEqual(PLAN);
		// The row really is that run's, not another channel's newest.
		for (const id of ids) {
			expect(map.get(id)?.liveChannelId).toBe(id);
		}
	});

	it("a channel with no runs is absent, rather than a null row", async () => {
		const ids = await seed();
		const empty = await prisma.liveChannel.create({
			data: { name: "probe-never-aired", plan: {} },
			select: { id: true },
		});
		const map = await latestRunsFor(prisma, [...ids, empty.id]);
		expect(map.has(empty.id)).toBe(false);
		expect(map.size).toBe(ids.length);
	});
});
