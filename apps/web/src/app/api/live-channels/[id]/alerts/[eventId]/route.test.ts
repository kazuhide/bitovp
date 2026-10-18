import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Manual alert resolve (review-83b C1's operator escape hatch): before
 * this route, NO product surface could close an open alert event — the
 * only clear was deleting the rule, which cascade-deletes its history.
 */

const eventFindFirst = vi.fn();
const eventUpdateMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			alertEvent: { findFirst: eventFindFirst, updateMany: eventUpdateMany },
		},
	}),
}));

import { PATCH } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000d9";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e9";

const patch = (body: unknown = { action: "resolve" }) =>
	PATCH(
		new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }),
		{ params: Promise.resolve({ id: CHANNEL_ID, eventId: EVENT_ID }) },
	);

beforeEach(() => {
	vi.clearAllMocks();
	eventFindFirst.mockResolvedValue({ id: EVENT_ID, resolvedAt: null });
	eventUpdateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/live-channels/[id]/alerts/[eventId]", () => {
	it("resolves an OPEN event via a CAS on resolvedAt", async () => {
		const res = await patch();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: EVENT_ID, resolved: true });
		expect(eventUpdateMany).toHaveBeenCalledWith({
			where: { id: EVENT_ID, resolvedAt: null },
			data: { resolvedAt: expect.any(Date) },
		});
	});

	it("409 when already resolved — a lost race against the engine is benign", async () => {
		eventFindFirst.mockResolvedValue({
			id: EVENT_ID,
			resolvedAt: new Date("2026-08-14T00:00:00Z"),
		});
		const res = await patch();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "ALERT_ALREADY_RESOLVED" },
		});
		expect(eventUpdateMany).not.toHaveBeenCalled();
	});

	it("409 when the CAS itself loses (resolved between read and write)", async () => {
		eventUpdateMany.mockResolvedValue({ count: 0 });
		const res = await patch();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "ALERT_ALREADY_RESOLVED" },
		});
	});

	it("404 when the event is not in THIS channel", async () => {
		eventFindFirst.mockResolvedValue(null);
		const res = await patch();
		expect(res.status).toBe(404);
		expect(eventFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: EVENT_ID, liveChannelId: CHANNEL_ID },
			}),
		);
	});

	it("400 on any body but {action:'resolve'} (strict)", async () => {
		expect((await patch({ action: "dismiss" })).status).toBe(400);
		expect((await patch({})).status).toBe(400);
	});
});
