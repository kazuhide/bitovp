import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { alertRule: { updateMany, deleteMany } },
	}),
}));

import { DELETE, PATCH } from "./route";

const RULE_ID = "00000000-0000-4000-8000-0000000000d8";
const ctx = () => ({ params: Promise.resolve({ id: RULE_ID }) });

beforeEach(() => {
	vi.clearAllMocks();
});

describe("PATCH /api/alert-rules/[id] (ledger #83)", () => {
	it("toggles enabled", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const res = await PATCH(
			new Request("http://test", {
				method: "PATCH",
				body: JSON.stringify({ enabled: false }),
			}),
			ctx(),
		);
		expect(res.status).toBe(200);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: RULE_ID },
			data: { enabled: false },
		});
	});

	it("404s an unknown rule; refuses non-boolean bodies", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		const missing = await PATCH(
			new Request("http://test", {
				method: "PATCH",
				body: JSON.stringify({ enabled: true }),
			}),
			ctx(),
		);
		expect(missing.status).toBe(404);
		const bad = await PATCH(
			new Request("http://test", {
				method: "PATCH",
				body: JSON.stringify({ enabled: "yes" }),
			}),
			ctx(),
		);
		expect(bad.status).toBe(400);
	});
});

describe("DELETE /api/alert-rules/[id]", () => {
	it("deletes and reports; 404s when absent", async () => {
		deleteMany.mockResolvedValueOnce({ count: 1 });
		const res = await DELETE(new Request("http://test"), ctx());
		expect(res.status).toBe(200);
		deleteMany.mockResolvedValueOnce({ count: 0 });
		const missing = await DELETE(new Request("http://test"), ctx());
		expect(missing.status).toBe(404);
	});
});
