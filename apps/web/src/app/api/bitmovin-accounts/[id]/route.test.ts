import { beforeEach, expect, it, vi } from "vitest";

const { remove, deleteMany } = vi.hoisted(() => ({
	remove: vi.fn(),
	deleteMany: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { remove },
		prisma: { appSetting: { deleteMany } },
	}),
}));

import { DELETE } from "./route";

beforeEach(() => {
	vi.clearAllMocks();
	remove.mockResolvedValue(undefined);
});
it("cleans only the removed account's statistics import ownership", async () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const response = await DELETE(new Request("http://test"), {
		params: Promise.resolve({ id }),
	});
	expect(response.status).toBe(204);
	expect(deleteMany).toHaveBeenCalledWith({
		where: { key: `usage.backfill.${id}` },
	});
});
it("does not cancel an import if account deletion was refused", async () => {
	remove.mockRejectedValueOnce(new Error("in use"));
	await DELETE(new Request("http://test"), {
		params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
	});
	expect(deleteMany).not.toHaveBeenCalled();
});
