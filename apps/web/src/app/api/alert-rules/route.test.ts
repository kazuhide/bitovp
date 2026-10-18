import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2 — the rules API parses through CORE's schema, so the
 * reserved metric and the threshold cross-rules are enforced at the door.
 */

const findMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { alertRule: { findMany, create } },
	}),
}));

import { GET, POST } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c5";

const post = (body: unknown) =>
	new Request("http://test/api/alert-rules", {
		method: "POST",
		body: JSON.stringify(body),
	});

beforeEach(() => {
	vi.clearAllMocks();
	create.mockImplementation(async ({ data }) => ({ id: "r-1", ...data }));
});

describe("POST /api/alert-rules", () => {
	it("creates a GLOBAL rule with defaults applied", async () => {
		const res = await POST(post({ metric: "INPUT_DISCONNECTED" }));
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			data: {
				liveChannelId: null,
				metric: "INPUT_DISCONNECTED",
				threshold: null,
				windowPolls: 2,
				severity: "WARN",
				enabled: true,
			},
		});
	});

	it("refuses the RESERVED PACKET_DELTA_ZERO metric", async () => {
		const res = await POST(post({ metric: "PACKET_DELTA_ZERO" }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses a numeric rule without a threshold, and a flag rule with one", async () => {
		expect((await POST(post({ metric: "BITRATE_BELOW" }))).status).toBe(400);
		expect(
			(await POST(post({ metric: "HEARTBEAT_STALE", threshold: 5 }))).status,
		).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("accepts a channel-scoped numeric rule", async () => {
		const res = await POST(
			post({
				liveChannelId: CHANNEL_ID,
				metric: "FPS_BELOW",
				threshold: 24,
				severity: "CRIT",
			}),
		);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				metric: "FPS_BELOW",
				threshold: 24,
				severity: "CRIT",
			}),
		});
	});

	it("codes a channel FK refusal without exposing database wording", async () => {
		create.mockRejectedValueOnce({ code: "P2003" });
		const res = await POST(
			post({ liveChannelId: CHANNEL_ID, metric: "INPUT_DISCONNECTED" }),
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: { code: "ALERT_CHANNEL_NOT_FOUND" },
		});
	});
});

describe("GET /api/alert-rules", () => {
	it("returns everything without a filter", async () => {
		findMany.mockResolvedValue([]);
		await GET(new Request("http://test/api/alert-rules"));
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: {} }),
		);
	});

	it("channel filter includes GLOBAL rules (they apply there too)", async () => {
		findMany.mockResolvedValue([]);
		await GET(
			new Request(`http://test/api/alert-rules?liveChannelId=${CHANNEL_ID}`),
		);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [{ liveChannelId: null }, { liveChannelId: CHANNEL_ID }],
				},
			}),
		);
	});
});
