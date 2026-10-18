import { describe, expect, it } from "vitest";
import {
	FEEDER_ACTIVE_STATUSES,
	FEEDER_PUBLISHER_CLAIM_HELD_WHERE,
	FEEDER_PUBLISHER_CLAIM_RELEASED_WHERE,
	type FeederOccupancyRef,
	feederOccupancyWhere,
	feederOccupiesChannel,
	feederPublisherClaimHeld,
	isFeederActiveStatus,
} from "./occupancy";

/**
 * the occupancy predicate and its `where`
 * fragment must mean exactly the same thing, for EVERY row shape. The
 * evaluator models the fragment's operators and throws on anything else, so a
 * fragment that grows a new operator has to teach it rather than pass a
 * permissive matcher.
 */
type TableRow = FeederOccupancyRef & { label: string; liveChannelId: string };

const AT = new Date("2026-08-30T00:00:00.000Z");
const CHANNEL = "00000000-0000-4000-8000-0000000000bb";

function nullCondition(value: unknown, condition: unknown): boolean {
	if (condition === null) {
		return value == null;
	}
	if (
		typeof condition === "object" &&
		condition !== null &&
		"not" in condition &&
		(condition as { not: unknown }).not === null
	) {
		return value != null;
	}
	throw new Error(`unsupported null condition: ${JSON.stringify(condition)}`);
}

function evaluateWhere(where: unknown, row: TableRow): boolean {
	if (where === null || typeof where !== "object") {
		throw new Error(`unsupported where: ${JSON.stringify(where)}`);
	}
	return Object.entries(where as Record<string, unknown>).every(
		([field, condition]) => {
			switch (field) {
				case "OR": {
					if (!Array.isArray(condition)) {
						throw new Error("OR must be an array");
					}
					return condition.some((clause) => evaluateWhere(clause, row));
				}
				case "liveChannelId":
					return row.liveChannelId === condition;
				case "status": {
					const list = (condition as { in?: unknown }).in;
					if (!Array.isArray(list)) {
						throw new Error("status must be an `in` list");
					}
					return list.includes(row.status);
				}
				case "pid":
				case "processGoneAt":
				case "publisherClaimedAt":
				case "publisherReleasedAt":
				case "commitAt":
					return nullCondition(row[field], condition);
				default:
					throw new Error(`unsupported field: ${field}`);
			}
		},
	);
}

/**
 * EXHAUSTIVE: every combination of the facts the predicate reads — claim held
 * / released / never, pid recorded / proven / released, status (each active
 * status and each terminal one), and the two-phase marker in its three
 * shapes (single-phase, staged hold, commit requested — the last two must
 * read the SAME, since neither has claimed yet). 3 × 3 × 5 × 3 = 135 rows, so
 * a shape nobody thought of is still pinned.
 */
const CLAIM_SHAPES = [
	{
		label: "never claimed",
		publisherClaimedAt: null,
		publisherReleasedAt: null,
	},
	{ label: "claim held", publisherClaimedAt: AT, publisherReleasedAt: null },
	{ label: "claim released", publisherClaimedAt: AT, publisherReleasedAt: AT },
] as const;
const PROCESS_SHAPES = [
	{ label: "pid recorded, unproven", pid: 4242, processGoneAt: null },
	{ label: "pid recorded, proven gone", pid: 4242, processGoneAt: AT },
	{ label: "pid released", pid: null, processGoneAt: null },
] as const;
const STATUSES = ["CREATED", "DOWNLOADING", "PUSHING", "STOPPED", "ERROR"];
const PHASE_SHAPES = [
	{ label: "single-phase", commitAt: null, commitRequestedAt: null },
	{ label: "staged hold", commitAt: AT, commitRequestedAt: null },
	{ label: "commit requested", commitAt: AT, commitRequestedAt: AT },
] as const;

type PhaseRow = TableRow & { commitRequestedAt: Date | null };
const TABLE: PhaseRow[] = [];
for (const claim of CLAIM_SHAPES) {
	for (const proc of PROCESS_SHAPES) {
		for (const status of STATUSES) {
			for (const phase of PHASE_SHAPES) {
				TABLE.push({
					label: `${claim.label} / ${proc.label} / ${status} / ${phase.label}`,
					liveChannelId: CHANNEL,
					publisherClaimedAt: claim.publisherClaimedAt,
					publisherReleasedAt: claim.publisherReleasedAt,
					pid: proc.pid,
					processGoneAt: proc.processGoneAt,
					status,
					commitAt: phase.commitAt,
					commitRequestedAt: phase.commitRequestedAt,
				});
			}
		}
	}
}

describe("feederOccupiesChannel — the named shapes the audit finding rests on", () => {
	const base: FeederOccupancyRef = {
		pid: null,
		processGoneAt: null,
		publisherClaimedAt: null,
		publisherReleasedAt: null,
		status: "STOPPED",
		commitAt: null,
	};

	it("ERROR + pid + no proof OCCUPIES — the cross-host refusal / dead-job shape (BLOCKER-2)", () => {
		expect(feederOccupiesChannel({ ...base, status: "ERROR", pid: 4242 })).toBe(
			true,
		);
	});

	it("STOPPED + pid + no proof OCCUPIES — the not-ours stop shape", () => {
		expect(
			feederOccupiesChannel({ ...base, status: "STOPPED", pid: 4242 }),
		).toBe(true);
	});

	it("a terminal row whose CLAIM is still held OCCUPIES even with no pid — the lost-stop window", () => {
		expect(feederOccupiesChannel({ ...base, publisherClaimedAt: AT })).toBe(
			true,
		);
	});

	it("a terminal row released on proof does NOT occupy", () => {
		expect(
			feederOccupiesChannel({
				...base,
				pid: 4242,
				processGoneAt: AT,
				publisherClaimedAt: AT,
				publisherReleasedAt: AT,
			}),
		).toBe(false);
	});

	it("the ordinary terminal shape (pid released, no claim) does NOT occupy", () => {
		expect(feederOccupiesChannel(base)).toBe(false);
	});

	it("a staged hold for a LATER switch does NOT occupy — holds coexist and serialise at commit", () => {
		expect(
			feederOccupiesChannel({ ...base, status: "DOWNLOADING", commitAt: AT }),
		).toBe(false);
	});

	it("a two-phase session that has NOT committed does not occupy by status — it competes at its commit CAS, which is the claim", () => {
		// Requested or not, an uncommitted switch holds no claim and no pid;
		// counting it by status would let two requested switches stop each
		// other (dead air) instead of letting the index pick exactly one.
		expect(
			feederOccupiesChannel({ ...base, status: "CREATED", commitAt: AT }),
		).toBe(false);
	});

	it("a two-phase session that COMMITTED occupies through its claim, and through its pid once pushing", () => {
		expect(
			feederOccupiesChannel({
				...base,
				status: "DOWNLOADING",
				commitAt: AT,
				publisherClaimedAt: AT,
			}),
		).toBe(true);
		expect(
			feederOccupiesChannel({
				...base,
				status: "PUSHING",
				commitAt: AT,
				pid: 4242,
			}),
		).toBe(true);
	});

	it("an active single-phase session OCCUPIES before it has a pid", () => {
		expect(feederOccupiesChannel({ ...base, status: "CREATED" })).toBe(true);
	});

	it("treats an ABSENT claim column as unproven, never as released", () => {
		expect(
			feederPublisherClaimHeld({
				publisherClaimedAt: AT,
				publisherReleasedAt: undefined as unknown as null,
			}),
		).toBe(true);
	});

	it("names the active statuses from one place", () => {
		expect([...FEEDER_ACTIVE_STATUSES]).toEqual([
			"CREATED",
			"DOWNLOADING",
			"PUSHING",
		]);
		expect(isFeederActiveStatus("PUSHING")).toBe(true);
		expect(isFeederActiveStatus("ERROR")).toBe(false);
	});
});

describe("the occupancy where-fragment IS the predicate, in Prisma's spelling", () => {
	it.each(
		TABLE,
	)("$label: the fragment selects exactly what the predicate calls occupied", (row) => {
		expect(evaluateWhere(feederOccupancyWhere(CHANNEL), row)).toBe(
			feederOccupiesChannel(row),
		);
	});

	it("a staged hold and a requested-but-uncommitted switch read the SAME on every other axis", () => {
		// The two-phase marker alone decides; the commit request is not read.
		for (const row of TABLE) {
			if (row.commitAt === null) {
				continue;
			}
			const twin = TABLE.find(
				(other) =>
					other !== row &&
					other.commitAt !== null &&
					other.commitRequestedAt !== row.commitRequestedAt &&
					other.status === row.status &&
					other.pid === row.pid &&
					other.processGoneAt === row.processGoneAt &&
					other.publisherClaimedAt === row.publisherClaimedAt &&
					other.publisherReleasedAt === row.publisherReleasedAt,
			);
			expect(twin).toBeDefined();
			expect(feederOccupiesChannel(row)).toBe(
				feederOccupiesChannel(twin as PhaseRow),
			);
		}
	});

	it("the channel filter is a plain equality on liveChannelId, absent when no channel is named", () => {
		const other = { ...(TABLE[0] as TableRow), liveChannelId: "other" };
		expect(evaluateWhere(feederOccupancyWhere(CHANNEL), other)).toBe(false);
		expect(feederOccupancyWhere()).not.toHaveProperty("liveChannelId");
		expect(evaluateWhere(feederOccupancyWhere(), other)).toBe(
			feederOccupiesChannel(other),
		);
	});

	it("the claim fragments partition every row (held XOR released)", () => {
		for (const row of TABLE) {
			expect(evaluateWhere(FEEDER_PUBLISHER_CLAIM_HELD_WHERE, row)).toBe(
				feederPublisherClaimHeld(row),
			);
			expect(evaluateWhere(FEEDER_PUBLISHER_CLAIM_RELEASED_WHERE, row)).toBe(
				!feederPublisherClaimHeld(row),
			);
		}
	});

	it("the evaluator REFUSES a shape it does not model (a grown fragment cannot pass silently)", () => {
		const row = TABLE[0] as TableRow;
		expect(() => evaluateWhere({ ownerId: "x" }, row)).toThrow(
			/unsupported field/,
		);
		expect(() => evaluateWhere({ pid: { gt: 1 } }, row)).toThrow(
			/unsupported null condition/,
		);
	});

	it("returns fresh objects — a caller spreading `id: { not }` beside it cannot poison the next call", () => {
		const a = feederOccupancyWhere(CHANNEL);
		const b = feederOccupancyWhere(CHANNEL);
		expect(a).toEqual(b);
		expect(a).not.toBe(b);
		expect(a.OR[0]).not.toBe(b.OR[0]);
	});
});
