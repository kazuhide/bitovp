import type { SubmitOutcome } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { projectSelected } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWatchSweep, type WatchListedObject } from "./sweep";

/**
 *  PR2 (design §8): the state machine over a STATEFUL store —
 * SEEN→STABLE→SUBMITTED, SKIPPED on extension, contentId re-arm, P2002
 * loser no-op, the backpressure cap, cursor honesty on bounded pages, and
 * per-rule error backoff. The store implements real compare-and-set
 * semantics (the named-slot lesson: mock counts manufacture findings).
 */

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const CRED_ID = "22222222-2222-4222-8222-222222222222";

type ObjectRow = {
	id: string;
	watchRuleId: string;
	objectKey: string;
	contentId: string;
	state: "SEEN" | "STABLE" | "SUBMITTED" | "SKIPPED" | "ERROR";
	size: bigint | null;
	mtimeMs: number | null;
	stableCount: number;
	encodingJobId: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
};

type RuleRow = {
	id: string;
	name: string;
	credentialId: string;
	bucket: string;
	prefix: string;
	extensions: string[];
	outputPrefixTemplate: string;
	labels: string[];
	enabled: boolean;
	pollIntervalSec: number;
	stabilityChecks: number;
	maxConcurrentJobs: number;
	scanCursor: string | null;
	errorStreak: number;
	lastSweepAt: Date | null;
	lastError: string | null;
	presetId: string;
	preset: { body: unknown; revision: number };
	credential: { provider: string };
};

// A minimal VALID plan body is heavy; instantiation is core-tested. The
// sweep tests stub submitPlan AND instantiation input by using a preset
// body that instantiates — the smallest golden fixture keeps this honest.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRESET_BODY = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-dash-hls-streamcondition-on-aws.plan.json",
		),
		"utf8",
	),
);
(PRESET_BODY as { bitmovin: Record<string, unknown> }).bitmovin = {
	...(PRESET_BODY as { bitmovin: Record<string, unknown> }).bitmovin,
	accountId: "33333333-3333-4333-8333-333333333333",
};

function makeRule(over: Partial<RuleRow> = {}): RuleRow {
	return {
		id: RULE_ID,
		name: "drop",
		credentialId: CRED_ID,
		bucket: "hot",
		prefix: "in/",
		extensions: ["mp4"],
		outputPrefixTemplate: "out/{basename}",
		labels: [],
		enabled: true,
		pollIntervalSec: 120,
		stabilityChecks: 2,
		maxConcurrentJobs: 3,
		scanCursor: null,
		errorStreak: 0,
		lastSweepAt: null,
		lastError: null,
		presetId: "22222222-3333-4444-8555-666666666666",
		// The HEALTHY default: the fixture's input is S3, so AWS_S3 is what a
		// real rule carries. Omitting it would leave every test here riding the
		// "provider could not be resolved" arm, where the credential half of the
		// template check is skipped by design .
		preset: { body: PRESET_BODY, revision: 4 },
		credential: { provider: "AWS_S3" },
		...over,
	};
}

function makeStore(rules: RuleRow[], objects: ObjectRow[] = []) {
	let nextId = 0;
	const jobStatuses = new Map<string, string>();
	const store = {
		rules,
		objects,
		jobStatuses,
		prisma: {
			watchRule: {
				findMany: vi.fn(async () => rules.map((rule) => ({ ...rule }))),
				update: vi.fn(
					async (args: {
						where: { id: string };
						data: Record<string, unknown>;
					}) => {
						const rule = rules.find((row) => row.id === args.where.id);
						if (rule) {
							const { errorStreak, ...rest } = args.data as {
								errorStreak?: { increment: number } | number;
							} & Record<string, unknown>;
							Object.assign(rule, rest);
							if (typeof errorStreak === "number") {
								rule.errorStreak = errorStreak;
							} else if (errorStreak) {
								rule.errorStreak += errorStreak.increment;
							}
						}
						return rule;
					},
				),
			},
			watchedObject: {
				/**
				 * HONOURS `select`. Without it, dropping `stableCount` from the
				 * sweep's SELECT left all 14 tests green while production
				 * computed `existing.stableCount + 1` as `undefined + 1 = NaN`
				 * and persisted it — a watch rule that never stabilises and
				 * never fires (review-213 measured it).
				 */
				findUnique: vi.fn(
					async (args: {
						where: {
							watchRuleId_objectKey_contentId: {
								watchRuleId: string;
								objectKey: string;
								contentId: string;
							};
						};
						select?: Record<string, boolean>;
					}) => {
						const key = args.where.watchRuleId_objectKey_contentId;
						const hit = store.objects.find(
							(row) =>
								row.watchRuleId === key.watchRuleId &&
								row.objectKey === key.objectKey &&
								row.contentId === key.contentId,
						);
						return hit ? projectSelected({ ...hit }, args.select) : null;
					},
				),
				create: vi.fn(async (args: { data: Partial<ObjectRow> }) => {
					const exists = store.objects.some(
						(row) =>
							row.watchRuleId === args.data.watchRuleId &&
							row.objectKey === args.data.objectKey &&
							row.contentId === args.data.contentId,
					);
					if (exists) {
						const err = new Error("unique") as Error & { code: string };
						err.code = "P2002";
						throw err;
					}
					nextId += 1;
					const data = args.data as Partial<ObjectRow>;
					const row: ObjectRow = {
						...(data as ObjectRow),
						id: `obj-${nextId}`,
						encodingJobId: data.encodingJobId ?? null,
						error: data.error ?? null,
						size: data.size ?? null,
						mtimeMs: data.mtimeMs ?? null,
						stableCount: data.stableCount ?? 0,
						state: data.state ?? "SEEN",
						createdAt: new Date(nextId),
						updatedAt: data.updatedAt ?? new Date(nextId),
					};
					store.objects.push(row);
					return { ...row };
				}),
				updateMany: vi.fn(
					async (args: {
						where: {
							id: string;
							state?: string;
							encodingJobId?: string | null;
						};
						data: Partial<ObjectRow>;
					}) => {
						let count = 0;
						for (const row of store.objects) {
							if (row.id !== args.where.id) {
								continue;
							}
							if (args.where.state && row.state !== args.where.state) {
								continue;
							}
							// Reaper CAS: `encodingJobId: null` matches ONLY
							// unlinked rows (Prisma null-equality semantics).
							if (
								"encodingJobId" in args.where &&
								row.encodingJobId !== args.where.encodingJobId
							) {
								continue;
							}
							Object.assign(row, args.data, { updatedAt: new Date() });
							count += 1;
						}
						return { count };
					},
				),
				findFirst: vi.fn(
					async (args: {
						where: {
							watchRuleId: string;
							objectKey: string;
							state: string;
							OR: (
								| { encodingJobId: null }
								| { encodingJob: { is: { status: { in: string[] } } } }
							)[];
						};
					}) => {
						const hit = store.objects.find((row) => {
							if (
								row.watchRuleId !== args.where.watchRuleId ||
								row.objectKey !== args.where.objectKey ||
								row.state !== args.where.state
							) {
								return false;
							}
							return args.where.OR.some((branch) =>
								"encodingJobId" in branch
									? row.encodingJobId === null
									: row.encodingJobId !== null &&
										branch.encodingJob.is.status.in.includes(
											jobStatuses.get(row.encodingJobId) ?? "",
										),
							);
						});
						return hit ? { id: hit.id } : null;
					},
				),
				findMany: vi.fn(
					async (args: {
						where: {
							watchRuleId?: string;
							state: string;
							encodingJobId?: string | null;
							updatedAt?: { lt: Date };
						};
						take?: number;
					}) =>
						store.objects
							.filter(
								(row) =>
									(args.where.watchRuleId === undefined ||
										row.watchRuleId === args.where.watchRuleId) &&
									row.state === args.where.state &&
									(!("encodingJobId" in args.where) ||
										row.encodingJobId === args.where.encodingJobId) &&
									(args.where.updatedAt === undefined ||
										row.updatedAt.getTime() <
											args.where.updatedAt.lt.getTime()),
							)
							.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
							.slice(0, args.take ?? 100)
							.map((row) => ({ ...row })),
				),
				count: vi.fn(
					async (args: { where: { watchRuleId: string; state: string } }) =>
						store.objects.filter(
							(row) =>
								row.watchRuleId === args.where.watchRuleId &&
								row.state === args.where.state &&
								row.encodingJobId !== null &&
								["QUEUED", "RUNNING"].includes(
									jobStatuses.get(row.encodingJobId) ?? "",
								),
						).length,
				),
			},
		},
	};
	return store;
}

function makeSweep(
	store: ReturnType<typeof makeStore>,
	over: {
		pages?: { objects: WatchListedObject[]; nextCursor?: string }[];
		submit?: (plan: unknown) => Promise<SubmitOutcome>;
		now?: Date;
	} = {},
) {
	const pages = over.pages ?? [{ objects: [] }];
	let call = 0;
	const listPage = vi.fn(async () => {
		const page = pages[Math.min(call, pages.length - 1)];
		call += 1;
		return page as { objects: WatchListedObject[]; nextCursor?: string };
	});
	const submitPlan = vi.fn(
		over.submit ??
			(async (): Promise<SubmitOutcome> => {
				const id = `44444444-4444-4444-8444-44444444444${call}`;
				store.jobStatuses.set(id, "QUEUED");
				return { ok: true, id, plan: {} as never, issues: [] };
			}),
	);
	const emitEvent = vi.fn(async () => {});
	const sweep = createWatchSweep({
		prisma: store.prisma as unknown as AppPrismaClient,
		listPage,
		submitPlan,
		emitEvent,
		now: () => over.now ?? new Date("2026-08-13T12:00:00Z"),
		uuid: () => "u-fixed",
	});
	return { sweep, listPage, submitPlan, emitEvent };
}

const MP4 = (key: string, size = 100): WatchListedObject => ({
	key,
	size,
	lastModified: "2026-08-13T11:00:00.000Z",
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("state machine", () => {
	it("first sighting creates SEEN; reaching stabilityChecks flips STABLE; then submits", async () => {
		const store = makeStore([makeRule()]);
		const { sweep, submitPlan, emitEvent } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4")] }],
		});
		// Sweep 1: SEEN (stableCount 1 of 2) — nothing submits.
		await sweep();
		expect(store.objects[0]).toMatchObject({ state: "SEEN", stableCount: 1 });
		expect(submitPlan).not.toHaveBeenCalled();
		// Make the rule due again (the store's update set lastSweepAt).
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		// Sweep 2: same contentId → STABLE → claimed → submitted.
		await sweep();
		expect(store.objects[0]).toMatchObject({
			state: "SUBMITTED",
			stableCount: 2,
		});
		expect(store.objects[0]?.encodingJobId).toBeTruthy();
		expect(submitPlan).toHaveBeenCalledTimes(1);
		// : a watch rule is template+trigger — the submission
		// carries the rule's preset as provenance, revision as loaded.
		expect(submitPlan).toHaveBeenCalledWith(expect.anything(), {
			presetId: "22222222-3333-4444-8555-666666666666",
			presetRevision: 4,
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "WATCH_SUBMITTED",
				objectPath: "in/a.mp4",
			}),
		);
	});

	it("extension filter writes SKIPPED rows that never advance", async () => {
		const store = makeStore([makeRule()]);
		const { sweep, submitPlan } = makeSweep(store, {
			pages: [{ objects: [MP4("in/readme.txt")] }],
		});
		await sweep();
		expect(store.objects[0]).toMatchObject({ state: "SKIPPED" });
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep();
		expect(store.objects[0]).toMatchObject({
			state: "SKIPPED",
			stableCount: 1,
		});
		expect(submitPlan).not.toHaveBeenCalled();
	});

	it("a CHANGED contentId re-arms via a NEW row (re-upload re-encodes)", async () => {
		const store = makeStore([makeRule({ stabilityChecks: 1 })]);
		const { sweep } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4", 100)] }],
		});
		await sweep();
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep(); // submits the first version
		expect(
			store.objects.filter((o) => o.objectKey === "in/a.mp4"),
		).toHaveLength(1);
		// Re-upload: same key, DIFFERENT size ⇒ different contentId ⇒ new row.
		const { sweep: sweep2 } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4", 999)] }],
		});
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep2();
		const rows = store.objects.filter((o) => o.objectKey === "in/a.mp4");
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.contentId)).not.toContain(
			rows[0]?.contentId === rows[1]?.contentId,
		);
	});

	it("the P2002 racing-insert loser is a NO-OP, not a crash", async () => {
		const store = makeStore([makeRule()]);
		// Pre-insert the exact row the sweep will try to create.
		store.objects.push({
			id: "pre",
			watchRuleId: RULE_ID,
			objectKey: "in/a.mp4",
			contentId: `100:${Date.parse("2026-08-13T11:00:00.000Z")}`,
			state: "SEEN",
			size: BigInt(100),
			mtimeMs: null,
			stableCount: 1,
			encodingJobId: null,
			error: null,
			createdAt: new Date(1),
			updatedAt: new Date(1),
		});
		// Make findUnique MISS so the sweep takes the create path — the DB
		// race the unique key exists for.
		store.prisma.watchedObject.findUnique.mockResolvedValueOnce(null);
		const { sweep } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4")] }],
		});
		await expect(sweep()).resolves.toMatchObject({ errors: 0 });
	});
});

describe("backpressure + pagination + backoff", () => {
	it("submits at most maxConcurrentJobs minus in-flight", async () => {
		const store = makeStore([
			makeRule({ stabilityChecks: 1, maxConcurrentJobs: 2 }),
		]);
		const { sweep, submitPlan } = makeSweep(store, {
			pages: [
				{
					objects: [MP4("in/a.mp4"), MP4("in/b.mp4"), MP4("in/c.mp4")],
				},
			],
		});
		await sweep();
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep();
		// Cap 2: two submitted, one still STABLE.
		expect(submitPlan).toHaveBeenCalledTimes(2);
		expect(store.objects.filter((o) => o.state === "SUBMITTED")).toHaveLength(
			2,
		);
		expect(store.objects.filter((o) => o.state === "STABLE")).toHaveLength(1);
	});

	it("bounded pages persist the cursor (partial sweep SAYS so and resumes)", async () => {
		const page = { objects: [MP4("in/a.mp4")], nextCursor: "more" };
		const store = makeStore([makeRule()]);
		const { sweep, listPage } = makeSweep(store, {
			pages: [page, page, page, page, page, page, page],
		});
		await sweep();
		// 5-page bound hit with more to go: the cursor lands on the rule.
		expect(listPage).toHaveBeenCalledTimes(5);
		expect(store.rules[0]?.scanCursor).toBe("more");
	});

	it("a failing rule backs off exponentially and NEVER hits other rules", async () => {
		const failing = makeRule({ id: RULE_ID, name: "bad" });
		const healthy = makeRule({
			id: "55555555-5555-4555-8555-555555555555",
			name: "good",
		});
		const store = makeStore([failing, healthy]);
		const { sweep, listPage } = makeSweep(store);
		// Make the FIRST rule's listing throw, second succeed.
		listPage
			.mockRejectedValueOnce(new Error("credential dead"))
			.mockResolvedValueOnce({ objects: [] });
		const stats = await sweep();
		expect(stats.errors).toBe(1);
		expect(store.rules[0]).toMatchObject({
			errorStreak: 1,
			lastError: "credential dead",
		});
		expect(store.rules[1]).toMatchObject({ errorStreak: 0, lastError: null });
		// Streak 1 ⇒ wait 2× interval: at +150s the rule is NOT due…
		const { sweep: sweepLater, listPage: later } = makeSweep(store, {
			now: new Date((store.rules[0]?.lastSweepAt?.getTime() ?? 0) + 150_000),
		});
		await sweepLater();
		// …only the healthy rule listed (its 120s interval HAS elapsed).
		expect(later).toHaveBeenCalledTimes(1);
	});

	it("a mismatched credential provider ERRORs BEFORE any submit", async () => {
		/**
		 * The wiring, not the rule (review-299 F2, in the code that cites it).
		 *
		 * The sweep passes the rule's credential provider into
		 * `instantiateWatchPlan` so the backstop can do the credential half of
		 * the template check. Deleting that pass-through left the entire worker
		 * suite green — 76 files, 1255 tests — because the healthy default I
		 * added to `makeRule` moved every test onto the populated path without
		 * anything asserting the refusal. That HID the gap rather than closing
		 * it .
		 *
		 * What the regression costs is billable: with the wiring gone
		 * `submitPlan` IS called, so the object is submitted and charged and
		 * then fails at the vendor, instead of landing ERROR before any spend.
		 */
		const store = makeStore([
			makeRule({ stabilityChecks: 1, credential: { provider: "AZURE_BLOB" } }),
		]);
		const { sweep, submitPlan, emitEvent } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4")] }],
		});
		await sweep();
		const rule0 = store.rules[0];
		if (rule0) {
			rule0.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep();
		expect(submitPlan).not.toHaveBeenCalled();
		expect(store.objects[0]).toMatchObject({ state: "ERROR" });
		expect(store.objects[0]?.error ?? "").toContain("AZURE_BLOB");
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "WATCH_ERROR" }),
		);
	});

	it("a submit refusal lands ERROR on the row + WATCH_ERROR, and the sweep continues", async () => {
		const store = makeStore([makeRule({ stabilityChecks: 1 })]);
		const { sweep, emitEvent } = makeSweep(store, {
			pages: [{ objects: [MP4("in/a.mp4")] }],
			submit: async () => ({
				ok: false,
				code: "ACCOUNT_MISSING",
				message: "Bitmovin account does not exist",
			}),
		});
		await sweep();
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		const stats = await sweep();
		expect(stats.errors).toBe(1);
		expect(store.objects[0]).toMatchObject({
			state: "ERROR",
			error: "Bitmovin account does not exist",
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "WATCH_ERROR" }),
		);
		// The rule itself stays healthy — a per-object failure is not a
		// credential failure.
		expect(store.rules[0]?.errorStreak).toBe(0);
	});

	it("a refusal carrying ISSUES spells them into the row AND the event, redacted and bounded", async () => {
		// review-210 C2/I1/I5/I6: the sweep used to persist only the headline,
		// so the one submitter with no UI got "Plan validation failed" and
		// nothing else; then the fix printed everything twice; then an
		// unbounded id could make the notification oversized.
		const issues = Array.from({ length: 9 }, (_, n) => ({
			code: "PLAN_DELIVERY_DEVIATION",
			level: "error" as const,
			message: `deviation ${n} at https://user:secret@example.com/x`,
			path: `renditions.${n}.bitrate`,
		}));
		const store = makeStore([makeRule({ stabilityChecks: 1 })]);
		const { sweep, emitEvent } = makeSweep(store, {
			pages: [{ objects: [MP4("in/b.mp4")] }],
			submit: async () => ({
				ok: false,
				code: "DELIVERY_DEVIATION",
				message: "Plan does not meet Spec (9 deviations)",
				issues,
			}),
		});
		await sweep();
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep();
		const row = store.objects[0];
		expect(row?.state).toBe("ERROR");
		expect(row?.error).toContain("deviation 0");
		// Bounded: five shown, the rest counted.
		expect(row?.error).toContain("…and 4 more");
		expect(row?.error).not.toContain("deviation 8");
		// Redacted on BOTH sinks — the event schema promises it.
		expect(row?.error).not.toContain("secret@");
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "WATCH_ERROR", error: row?.error }),
		);
	});
});
/** A STABLE row ready for the money gate, seeded directly. */
function stableRow(over: Partial<ObjectRow> = {}): ObjectRow {
	return {
		id: `seed-${Math.abs(over.createdAt?.getTime() ?? 0)}-${over.objectKey ?? "a"}`,
		watchRuleId: RULE_ID,
		objectKey: "in/a.mp4",
		contentId: "100:1723546800000",
		state: "STABLE",
		size: BigInt(100),
		mtimeMs: null,
		stableCount: 2,
		encodingJobId: null,
		error: null,
		createdAt: new Date(1),
		updatedAt: new Date("2026-08-13T11:59:00Z"),
		...over,
	};
}

describe("the money gate (review-87b folds)", () => {
	it("TWO interleaved workers claim the same row; exactly ONE submits (I-1 — the CAS double-bill guard)", async () => {
		// The reviewer's forced interleave, over the existing harness: hold
		// EVERY claim until both workers have issued theirs, so neither can
		// observe the other's write before deciding. Only the CAS state
		// predicate separates one paid encoding from two.
		const store = makeStore([makeRule()], [stableRow()]);
		const a = makeSweep(store);
		const b = makeSweep(store);
		const updateMany = store.prisma.watchedObject.updateMany;
		const original = updateMany.getMockImplementation();
		if (!original) {
			throw new Error("store.updateMany has no implementation");
		}
		let claimsIssued = 0;
		let release: (() => void) | undefined;
		const bothIssued = new Promise<void>((resolve) => {
			release = resolve;
		});
		updateMany.mockImplementation(async (args) => {
			if ((args.data as { state?: string }).state === "SUBMITTED") {
				claimsIssued += 1;
				if (claimsIssued === 2) {
					release?.();
				}
				await bothIssued;
			}
			return original(args);
		});
		await Promise.all([a.sweep(), b.sweep()]);
		expect(claimsIssued).toBe(2);
		const submits =
			a.submitPlan.mock.calls.length + b.submitPlan.mock.calls.length;
		expect(submits).toBe(1);
		expect(
			store.objects.filter((row) => row.state === "SUBMITTED"),
		).toHaveLength(1);
	});

	it("a lost claim (SUBMITTED ∧ no job) is reaped to ERROR after the window — visible, not auto-retried (I-2)", async () => {
		const store = makeStore(
			[makeRule()],
			[
				// Stale lost claim — reaped.
				stableRow({
					id: "lost",
					state: "SUBMITTED",
					updatedAt: new Date("2026-08-13T11:00:00Z"),
				}),
				// Fresh claim inside the window — untouched (a live worker is
				// between claim and submit RIGHT NOW).
				stableRow({
					id: "fresh",
					objectKey: "in/b.mp4",
					state: "SUBMITTED",
					updatedAt: new Date("2026-08-13T11:59:30Z"),
				}),
				// Linked row — not a lost claim at all.
				stableRow({
					id: "linked",
					objectKey: "in/c.mp4",
					state: "SUBMITTED",
					encodingJobId: "job-1",
					updatedAt: new Date("2026-08-13T10:00:00Z"),
				}),
			],
		);
		const { sweep, emitEvent } = makeSweep(store);
		const stats = await sweep();
		const byId = new Map(store.objects.map((row) => [row.id, row]));
		expect(byId.get("lost")?.state).toBe("ERROR");
		expect(byId.get("lost")?.error).toContain("never submitted");
		expect(byId.get("fresh")?.state).toBe("SUBMITTED");
		expect(byId.get("linked")?.state).toBe("SUBMITTED");
		expect(stats.errors).toBe(1);
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "WATCH_ERROR",
				error: expect.stringContaining("lost claim"),
			}),
		);
	});

	it("two STABLE rows for ONE key submit serially, not together (C-1 backstop at the gate)", async () => {
		const store = makeStore(
			[makeRule()],
			[
				stableRow({ id: "first", createdAt: new Date(1) }),
				stableRow({
					id: "second",
					contentId: "100:1723546800000#rearm-1",
					createdAt: new Date(2),
				}),
			],
		);
		const { sweep, submitPlan } = makeSweep(store);
		await sweep();
		expect(submitPlan).toHaveBeenCalledTimes(1);
		const byId = new Map(store.objects.map((row) => [row.id, row]));
		expect(byId.get("first")?.state).toBe("SUBMITTED");
		// The second row WAITS as STABLE — it submits after the in-flight
		// encoding lands, serialized per key, never beside it.
		expect(byId.get("second")?.state).toBe("STABLE");
	});

	it("a STABLE row waits while the SAME key has an active submission, and proceeds once it lands", async () => {
		const store = makeStore(
			[makeRule()],
			[
				stableRow({
					id: "active",
					state: "SUBMITTED",
					encodingJobId: "job-run",
					updatedAt: new Date("2026-08-13T11:59:00Z"),
				}),
				stableRow({
					id: "waiting",
					contentId: "999:1723546800000",
					createdAt: new Date(2),
				}),
			],
		);
		store.jobStatuses.set("job-run", "RUNNING");
		const { sweep, submitPlan } = makeSweep(store);
		await sweep();
		expect(submitPlan).not.toHaveBeenCalled();
		// The encoding finishes; the next sweep clears the key.
		store.jobStatuses.set("job-run", "FINISHED");
		const rule = store.rules[0];
		if (rule) {
			rule.lastSweepAt = new Date("2026-08-13T11:00:00Z");
		}
		await sweep();
		expect(submitPlan).toHaveBeenCalledTimes(1);
	});

	it("error text is redacted before it reaches UI-visible columns (N-3)", async () => {
		const store = makeStore([makeRule()], [stableRow()]);
		const { sweep } = makeSweep(store, {
			submit: async () => {
				throw new Error("list failed: https://ak:VERYSECRET@endpoint/bucket");
			},
		});
		await sweep();
		expect(store.objects[0]?.state).toBe("ERROR");
		expect(store.objects[0]?.error).not.toContain("VERYSECRET");
		expect(store.objects[0]?.error).toContain("[REDACTED]");
	});
});
