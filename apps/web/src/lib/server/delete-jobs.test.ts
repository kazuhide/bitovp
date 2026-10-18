import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { deleteEncodingJobLocally, deleteVmafJobLocally } from "./delete-jobs";

const writeAuditLog = vi.fn<
	(ctx: unknown, entry: unknown, req?: Request) => Promise<void>
>(async () => {});
vi.mock("./audit", () => ({
	writeAuditLog: (ctx: unknown, entry: unknown, req?: Request) =>
		writeAuditLog(ctx, entry, req),
}));

/**
 * These pin the properties the ROUTE tests structurally cannot see. A reviewer
 * ran 27 mutations of this module against the whole web suite; 24 died. The two
 * survivors are here, and the cascade-order one is load-bearing:
 *
 * Swapping the parent `encodingJob.deleteMany` ahead of the child
 * `vmafJob.deleteMany` passes every other test, because a mocked Prisma has no
 * foreign keys. Against real Postgres it is NOT equivalent — `onDelete: SetNull`
 * nulls `encodingJobId` when the parent goes, so the follow-up
 * `deleteMany({where:{encodingJobId:id}})` matches nothing and the reports are
 * silently ORPHANED while `deletedVmafJobs` reports 0. The docstring calls the
 * order out; nothing enforced it.
 */

type Calls = string[];

function ctxFor(opts: {
	status?: string;
	preScoring?: { status: string } | null;
	inTxScoring?: number;
	parentCount?: number;
	aisaPlan?: Record<string, unknown>;
	captured?: boolean;
	calls: Calls;
}): ServerContext {
	const { calls } = opts;
	const tx = {
		$queryRaw: vi.fn(async () => {
			calls.push("lock");
			return [];
		}),
		librarySource: {
			findUnique: vi.fn(async () =>
				opts.captured ? { id: "source-1" } : null,
			),
		},
		vmafJob: {
			count: vi.fn(async () => opts.inTxScoring ?? 0),
			deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
				calls.push("vmafJob.deleteMany");
				calls.push(`vmafJob.where=${JSON.stringify(args.where)}`);
				return { count: 2 };
			}),
		},
		encodingJob: {
			findMany: vi.fn(async () =>
				opts.aisaPlan && (opts.status ?? "FINISHED") === "FINISHED"
					? [
							{
								id: "job-1",
								plan: opts.aisaPlan,
								bitmovinEncodingId: "encoding-1",
							},
						]
					: [],
			),
			deleteMany: vi.fn(async () => {
				calls.push("encodingJob.deleteMany");
				return { count: opts.parentCount ?? 1 };
			}),
		},
	};
	return {
		prisma: {
			encodingJob: {
				findUnique: vi.fn(async () => ({
					id: "job-1",
					status: opts.status ?? "FINISHED",
					bitmovinAccountId: null,
				})),
			},
			vmafJob: {
				findFirst: vi.fn(async () => opts.preScoring ?? null),
			},
			$transaction: vi.fn(
				async (fn: (t: typeof tx) => Promise<number>) => await fn(tx),
			),
		},
	} as unknown as ServerContext;
}

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * The handler's request, which now carries the proxy-verified actor into the
 * audit row . `req` is required on both deleters precisely so a
 * caller cannot omit it: security-review-212 measured 34 route files writing
 * `actor = NULL` through these helpers while the row was closed as done.
 */
const ACTOR = "token:00000000-0000-4000-8000-0000000000ac";
const REQ = new Request("https://x/api/encoding-jobs/job-1", {
	headers: { "x-bitovp-actor": ACTOR },
});

describe("deleteEncodingJobLocally — cascade order", () => {
	it("requires capture before any deletion and accepts a matching durable snapshot", async () => {
		const calls: Calls = [];
		const aisaPlan = { aiSceneAnalysis: { outputLanguageCodes: ["en"] } };
		const before = await deleteEncodingJobLocally(
			ctxFor({ calls, aisaPlan }),
			"job-1",
			{ req: REQ },
		);
		expect(before).toMatchObject({
			ok: false,
			code: "ACTIVE",
			message: expect.stringMatching(/Capture AI Scene Analysis/),
		});
		expect(calls).toEqual(["lock"]);
		const after = await deleteEncodingJobLocally(
			ctxFor({ calls, aisaPlan, captured: true }),
			"job-1",
			{ req: REQ },
		);
		expect(after.ok).toBe(true);
		expect(calls.indexOf("lock")).toBeLessThan(
			calls.indexOf("encodingJob.deleteMany"),
		);
	});
	it("deletes the CHILD reports before the parent job", async () => {
		const calls: Calls = [];
		const outcome = await deleteEncodingJobLocally(ctxFor({ calls }), "job-1", {
			req: REQ,
		});
		expect(outcome).toEqual({ ok: true, deletedVmafJobs: 2 });
		const order = calls.filter((c) => c.endsWith("deleteMany"));
		expect(order).toEqual(["vmafJob.deleteMany", "encodingJob.deleteMany"]);
	});

	it("deletes reports with a TERMINAL-status filter, never bare", async () => {
		// The filter must match the guard that ran a line earlier, or the two can
		// drift and a non-terminal report gets deleted anyway.
		const calls: Calls = [];
		await deleteEncodingJobLocally(ctxFor({ calls }), "job-1", { req: REQ });
		const where = calls.find((c) => c.startsWith("vmafJob.where="));
		expect(where).toBeDefined();
		expect(where).toContain("FINISHED");
		expect(where).toContain("ERROR");
		expect(where).toContain("encodingJobId");
	});
});

describe("deleteEncodingJobLocally — the in-tx race re-assert", () => {
	it("refuses when a report starts scoring between the read and the tx", async () => {
		// The pre-check sees nothing; the in-transaction count sees one. Only the
		// re-assert can catch that, and neutering it left the whole suite green.
		const calls: Calls = [];
		const outcome = await deleteEncodingJobLocally(
			ctxFor({ calls, preScoring: null, inTxScoring: 1 }),
			"job-1",
			{ req: REQ },
		);
		expect(outcome).toEqual({
			ok: false,
			code: "ACTIVE",
			message:
				"A VMAF report for this job started scoring — wait for it to finish before deleting",
		});
		// Nothing was deleted — the sentinel rolls the transaction back.
		expect(calls.filter((c) => c.endsWith("deleteMany"))).toEqual([]);
	});

	it("refuses up front when a report is already scoring", async () => {
		const calls: Calls = [];
		const outcome = await deleteEncodingJobLocally(
			ctxFor({ calls, preScoring: { status: "RUNNING" } }),
			"job-1",
			{ req: REQ },
		);
		expect(outcome).toMatchObject({ ok: false, code: "ACTIVE" });
		expect(calls).toEqual([]);
	});
});

describe("deleteEncodingJobLocally — terminal guard", () => {
	it("refuses an ACTIVE job using the SHARED predicate", async () => {
		// `isActiveJobStatus` is documented as the single source of truth for this;
		// this file used to hand-write the comparison as well.
		for (const status of ["QUEUED", "RUNNING"]) {
			const outcome = await deleteEncodingJobLocally(
				ctxFor({ status, calls: [] }),
				"job-1",
				{ req: REQ },
			);
			expect(outcome, status).toMatchObject({ ok: false, code: "ACTIVE" });
		}
	});

	it("reports RACED when the guarded parent delete matches nothing", async () => {
		const outcome = await deleteEncodingJobLocally(
			ctxFor({ parentCount: 0, calls: [] }),
			"job-1",
			{ req: REQ },
		);
		expect(outcome).toMatchObject({ ok: false, code: "RACED" });
	});
});

/**
 * `deleteVmafJobLocally` had NO tests, which is why its terminal guard was the
 * one change in that review round that survived being undone: reverting
 * `!VMAF_TERMINAL_STATUSES.includes(row.status)` to `isActiveVmafStatus(row.status)`
 * left the whole web suite green (review catch — F3).
 *
 * The two predicates differ on exactly one input: a status the enum does not know.
 * `isActiveVmafStatus` only answers true for PENDING/RUNNING, so an unrecognised
 * value slips PAST the pre-check and is caught only by the atomic guard, which
 * matches zero rows and reports RACED — telling the operator "someone else got
 * there first" about a row that is simply in a state we do not understand. The
 * allowlist form refuses anything it does not recognise, which is the direction a
 * guard has to fail.
 *
 * A status outside the enum is reachable without a bug: any future Prisma migration
 * that adds one (CANCELED is the obvious candidate — encoding jobs already have it)
 * puts rows in the DB before this file learns the name.
 */
/**
 * The in-transaction `deleteMany` HONOURS its `where` clause, and that is the whole
 * point of this helper rather than a detail.
 *
 * The first version returned a fixed count and ignored the filter, which made the
 * counterfactual branch model something Postgres cannot do: with the pre-check
 * reverted, a `CANCELED` row came back `ok: true` — so I read the severity off that
 * line and recorded "reverting this DELETES an unrecognised row". It does not.
 * `status: { in: ["FINISHED","ERROR"] }` cannot match CANCELED, so the real answer
 * is `count === 0` → `NotDeletable` → **RACED** — which is exactly what the
 * docstring above already said, and I contradicted it (review catch, f99).
 *
 * This is the same mock-fidelity gap the cascade-order docstring in this file warns
 * about, pointing the other way: for the cascade a loose mock HID a real bug (no
 * foreign keys, so a wrong delete order looked equivalent); here it MANUFACTURED
 * one. The second failure mode is harder to notice, because it feels like a find.
 */
function vmafCtx(status: string, deletedCount = 1): ServerContext {
	return {
		prisma: {
			vmafJob: {
				findUnique: vi.fn(async () => ({ id: "vmaf-1", status })),
			},
			$transaction: vi.fn(
				async (
					fn: (t: {
						vmafJob: {
							deleteMany: (args: {
								where: { id: string; status: { in: string[] } };
							}) => Promise<{ count: number }>;
						};
					}) => Promise<unknown>,
				) =>
					await fn({
						vmafJob: {
							deleteMany: async ({ where }) =>
								// Postgres deletes what the filter matches, nothing more.
								where.status.in.includes(status)
									? { count: deletedCount }
									: { count: 0 },
						},
					}),
			),
		},
	} as unknown as ServerContext;
}

describe("deleteVmafJobLocally — terminal guard", () => {
	it("deletes a FINISHED report", async () => {
		const outcome = await deleteVmafJobLocally(vmafCtx("FINISHED"), "vmaf-1", {
			req: REQ,
		});
		expect(outcome).toMatchObject({ ok: true });
	});

	for (const status of ["PENDING", "RUNNING"]) {
		it(`refuses a ${status} report as ACTIVE`, async () => {
			const outcome = await deleteVmafJobLocally(vmafCtx(status), "vmaf-1", {
				req: REQ,
			});
			expect(outcome).toMatchObject({ ok: false, code: "ACTIVE" });
		});
	}

	/** The discriminating case — the only one the two predicates disagree on. */
	it("refuses an UNRECOGNISED status as ACTIVE, not RACED", async () => {
		const outcome = await deleteVmafJobLocally(vmafCtx("CANCELED"), "vmaf-1", {
			req: REQ,
		});
		expect(outcome).toMatchObject({ ok: false, code: "ACTIVE" });
		if (!outcome.ok) {
			// And the message names the status, so the operator can see what it was.
			expect(outcome.message).toContain("CANCELED");
		}
	});

	it("reports NOT_FOUND for a missing row", async () => {
		const ctx = {
			prisma: { vmafJob: { findUnique: vi.fn(async () => null) } },
		} as unknown as ServerContext;
		expect(await deleteVmafJobLocally(ctx, "nope", { req: REQ })).toMatchObject(
			{
				ok: false,
				code: "NOT_FOUND",
			},
		);
	});

	it("reports RACED when the atomic delete matches nothing", async () => {
		// The guard behind the guard: the row was terminal at read time and gone by
		// write time. This is what "RACED" is FOR, and the point of the test above is
		// that an unknown status must not be reported as this.
		const outcome = await deleteVmafJobLocally(
			vmafCtx("FINISHED", 0),
			"vmaf-1",
			{ req: REQ },
		);
		expect(outcome).toMatchObject({ ok: false, code: "RACED" });
	});
});

/**
 *  — the HANDLER's request must reach the audit row.
 *
 * `REQ` was threaded through twelve call sites in this file while nothing
 * asserted anything about it, so security-review-212 could replace
 * `options.req` in the production code with a synthetic Request and keep
 * 2,416 web tests green. The type forces the argument to exist; only a test
 * can force it to be the right one.
 */
describe("delete helpers forward the HANDLER's request (ledger #81)", () => {
	it("deleteEncodingJobLocally passes it to the audit writer", async () => {
		writeAuditLog.mockClear();
		const calls: Calls = [];
		await deleteEncodingJobLocally(ctxFor({ calls }), "job-1", { req: REQ });
		const forwarded = writeAuditLog.mock.calls.at(-1)?.[2] as
			| Request
			| undefined;
		expect(forwarded?.headers.get("x-bitovp-actor")).toBe(ACTOR);
	});

	it("deleteVmafJobLocally passes it too", async () => {
		writeAuditLog.mockClear();
		await deleteVmafJobLocally(vmafCtx("FINISHED"), "vmaf-1", { req: REQ });
		const forwarded = writeAuditLog.mock.calls.at(-1)?.[2] as
			| Request
			| undefined;
		expect(forwarded?.headers.get("x-bitovp-actor")).toBe(ACTOR);
	});
});
