import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const queueAdd = vi.fn();
const queueGetJob = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { feederSession: { findUnique } },
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getFeederQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}));

import { POST } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";

function postAction(body: unknown, id = SESSION_ID) {
	return POST(
		new Request(`http://test/api/feeder-sessions/${id}/actions`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue({
		id: SESSION_ID,
		status: "PUSHING",
		pid: 4242,
		processGoneAt: null,
	});
	queueGetJob.mockResolvedValue(undefined);
});

describe("POST /api/feeder-sessions/[id]/actions", () => {
	it("rejects unknown actions and invalid ids", async () => {
		expect((await postAction({ action: "restart" })).status).toBe(400);
		expect((await postAction({ action: "stop" }, "nope")).status).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("404s on unknown sessions", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await postAction({ action: "stop" })).status).toBe(404);
	});

	it.each([
		"STOPPED",
		"ERROR",
	])("409s on terminal sessions that hold no process (%s)", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status,
			pid: null,
			processGoneAt: null,
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(409);
		expect(await res.text()).toContain(
			"no process that could still be running",
		);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	/**
	 * Audit 2026-08-29 CRITICAL-2. A START job that dies outside the worker
	 * leaves the row ERROR with its pid KEPT, and a `-stream_loop -1` ffmpeg
	 * still pushing. This route was the only door to the worker's kill ladder,
	 * and it 409'd on the status alone — so the process could not be reached
	 * from the product at all.
	 */
	it("enqueues a reclaim stop for an ERROR session that still records an unreclaimed pid", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "ERROR",
			pid: 4242,
			processGoneAt: null,
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ action: "stop", status: "ERROR" });
		expect(queueAdd).toHaveBeenCalledWith(
			"feeder",
			{ feederSessionId: SESSION_ID, action: "stop" },
			expect.objectContaining({ jobId: `${SESSION_ID}-stop` }),
		);
	});

	it("409s once that pid has been PROVEN gone (the reclaim already ran)", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "ERROR",
			pid: 4242,
			processGoneAt: new Date("2026-08-29T00:00:00.000Z"),
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("enqueues a repair stop for a terminal held claim whose process is already proven gone", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			pid: null,
			processGoneAt: new Date("2026-08-29T00:00:00.000Z"),
			publisherClaimedAt: new Date("2026-08-29T00:00:00.000Z"),
			publisherReleasedAt: null,
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(200);
		expect(queueAdd).toHaveBeenCalled();
	});

	it("selects the process ledger, not just the status", async () => {
		await postAction({ action: "stop" });
		const arg = findUnique.mock.calls[0]?.[0] as {
			select?: Record<string, boolean>;
		};
		expect(arg.select).toMatchObject({
			pid: true,
			processGoneAt: true,
			publisherClaimedAt: true,
			publisherReleasedAt: true,
		});
	});

	it("enqueues the worker stop on the constant <id>:stop jobId (collapses with the channel-stop coupling)", async () => {
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			action: "stop",
			status: "PUSHING", // no route-side claim — the worker owns the flip
		});
		expect(queueAdd).toHaveBeenCalledWith(
			"feeder",
			{ feederSessionId: SESSION_ID, action: "stop" },
			expect.objectContaining({ jobId: `${SESSION_ID}-stop` }),
		);
	});

	it("removes a FAILED stop job parked under the dedup id, then re-enqueues (failed-then-retry)", async () => {
		const remove = vi.fn(async () => {});
		queueGetJob.mockResolvedValueOnce({
			getState: async () => "failed",
			remove,
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(200);
		expect(queueGetJob).toHaveBeenCalledWith(`${SESSION_ID}-stop`);
		expect(remove).toHaveBeenCalled();
		expect(queueAdd).toHaveBeenCalledWith(
			"feeder",
			{ feederSessionId: SESSION_ID, action: "stop" },
			expect.objectContaining({ jobId: `${SESSION_ID}-stop` }),
		);
	});

	it("keeps idempotency for pending duplicates (waiting job is NOT removed)", async () => {
		const remove = vi.fn(async () => {});
		queueGetJob.mockResolvedValueOnce({
			getState: async () => "waiting",
			remove,
		});
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(200);
		expect(remove).not.toHaveBeenCalled();
		// The add still runs — BullMQ's jobId dedupe makes it a no-op.
		expect(queueAdd).toHaveBeenCalled();
	});
});
