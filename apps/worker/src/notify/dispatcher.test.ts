import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInboundDispatcher } from "./dispatcher";

/**
 *  PR3 / #16: the dispatcher's contracts — atomic claims (two
 * workers, ONE publish), unverified rows outside the population by
 * construction, unmapped rows processed-but-undispatched, and a publish
 * failure neither unclaims nor aborts.
 */

const ENC = "bm-enc-123";

function row(over: Record<string, unknown> = {}) {
	return {
		id: "row-1",
		raw: { type: "ENCODING_FINISHED", encoding: { id: ENC } },
		signatureValid: true,
		processedAt: null,
		receivedAt: new Date("2026-08-13T00:00:00.000Z"),
		...over,
	};
}

function makeDeps(rows: unknown[], claimCount = 1) {
	const findMany = vi.fn().mockResolvedValue(rows);
	const updateMany = vi.fn().mockResolvedValue({ count: claimCount });
	const publish = vi.fn().mockResolvedValue(undefined);
	const prisma = {
		webhookEvent: { findMany, updateMany },
	} as unknown as AppPrismaClient;
	return { prisma, findMany, updateMany, publish };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createInboundDispatcher", () => {
	it("claims atomically then publishes the encoding id", async () => {
		const { prisma, findMany, updateMany, publish } = makeDeps([row()]);
		const stats = await createInboundDispatcher({
			prisma,
			publish,
			now: () => new Date("2026-08-13T00:00:01.000Z"),
		})();
		expect(stats).toEqual({ claimed: 1, published: 1, unmapped: 0 });
		// The population is THE finder's: verified, unprocessed only.
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { signatureValid: true, processedAt: null },
			}),
		);
		// The claim carries processedAt: null in the WHERE — that IS the atomicity.
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "row-1", processedAt: null },
			data: { processedAt: new Date("2026-08-13T00:00:01.000Z") },
		});
		expect(publish).toHaveBeenCalledWith(ENC);
	});

	it("a row already claimed by ANOTHER worker publishes nothing (count 0)", async () => {
		const { prisma, publish } = makeDeps([row()], 0);
		const stats = await createInboundDispatcher({
			prisma,
			publish,
			now: () => new Date(),
		})();
		expect(stats).toEqual({ claimed: 0, published: 0, unmapped: 0 });
		expect(publish).not.toHaveBeenCalled();
	});

	it("a payload naming no encoding is processed but counted unmapped", async () => {
		const { prisma, publish } = makeDeps([
			row({ raw: { type: "SOMETHING_ELSE" } }),
		]);
		const stats = await createInboundDispatcher({
			prisma,
			publish,
			now: () => new Date(),
		})();
		expect(stats).toEqual({ claimed: 1, published: 0, unmapped: 1 });
		expect(publish).not.toHaveBeenCalled();
	});

	it("reads encodingId from either wire spelling", async () => {
		const { prisma, publish } = makeDeps([row({ raw: { encodingId: ENC } })]);
		await createInboundDispatcher({ prisma, publish, now: () => new Date() })();
		expect(publish).toHaveBeenCalledWith(ENC);
	});

	it("a publish failure neither unclaims the row nor aborts the batch", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { prisma, updateMany, publish } = makeDeps([
			row(),
			row({ id: "row-2", raw: { encodingId: "bm-enc-456" } }),
		]);
		publish.mockRejectedValueOnce(new Error("redis pub down"));
		const stats = await createInboundDispatcher({
			prisma,
			publish,
			now: () => new Date(),
		})();
		expect(stats.claimed).toBe(2);
		expect(stats.published).toBe(1);
		// No compensating un-claim write: the poll covers the row regardless.
		expect(updateMany).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});
});
