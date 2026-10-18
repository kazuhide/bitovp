import { describe, expect, it, vi } from "vitest";
import { writeAuditLog } from "./audit";
import type { AppPrismaClient } from "./client";

/**
 *  PR2 (review-189 I1 / review-189b I1): the actor column's
 * PERSISTENCE hop was pinned by nothing — both reviewers' mutation
 * (dropping the actor spread so it never reaches prisma.auditLog.create)
 * left the FULL suite green, because every route test mocks
 * @/lib/server/audit and pins only the entry object. This file pins the
 * hop itself.
 */

function fakePrisma() {
	const create = vi.fn(
		async (_args: { data: Record<string, unknown> }) => ({}),
	);
	return {
		prisma: { auditLog: { create } } as unknown as AppPrismaClient,
		create,
	};
}

describe("writeAuditLog — actor persistence (the headline of #81 PR2)", () => {
	it("a provided actor reaches prisma.auditLog.create verbatim", async () => {
		const { prisma, create } = fakePrisma();
		await writeAuditLog(prisma, {
			method: "POST",
			path: "/api/api-tokens",
			actor: "token:tok-1",
		});
		expect(create).toHaveBeenCalledTimes(1);
		const data = create.mock.calls[0]?.[0]?.data as { actor?: string };
		expect(data.actor).toBe("token:tok-1");
	});

	it("a NULL actor omits the key entirely (callers with no identity)", async () => {
		const { prisma, create } = fakePrisma();
		// `null`, not omitted: the field is required-but-nullable so that a
		// caller with no identity says so, rather than a 5th consumer of this
		// exported writer defaulting to NULL and compiling clean (#81).
		await writeAuditLog(prisma, {
			method: "POLICY",
			path: "worker:x",
			actor: null,
		});
		const data = (
			create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
		).data;
		expect("actor" in data).toBe(false);
	});

	it("never throws — an audit failure must not break the call it documents", async () => {
		const create = vi.fn(async () => {
			throw new Error("db down");
		});
		const prisma = { auditLog: { create } } as unknown as AppPrismaClient;
		await expect(
			writeAuditLog(prisma, { method: "GET", path: "/x", actor: "session" }),
		).resolves.toBeUndefined();
	});
});
