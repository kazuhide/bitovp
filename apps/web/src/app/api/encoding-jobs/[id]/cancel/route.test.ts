import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { encodingJob: { updateMany } },
	}),
}));

import { POST } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}

function postRequest(): Request {
	return new Request("http://test/api/encoding-jobs/x/cancel", {
		method: "POST",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("POST /api/encoding-jobs/[id]/cancel", () => {
	it("atomically claims the flag and returns 200 for a live job", async () => {
		updateMany.mockResolvedValueOnce({ count: 1 });
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: JOB_ID, cancelRequested: true });
		// The claim is the lock: QUEUED|RUNNING AND not already cancel-requested,
		// flipping ONLY cancelRequested — never status (the worker owns that).
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: JOB_ID,
				status: { in: ["QUEUED", "RUNNING"] },
				cancelRequested: false,
			},
			data: { cancelRequested: true },
		});
	});

	it("returns 409 when the claim matches no row (terminal/already-canceling)", async () => {
		updateMany.mockResolvedValueOnce({ count: 0 });
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(409);
	});

	it("never writes status (only cancelRequested) — secret-free, status-free claim", async () => {
		updateMany.mockResolvedValueOnce({ count: 1 });
		await POST(postRequest(), ctx(JOB_ID));
		const arg = updateMany.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(Object.keys(arg.data)).toEqual(["cancelRequested"]);
		expect(arg.data).not.toHaveProperty("status");
		// No secret material anywhere in the request the route issues.
		expect(JSON.stringify(arg)).not.toMatch(/key|secret|password|token/i);
	});

	it("rejects a non-UUID id with 400 before touching the DB", async () => {
		const res = await POST(postRequest(), ctx("not-a-uuid"));
		expect(res.status).toBe(400);
		expect(updateMany).not.toHaveBeenCalled();
	});
});
