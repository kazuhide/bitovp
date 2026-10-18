import { describe, expect, it, vi } from "vitest";
import {
	createStrandedInspectionReconciler,
	STRANDED_INSPECTION_ERROR,
} from "./reconcile-stranded";

/**
 *  — #133's stranding in the inspection pipeline, with LESS
 * escape hatch (no DELETE route at all) and less visibility (the reset
 * does not block on it, so nobody had stepped on one).
 */
function harness(
	rows: { id: string }[],
	states: Record<string, string | null>,
	options: { updateCount?: number } = {},
) {
	const updates: { where: unknown; data: unknown }[] = [];
	const prisma = {
		storageInspection: {
			findMany: vi.fn(async () => rows),
			updateMany: vi.fn(async (args: { where: unknown; data: unknown }) => {
				updates.push(args);
				return { count: options.updateCount ?? 1 };
			}),
		},
	} as unknown as Parameters<
		typeof createStrandedInspectionReconciler
	>[0]["prisma"];
	const queue = {
		name: "storage-inspect",
		getJob: vi.fn(async (id: string) => {
			const state = states[id];
			return state === undefined ? undefined : { getState: async () => state };
		}),
	} as unknown as Parameters<
		typeof createStrandedInspectionReconciler
	>[0]["queue"];
	return { prisma, queue, updates };
}

describe("retiring a storage inspection whose worker went away", () => {
	it("retires a RUNNING row the queue no longer holds", async () => {
		const { prisma, queue, updates } = harness([{ id: "i1" }], {});
		const retired = await createStrandedInspectionReconciler({
			prisma,
			queue,
		})();
		expect(retired).toBe(1);
		expect(updates[0]?.where).toEqual({ id: "i1", status: "RUNNING" });
		expect(updates[0]?.data).toEqual({
			status: "ERROR",
			error: STRANDED_INSPECTION_ERROR,
		});
	});

	it("leaves a row alone while a worker genuinely owns it", async () => {
		for (const state of ["active", "waiting", "delayed", "prioritized"]) {
			const { prisma, queue, updates } = harness([{ id: "i1" }], {
				i1: state,
			});
			const retired = await createStrandedInspectionReconciler({
				prisma,
				queue,
			})();
			expect(retired, `state ${state} must be treated as live`).toBe(0);
			expect(updates).toHaveLength(0);
		}
	});

	it("an UNRECOGNISED state is live, not dead (the fail-safe polarity)", async () => {
		// review-3 I4's doctrine, restated per-pipeline on purpose: a state
		// added by a BullMQ upgrade must cost an operator a restart, never a
		// running ffprobe.
		const { prisma, queue, updates } = harness([{ id: "i1" }], {
			i1: "waiting-children",
		});
		const retired = await createStrandedInspectionReconciler({
			prisma,
			queue,
		})();
		expect(retired).toBe(0);
		expect(updates).toHaveLength(0);
	});

	it("counts what the WRITE matched, not what the read found", async () => {
		// A peer that finishes between the read and the write keeps its result
		// — the conditional update matches zero rows and the tally says so.
		const { prisma, queue } = harness([{ id: "i1" }], {}, { updateCount: 0 });
		const retired = await createStrandedInspectionReconciler({
			prisma,
			queue,
		})();
		expect(retired).toBe(0);
	});

	it("refuses construction on the wrong queue", () => {
		const { prisma } = harness([], {});
		expect(() =>
			createStrandedInspectionReconciler({
				prisma,
				queue: { name: "vmaf-runner", getJob: vi.fn() } as never,
			}),
		).toThrow(/storage-inspect/);
	});
});
