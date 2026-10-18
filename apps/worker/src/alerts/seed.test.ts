import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedDefaultAlertRules } from "./seed";

/**
 *  PR3 (design §8: seed idempotency). The guard is the MARKER,
 * not table emptiness — deleting every rule is an operator preference the
 * seeder must not undo.
 */

function makeStore(
	over: {
		marker?: boolean;
		/** The PROVIDER_WARNING step's own marker (2026-09-02). */
		providerWarningMarker?: boolean;
		ruleCount?: number;
		providerWarningRuleCount?: number;
	} = {},
) {
	const created: unknown[] = [];
	const markers: { path?: string; [key: string]: unknown }[] = [];
	const prisma = {
		auditLog: {
			findFirst: vi.fn(async (args: { where: { path: string } }) => {
				const present =
					args.where.path === "worker:alert-default-seed"
						? over.marker
						: args.where.path === "worker:alert-default-seed:provider-warning"
							? over.providerWarningMarker
							: false;
				return present ? { id: "m-1" } : null;
			}),
			create: vi.fn(async (args: { data: { path?: string } }) => {
				markers.push(args.data);
				return { id: "m-new" };
			}),
		},
		alertRule: {
			count: vi.fn(async (args?: { where?: { metric?: string } }) =>
				args?.where?.metric === "PROVIDER_WARNING"
					? (over.providerWarningRuleCount ?? 0)
					: (over.ruleCount ?? 0),
			),
			createMany: vi.fn(async (args: { data: unknown[] }) => {
				created.push(...args.data);
				return { count: args.data.length };
			}),
		},
	};
	return { prisma: prisma as unknown as AppPrismaClient, created, markers };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("seedDefaultAlertRules", () => {
	it("seeds the three no-judgment CRIT rules + the PROVIDER_WARNING WARN rule on a fresh install, one marker each", async () => {
		const store = makeStore();
		const result = await seedDefaultAlertRules({ prisma: store.prisma });
		expect(result).toEqual({ seeded: 4 });
		expect(store.created).toEqual([
			{ metric: "INPUT_DISCONNECTED", severity: "CRIT", windowPolls: 2 },
			// : windowPolls 1 — at air time the operator wants to
			// know NOW; the evaluator's program-window gate prevents pre-air
			// noise, so one unhealthy poll inside the window is the signal.
			{ metric: "PROGRAM_START_NO_INGEST", severity: "CRIT", windowPolls: 1 },
			{ metric: "HEARTBEAT_STALE", severity: "CRIT", windowPolls: 2 },
			// The encoder's own WARNING/ERROR entries; windowPolls 2 = the
			// minute of silence that resolves it.
			{ metric: "PROVIDER_WARNING", severity: "WARN", windowPolls: 2 },
		]);
		expect(store.markers.map((marker) => marker.path)).toEqual([
			"worker:alert-default-seed",
			"worker:alert-default-seed:provider-warning",
		]);
	});

	it("both markers make re-runs no-ops — an operator who deleted the defaults keeps their empty table", async () => {
		const store = makeStore({
			marker: true,
			providerWarningMarker: true,
			ruleCount: 0,
		});
		const result = await seedDefaultAlertRules({ prisma: store.prisma });
		expect(result).toEqual({ seeded: 0 });
		expect(store.created).toHaveLength(0);
		expect(store.markers).toHaveLength(0);
	});

	it("pre-seeding installs with their own rules are grandfathered: mark, seed nothing (the first step)", async () => {
		const store = makeStore({ ruleCount: 3, providerWarningMarker: true });
		const result = await seedDefaultAlertRules({ prisma: store.prisma });
		expect(result).toEqual({ seeded: 0 });
		expect(store.created).toHaveLength(0);
		expect(store.markers).toHaveLength(1);
		expect(store.markers[0]).toMatchObject({
			request: expect.objectContaining({ grandfathered: true }),
		});
	});

	it("an ALREADY-SEEDED install gets the PROVIDER_WARNING default exactly once (its own marker)", async () => {
		const store = makeStore({ marker: true, ruleCount: 3 });
		const result = await seedDefaultAlertRules({ prisma: store.prisma });
		expect(result).toEqual({ seeded: 1 });
		expect(store.created).toEqual([
			{ metric: "PROVIDER_WARNING", severity: "WARN", windowPolls: 2 },
		]);
		expect(store.markers.map((marker) => marker.path)).toEqual([
			"worker:alert-default-seed:provider-warning",
		]);
	});

	it("an install that already has a PROVIDER_WARNING rule is grandfathered: mark, seed nothing", async () => {
		const store = makeStore({
			marker: true,
			ruleCount: 4,
			providerWarningRuleCount: 1,
		});
		const result = await seedDefaultAlertRules({ prisma: store.prisma });
		expect(result).toEqual({ seeded: 0 });
		expect(store.created).toHaveLength(0);
		expect(store.markers).toHaveLength(1);
		expect(store.markers[0]).toMatchObject({
			path: "worker:alert-default-seed:provider-warning",
			request: expect.objectContaining({ grandfathered: true }),
		});
	});
});

/**
 *  / security-review-212: this writer called `auditLog.create`
 * directly, which made it the one door into the table that skipped
 * `redactSecrets` AND wrote a NULL actor — indistinguishable from the
 * attribution defect that row was about. It now goes through the shared
 * writer and names itself.
 */
describe("alert seed — the marker row is attributed (ledger #81)", () => {
	it("names the seeder rather than persisting a NULL actor", async () => {
		const store = makeStore();
		await seedDefaultAlertRules({ prisma: store.prisma });
		const marker = store.markers.at(-1) as { actor?: string; path?: string };
		expect(marker?.actor).toBe("worker:alert-seed");
	});
});
