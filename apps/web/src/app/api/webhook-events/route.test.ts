import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma: { webhookEvent: { findMany } } }),
}));

import { GET } from "./route";

/**
 * rev414 R4: heartbeat pushes (one WebhookEvent per interval per live
 * encoding — 4,320/day at 20 s, 86,400/day at 1 s) would bury every
 * FINISHED/ERROR delivery off the first page within minutes, so the list
 * leaves them out unless asked.
 */
describe("GET /api/webhook-events — deliveries list", () => {
	it("leaves LIVE_ENCODING_HEARTBEAT rows out by default and pages the rest newest first", async () => {
		findMany.mockResolvedValueOnce([
			{ id: "e2", eventType: "ENCODING_FINISHED" },
			{ id: "e1", eventType: "ENCODING_ERROR" },
		]);
		const res = await GET(
			new Request("http://test/api/webhook-events?limit=1"),
		);
		expect(res.status).toBe(200);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { eventType: { not: "LIVE_ENCODING_HEARTBEAT" } },
				take: 2,
			}),
		);
		const body = (await res.json()) as {
			items: { id: string }[];
			nextCursor?: string;
		};
		expect(body.items.map((i) => i.id)).toEqual(["e2"]);
		expect(body.nextCursor).toBe("e2");
	});

	it("includes heartbeats only when asked (includeHeartbeats=1)", async () => {
		findMany.mockResolvedValueOnce([]);
		const res = await GET(
			new Request("http://test/api/webhook-events?includeHeartbeats=1"),
		);
		expect(res.status).toBe(200);
		expect(findMany.mock.calls.at(-1)?.[0]).not.toHaveProperty("where");
	});

	it("rejects a bad flag value with 400", async () => {
		const res = await GET(
			new Request("http://test/api/webhook-events?includeHeartbeats=yes"),
		);
		expect(res.status).toBe(400);
	});
});
