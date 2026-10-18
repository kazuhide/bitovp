import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2 — cancel. The atomic-claim contract: ONLY an ARMED row
 * cancels; a row the sweep already claimed reports its real state.
 */

const updateMany = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { liveSchedule: { updateMany, findFirst } },
	}),
}));

import { DELETE } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c2";
const SCHEDULE_ID = "00000000-0000-4000-8000-0000000000e2";

const ctx = (scheduleId = SCHEDULE_ID) => ({
	params: Promise.resolve({ id: CHANNEL_ID, scheduleId }),
});
const req = () => new Request("http://test", { method: "DELETE" });

beforeEach(() => {
	vi.clearAllMocks();
});

describe("DELETE /schedules/[scheduleId]", () => {
	it("cancels an ARMED row through the status-guarded claim", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: SCHEDULE_ID,
			status: "CANCELED",
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: SCHEDULE_ID,
				liveChannelId: CHANNEL_ID,
				status: "ARMED",
			},
			data: { status: "CANCELED" },
		});
	});

	it("409s a row the sweep already claimed, naming its state", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		findFirst.mockResolvedValue({ status: "FIRED" });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("FIRED"),
			details: { code: "SCHEDULE_NOT_CANCELLABLE", status: "FIRED" },
		});
	});

	it("404s a row that does not exist under this channel", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		findFirst.mockResolvedValue(null);
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
	});
});
