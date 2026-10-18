import { beforeEach, describe, expect, it, vi } from "vitest";

const channelFindUnique = vi.fn();
const eventFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannel: { findUnique: channelFindUnique },
			alertEvent: { findMany: eventFindMany },
		},
	}),
}));

import { GET } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000d9";
const ctx = () => ({ params: Promise.resolve({ id: CHANNEL_ID }) });

beforeEach(() => {
	vi.clearAllMocks();
	channelFindUnique.mockResolvedValue({ id: CHANNEL_ID });
});

describe("GET /api/live-channels/[id]/alerts (ledger #83)", () => {
	it("open and history are SEPARATE queries — the take bounds history only (review-83b I4)", async () => {
		// One shared take-50 let a long-open alert (ranked by its OLD
		// openedAt) drop off the banner once 50 newer events existed while
		// the dashboard still counted it.
		eventFindMany.mockImplementation(
			async (args: { where: { resolvedAt: null | { not: null } } }) =>
				args.where.resolvedAt === null
					? [{ id: "e1", resolvedAt: null, rule: { metric: "X" } }]
					: [
							{
								id: "e2",
								resolvedAt: "2026-08-13T00:00:00Z",
								rule: { metric: "Y" },
							},
						],
		);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			open: { id: string }[];
			history: { id: string }[];
		};
		expect(body.open.map((event) => event.id)).toEqual(["e1"]);
		expect(body.history.map((event) => event.id)).toEqual(["e2"]);
		const calls = eventFindMany.mock.calls.map(
			(call) => call[0] as { where: { resolvedAt: unknown }; take?: number },
		);
		const openCall = calls.find((call) => call.where.resolvedAt === null);
		const historyCall = calls.find((call) => call.where.resolvedAt !== null);
		expect(openCall?.take).toBeUndefined();
		expect(historyCall?.take).toBe(50);
	});

	it("404s an unknown channel", async () => {
		channelFindUnique.mockResolvedValue(null);
		const res = await GET(new Request("http://test"), ctx());
		expect(res.status).toBe(404);
	});
});
