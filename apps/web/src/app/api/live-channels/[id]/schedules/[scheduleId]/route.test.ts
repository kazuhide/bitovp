import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR2 — cancel. The atomic-claim contract: ONLY an ARMED row
 * cancels; a row the sweep already claimed reports its real state.
 */

const updateMany = vi.fn();
const findFirst = vi.fn();
const findChannel = vi.fn();
let tenant: unknown;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant,
		prisma: {
			liveChannel: { findUnique: findChannel },
			liveSchedule: { updateMany, findFirst },
		},
	}),
}));

import { DELETE } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c2";
const SCHEDULE_ID = "00000000-0000-4000-8000-0000000000e2";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const owner = {
	actorUserId: OWNER_ID,
	effectiveUserId: OWNER_ID,
	actor: `user:${OWNER_ID}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};
const otherAdmin = {
	...owner,
	actorUserId: OTHER_ID,
	effectiveUserId: OTHER_ID,
	actor: `user:${OTHER_ID}`,
};
const managedChannel = {
	origin: "MANAGED",
	plan: {
		start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
	},
};

function allowAisaOwner() {
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", OWNER_ID);
	tenant = owner;
}

const ctx = (scheduleId = SCHEDULE_ID) => ({
	params: Promise.resolve({ id: CHANNEL_ID, scheduleId }),
});
const req = () => new Request("http://test", { method: "DELETE" });

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "false");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", "");
	tenant = { ...otherAdmin, role: "OPERATOR", actorRole: "OPERATOR" };
	findChannel.mockResolvedValue({ origin: "MANAGED", plan: {} });
});
afterEach(() => vi.unstubAllEnvs());

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

	it("cancels a managed AISA schedule with the same channel and ARMED claim", async () => {
		allowAisaOwner();
		findChannel.mockResolvedValue({
			origin: "MANAGED",
			plan: {
				start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
			},
		});
		updateMany.mockResolvedValue({ count: 1 });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: SCHEDULE_ID, status: "CANCELED" });
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: SCHEDULE_ID,
				liveChannelId: CHANNEL_ID,
				status: "ARMED",
			},
			data: { status: "CANCELED" },
		});
	});

	it("does not cancel a managed AISA schedule already claimed by the sweep", async () => {
		allowAisaOwner();
		findChannel.mockResolvedValue({
			origin: "MANAGED",
			plan: {
				start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
			},
		});
		updateMany.mockResolvedValue({ count: 0 });
		findFirst.mockResolvedValue({ status: "FIRED" });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "SCHEDULE_NOT_CANCELLABLE", status: "FIRED" },
		});
	});

	it("refuses imported schedule cancellation before touching its row", async () => {
		allowAisaOwner();
		findChannel.mockResolvedValue({ origin: "AISA_IMPORTED", plan: null });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "AISA_IMPORTED_READ_ONLY" },
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(findFirst).not.toHaveBeenCalled();
	});

	it.each([
		["other ADMIN", otherAdmin, "true"],
		[
			"other OPERATOR",
			{ ...otherAdmin, role: "OPERATOR", actorRole: "OPERATOR" },
			"true",
		],
		["flag off", owner, "false"],
		["token actor", { ...owner, actor: "token:synthetic" }, "true"],
		["impersonation", { ...owner, isImpersonating: true }, "true"],
		["missing principal", undefined, "true"],
	])("denies managed schedule cancellation for %s before reading or changing its row", async (_label, principal, flag) => {
		allowAisaOwner();
		tenant = principal;
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", flag);
		findChannel.mockResolvedValue(managedChannel);
		updateMany.mockResolvedValue({ count: 1 });
		const res = await DELETE(req(), ctx());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
		expect(updateMany).not.toHaveBeenCalled();
		expect(findFirst).not.toHaveBeenCalled();
	});
});
