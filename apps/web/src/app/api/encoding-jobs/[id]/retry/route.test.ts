import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const queueAdd = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { encodingJob: { findUnique, updateMany, update } },
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getOrchestratorQueue: () => ({ add: queueAdd }),
}));

import { POST } from "./route";

const ID = "00000000-0000-4000-8000-0000000000aa";
const params = { params: Promise.resolve({ id: ID }) };
const req = () => new Request("http://test", { method: "POST" });

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	updateMany.mockResolvedValue({ count: 1 });
	queueAdd.mockResolvedValue({});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/encoding-jobs/[id]/retry", () => {
	it("refuses irreversible remote STOP intent even if the job remains ERROR", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			stepLog: [],
			remoteStopRequestedAt: new Date("2026-09-01T00:00:00Z"),
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("re-run-as-new"),
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("404s unknown jobs", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await POST(req(), params)).status).toBe(404);
	});

	it("409s when the job is not in ERROR", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "RUNNING" });
		expect((await POST(req(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("resets failed steps, claims atomically, and re-enqueues", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			stepLog: [
				{
					step: "input:main",
					kind: "CREATE_INPUT_S3",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "bm-1",
				},
				{
					step: "encoding",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "FAILED",
					error: "boom",
				},
			],
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(200);

		const args = updateMany.mock.calls[0]?.[0] as {
			where: unknown;
			data: { stepLog: { step: string; status: string }[] };
		};
		expect(args.where).toEqual({
			id: ID,
			status: "ERROR",
			remoteStopRequestedAt: null,
		});
		// rev431: a retry may resume the same encoding, so any stop/CREATED
		// confirmation for its pointer is cleared with the QUEUED flip
		expect(
			(args.data as { encoderStoppedConfirmedFor?: unknown })
				.encoderStoppedConfirmedFor,
		).toBeNull();
		expect(args.data.stepLog.find((s) => s.step === "input:main")?.status).toBe(
			"DONE",
		);
		expect(args.data.stepLog.find((s) => s.step === "encoding")?.status).toBe(
			"PENDING",
		);
		expect(queueAdd).toHaveBeenCalled();
	});

	it("409s when another retry claimed the row first", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "ERROR", stepLog: [] });
		updateMany.mockResolvedValueOnce({ count: 0 });
		expect((await POST(req(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("marks the row ERROR again when enqueue fails", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "ERROR", stepLog: [] });
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await POST(req(), params);
		expect(res.status).toBe(500);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});
