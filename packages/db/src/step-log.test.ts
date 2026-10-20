import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import {
	appendLiveChannelStepLogEntry,
	appendLiveEffectStepLogEntry,
	mergeEncodingJobSnapshot,
	replaceLiveRunStepLogSnapshot,
} from "./step-log";

/**
 * Both helpers exist to write a JSON column WITHOUT reading it first, because
 * read-modify-write loses a concurrent writer's data and a Prisma interactive
 * `$transaction` does not fix that under Read Committed. These tests pin the two
 * properties that make the SQL correct and that a "simplification" would break.
 *
 * The `jsonb` semantics themselves were verified against the real Postgres 17 in
 * this compose stack:
 *
 *   '{"a":1}'  || '{"b":2}'  →  {"a": 1, "b": 2}     (object MERGE — the point)
 *   '[1,2]'    || '{"b":2}'  →  [1, 2, {"b": 2}]     (no error, garbage shape)
 *   '7'        || '{"b":2}'  →  [7, {"b": 2}]        (ditto)
 *   jsonb_typeof(NULL)       →  NULL                 (so a null column takes ELSE)
 *   '{"a":1,"b":9}' || '{"b":2}' → {"a": 1, "b": 2}  (idempotent overwrite)
 *
 * which is why the merge is guarded by `jsonb_typeof(...) = 'object'` rather than
 * applying `||` unconditionally.
 */

function fakePrisma(
	// Args typed variadic on purpose: with `vi.fn(async  => 1)` the inferred call
	// tuple is `[]`, so every `calls[0]?.[1]` below is a typecheck error even though
	// vitest runs them happily — the gate that catches that is tsc, not vitest.
	executeRaw = vi.fn(async (..._args: unknown[]) => 1),
) {
	return {
		prisma: { $executeRaw: executeRaw } as unknown as AppPrismaClient,
		executeRaw,
	};
}

/** The interpolated SQL, with `${}` slots rendered as `$n`, for text assertions. */
function sqlOf(call: unknown[]): string {
	const strings = call[0] as string[];
	return strings.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join("");
}

describe("replaceLiveRunStepLogSnapshot", () => {
	it("atomically separates incoming snapshots from the row's canonical receipts", async () => {
		const { prisma, executeRaw } = fakePrisma();
		await replaceLiveRunStepLogSnapshot(prisma, "channel", "run", []);
		const sql = sqlOf(executeRaw.mock.calls[0] ?? []);
		expect(sql).toContain('UPDATE "LiveChannelRun" AS run');
		expect(sql).toContain('jsonb_array_elements(run."stepLog")');
		expect(sql).toContain(
			"incoming.entry->>'kind' IS DISTINCT FROM 'LIVE_AUTO_SHUTDOWN_UPDATE'",
		);
		expect(sql).toContain(
			"canonical.entry->>'kind' = 'LIVE_AUTO_SHUTDOWN_UPDATE'",
		);
		expect(sql).toContain("ORDER BY incoming.ord");
		expect(sql).toContain("ORDER BY canonical.ord");
		expect(sql).toContain('run."liveChannelId"');
		expect(sql).not.toMatch(
			/UPDATE "LiveChannel"|lastHeartbeat|endedAt|updatedAt/,
		);
		expect(executeRaw).toHaveBeenCalledOnce();
	});
	it("binds the exact target and serializes dates and sparse fields as ordinary JSON", async () => {
		const { prisma, executeRaw } = fakePrisma();
		await replaceLiveRunStepLogSnapshot(prisma, "channel", "run", [
			{
				payload: {
					at: new Date("2026-10-21T00:00:00.000Z"),
					unused: undefined,
				},
			},
		]);
		const call = executeRaw.mock.calls[0] ?? [];
		expect(call.slice(2)).toEqual(["run", "channel"]);
		expect(JSON.parse(String(call[1]))).toEqual([
			{ payload: { at: "2026-10-21T00:00:00.000Z" } },
		]);
	});
	it("refuses non-array input before SQL and exposes a missing target", async () => {
		const { prisma, executeRaw } = fakePrisma(
			vi.fn(async (..._args: unknown[]) => 0),
		);
		await expect(
			replaceLiveRunStepLogSnapshot(
				prisma,
				"channel",
				"run",
				{} as unknown as unknown[],
			),
		).rejects.toThrow(/array/);
		expect(executeRaw).not.toHaveBeenCalled();
		expect(
			await replaceLiveRunStepLogSnapshot(prisma, "channel", "gone", []),
		).toBe(0);
	});
});

describe("mergeEncodingJobSnapshot", () => {
	it("merges with `jsonb ||` and never reads the column first", async () => {
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", {
			perTitleResults: { a: 1 },
		});
		const sql = sqlOf(executeRaw.mock.calls[0] ?? []);
		expect(sql).toContain('"snapshots" || ');
		expect(sql).toContain("::jsonb");
		expect(sql).toContain('UPDATE "EncodingJob"');
		// No SELECT anywhere: the absence of the read is what removes the race.
		expect(sql.toUpperCase()).not.toContain("SELECT");
	});

	it("puts the MERGE in the object branch, not the other way round", async () => {
		// The mutant every other assertion in this file misses: swap the branch bodies
		// and the statement replaces the whole shared column on every capture after
		// the first, while still containing `"snapshots" ||`, `::jsonb`, the
		// `jsonb_typeof` guard and an `ELSE` (review finding). The branch mapping is
		// the only part of this statement that decides merge-versus-replace.
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", { perTitleResults: {} });
		const sql = sqlOf(executeRaw.mock.calls[0] ?? []);
		const thenBody = sql.slice(sql.indexOf("THEN"), sql.indexOf("ELSE"));
		const elseBody = sql.slice(sql.indexOf("ELSE"));
		expect(thenBody).toContain('"snapshots" ||');
		expect(elseBody).not.toContain('"snapshots" ||');
	});

	it("guards the merge on the column actually being an object", async () => {
		// Without this, a column holding an array or a scalar produces
		// `[1,2,{"perTitleResults":…}]` — no error, and a shape nothing can parse.
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", { perTitleResults: {} });
		const sql = sqlOf(executeRaw.mock.calls[0] ?? []);
		expect(sql).toContain("jsonb_typeof(\"snapshots\") = 'object'");
		expect(sql).toContain("ELSE");
	});

	it("serialises the patch, dropping `undefined` — Prisma rejects it", async () => {
		// THE reason serialisation lives here rather than at the call site: the
		// per-title snapshot's `params` is a codec config as the SDK returned it, a
		// CLASS INSTANCE whose unset fields are `undefined`, which is not a JSON
		// value. Neither a cast nor typecheck shows that before the first sparse
		// config reaches the database.
		class SparseConfig {
			bitrate = 4_200_000;
			profile: string | undefined = undefined;
			level: string | undefined = undefined;
		}
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", {
			perTitleResults: {
				params: new SparseConfig(),
				nested: [{ x: undefined }],
			},
		});
		const json = executeRaw.mock.calls[0]?.[1] as string;
		expect(typeof json).toBe("string");
		const parsed = JSON.parse(json);
		expect(parsed.perTitleResults.params).toEqual({ bitrate: 4_200_000 });
		expect(Object.keys(parsed.perTitleResults.params)).not.toContain("profile");
		// And the whole tree: `JSON.stringify([undefined])` is "[null]", so an array
		// hole becomes an explicit null rather than vanishing — assert we know which.
		expect(parsed.perTitleResults.nested).toEqual([{}]);
		expect(json).not.toContain("undefined");
	});

	it("renders Date instances as ISO strings, not Prisma's DateTime tags", async () => {
		// THE reason the serialisation exists (a review measured that `undefined` is
		// silently dropped by Prisma rather than rejected, which is what the first
		// version of this comment claimed). Every Bitmovin codec config carries real
		// Dates via `BitmovinResource`, and no test had one.
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", {
			perTitleResults: {
				params: { createdAt: new Date("2026-08-11T00:00:00.000Z") },
			},
		});
		const parsed = JSON.parse(executeRaw.mock.calls[0]?.[1] as string);
		expect(parsed.perTitleResults.params.createdAt).toBe(
			"2026-08-11T00:00:00.000Z",
		);
		expect(JSON.stringify(parsed)).not.toContain("$type");
	});

	it("keeps the write off a job that is no longer terminal", async () => {
		// The status predicate is an atomic claim: the caller checks terminality, then
		// spends seconds reading Bitmovin, and a Retry in that window can make the row
		// active again (review finding).
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, "job-1", { perTitleResults: {} });
		const sql = sqlOf(executeRaw.mock.calls[0] ?? []);
		expect(sql).toContain("\"status\" NOT IN ('QUEUED', 'RUNNING')");
	});

	it("passes the id as a bound parameter, not string-interpolated", async () => {
		// Ids come from a route param. Interpolating one into the SQL text would be
		// an injection point; the tagged template binds it.
		const { prisma, executeRaw } = fakePrisma();
		await mergeEncodingJobSnapshot(prisma, '\'; DROP TABLE "EncodingJob"; --', {
			perTitleResults: {},
		});
		const call = executeRaw.mock.calls[0] ?? [];
		expect(sqlOf(call)).not.toContain("DROP TABLE");
		// Asserted by CONTENT, not by position: the JSON patch is interpolated into
		// both CASE branches, so the id is the third bound value, and a positional
		// assertion here silently checked the patch instead of the id.
		expect(call.slice(1)).toContain('\'; DROP TABLE "EncodingJob"; --');
	});

	it("returns the row count so a deleted job is not reported as written", async () => {
		const { prisma } = fakePrisma(vi.fn(async (..._args: unknown[]) => 0));
		expect(
			await mergeEncodingJobSnapshot(prisma, "gone", { perTitleResults: {} }),
		).toBe(0);
	});
});

describe("appendLiveChannelStepLogEntry", () => {
	it("wraps the entry in an ARRAY so `||` concatenates rather than merges", async () => {
		// Load-bearing, per its docblock: `jsonb || jsonb` merges two objects and
		// concatenates two arrays, so passing the bare entry would be a
		// shape-dependent bug waiting for someone to "simplify" it.
		const { prisma, executeRaw } = fakePrisma();
		await appendLiveChannelStepLogEntry(prisma, "chan-1", {
			step: "start",
			kind: "START_LIVE_ENCODING",
			payload: {},
			refs: {},
			status: "DONE",
		});
		const json = executeRaw.mock.calls[0]?.[1] as string;
		expect(JSON.parse(json)).toHaveLength(1);
		expect(Array.isArray(JSON.parse(json))).toBe(true);
	});
});

describe("appendLiveEffectStepLogEntry", () => {
	const claim = {
		id: "00000000-0000-4000-8000-000000000001",
		idempotencyKey: "manual:scte35:channel:request",
		token: "00000000-0000-4000-8000-000000000002",
		liveChannelId: "00000000-0000-4000-8000-000000000003",
		liveChannelRunId: "00000000-0000-4000-8000-000000000004",
		providerEncodingId: "provider-encoding-old",
		action: "SCTE35" as const,
		generation: 7,
		expiresAt: new Date("2026-06-12T00:20:00.000Z"),
	};
	const entry = {
		step: "scte35-cue:2026-06-12T00:00:00.000Z",
		kind: "SCTE35_CUE" as const,
		payload: { providerEntryId: "provider-cue-1" },
		refs: {},
		status: "DONE" as const,
	};

	it("always appends evidence to the exact claimed run and conditionally projects it to the current channel", async () => {
		const executeRaw = vi
			.fn(async (..._args: unknown[]) => 1)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0);
		let prisma: AppPrismaClient;
		prisma = {
			$queryRaw: vi.fn(async () => [{ id: claim.liveChannelId }]),
			$executeRaw: executeRaw,
			$transaction: async (fn: (tx: AppPrismaClient) => Promise<unknown>) =>
				fn(prisma),
		} as unknown as AppPrismaClient;

		await expect(
			appendLiveEffectStepLogEntry(prisma, claim, entry),
		).resolves.toEqual({ runUpdated: 1, channelUpdated: 0 });
		const runSql = sqlOf(executeRaw.mock.calls[0] ?? []);
		const channelSql = sqlOf(executeRaw.mock.calls[1] ?? []);
		expect(runSql).toContain('UPDATE "LiveChannelRun"');
		expect(runSql).toContain('"liveChannelId"');
		expect(runSql).toContain('"bitmovinEncodingId"');
		expect(runSql).toContain('FROM "LiveEffectClaim"');
		expect(runSql).toContain("effect.generation");
		expect(channelSql).toContain('UPDATE "LiveChannel"');
		expect(channelSql).toContain('"liveEffectFenceVersion"');
		expect(channelSql).toContain('FROM "LiveEffectClaim"');
		expect(channelSql).toContain("effect.state = 'DISPATCHING'");
		expect(executeRaw.mock.calls[0]?.slice(1)).toEqual(
			expect.arrayContaining([
				claim.id,
				claim.token,
				claim.liveChannelRunId,
				claim.liveChannelId,
				claim.providerEncodingId,
				claim.generation,
			]),
		);
		expect(executeRaw.mock.calls[1]?.slice(1)).toEqual(
			expect.arrayContaining([
				claim.id,
				claim.token,
				claim.liveChannelRunId,
				claim.providerEncodingId,
				claim.generation,
			]),
		);
	});

	it("never projects onto the channel when the exact claimed run is missing or mismatched", async () => {
		const executeRaw = vi.fn(async (..._args: unknown[]) => 0);
		let prisma: AppPrismaClient;
		prisma = {
			$queryRaw: vi.fn(async () => [{ id: claim.liveChannelId }]),
			$executeRaw: executeRaw,
			$transaction: async (fn: (tx: AppPrismaClient) => Promise<unknown>) =>
				fn(prisma),
		} as unknown as AppPrismaClient;

		await expect(
			appendLiveEffectStepLogEntry(prisma, claim, entry),
		).resolves.toEqual({ runUpdated: 0, channelUpdated: 0 });
		expect(executeRaw).toHaveBeenCalledOnce();
		expect(sqlOf(executeRaw.mock.calls[0] ?? [])).toContain(
			'UPDATE "LiveChannelRun"',
		);
	});
});
