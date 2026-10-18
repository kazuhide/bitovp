import { beforeEach, describe, expect, it, vi } from "vitest";

/**  PR1 — the [id] surface (review-183 N5: it shipped unpinned). */

const updateMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { notificationChannel: { updateMany, deleteMany } },
	}),
}));

import { DELETE, PATCH } from "./route";

const ID = "00000000-0000-4000-8000-0000000000c1";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function patch(id: string, body: unknown) {
	return PATCH(
		new Request(`http://test/api/notifications/channels/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
		ctx(id),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	updateMany.mockResolvedValue({ count: 1 });
	deleteMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/notifications/channels/[id]", () => {
	it("toggles enabled", async () => {
		const res = await patch(ID, { enabled: false });
		expect(res.status).toBe(200);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: ID },
			data: { enabled: false },
		});
	});

	it("404s when the row does not exist (count 0)", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		const res = await patch(ID, { enabled: true });
		expect(res.status).toBe(404);
	});

	it("400s a non-boolean body and a non-uuid id", async () => {
		expect((await patch(ID, { enabled: "yes" })).status).toBe(400);
		expect((await patch("nope", { enabled: true })).status).toBe(400);
		// NEITHER invalid request reaches the db.
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/notifications/channels/[id]", () => {
	it("is idempotent — 204 whether or not a row was deleted", async () => {
		expect((await DELETE(new Request("http://t"), ctx(ID))).status).toBe(204);
		deleteMany.mockResolvedValue({ count: 0 });
		expect((await DELETE(new Request("http://t"), ctx(ID))).status).toBe(204);
	});
});
