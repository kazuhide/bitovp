import { beforeEach, expect, it, vi } from "vitest";

const prisma = {
	librarySource: { findUnique: vi.fn(), updateMany: vi.fn() },
};
const audit = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma }),
}));
vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => audit(...args),
}));

import { POST } from "./route";

const id = "00000000-0000-4000-8000-000000000001";
const request = () =>
	new Request(`http://test/api/library/sources/${id}/retry`, {
		method: "POST",
	});
const invoke = () => POST(request(), { params: Promise.resolve({ id }) });
beforeEach(() => {
	vi.clearAllMocks();
	prisma.librarySource.updateMany.mockResolvedValue({ count: 1 });
});

it.each([
	"ERROR",
	"READY",
])("explicitly queues missing default English for a %s source without starting encoding", async (state) => {
	prisma.librarySource.findUnique.mockResolvedValue({ state, locales: ["ja"] });
	const response = await invoke();
	expect(response.status).toBe(202);
	expect(prisma.librarySource.updateMany).toHaveBeenCalledWith({
		where: { id, state, locales: { equals: ["ja"] } },
		data: expect.objectContaining({
			state: "PENDING",
			locales: ["ja", "en"],
			attempts: 0,
		}),
	});
	expect(audit).toHaveBeenCalledOnce();
});

it.each([
	{ state: "READY", locales: ["ja", "en"] },
	{ state: "READY", locales: [] },
	{ state: "RUNNING", locales: ["ja"] },
	{ state: "PENDING", locales: ["ja"] },
	null,
])("does not reopen unrelated or active imports: %j", async (source) => {
	prisma.librarySource.findUnique.mockResolvedValue(source);
	expect((await invoke()).status).toBe(409);
	expect(prisma.librarySource.updateMany).not.toHaveBeenCalled();
	expect(audit).not.toHaveBeenCalled();
});

it("refuses a stale retry after state or locale ownership changed", async () => {
	prisma.librarySource.findUnique.mockResolvedValue({
		state: "READY",
		locales: ["ja"],
	});
	prisma.librarySource.updateMany.mockResolvedValue({ count: 0 });
	expect((await invoke()).status).toBe(409);
	expect(audit).not.toHaveBeenCalled();
});
