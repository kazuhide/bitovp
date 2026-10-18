import { beforeEach, expect, it, vi } from "vitest";
import { classifyPath } from "@/lib/auth/gate";
import { evaluateRole } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";

const { context, query } = vi.hoisted(() => ({
	context: vi.fn(),
	query: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: context }));

import { GET } from "./route";

const path = "/api/library/scenes";
const call = (params = "") =>
	GET(new Request(`http://localhost${path}?${params}`));
beforeEach(() => {
	vi.clearAllMocks();
	query.mockResolvedValue([{ items: [], total: 0 }]);
	context.mockResolvedValue({ prisma: { $queryRaw: query } });
});

it("remains a guarded VIEWER read", () => {
	expect(classifyPath(path)).toBe("api-guarded");
	expect(evaluateRole("VIEWER", path, "GET")).toMatchObject({ allowed: true });
});
it.each([
	`q=${"x".repeat(201)}`,
	"offset=-1",
	"offset=100001",
	"archived=yes",
	"match=fuzzy",
	"sort=random",
	"locale=../en",
])("rejects invalid search input before SQL: %s", async (params) => {
	expect((await call(params)).status).toBe(400);
	expect(query).not.toHaveBeenCalled();
});
it("requires a fresh server context even for an empty search", async () => {
	expect(await (await call()).json()).toEqual({ items: [], total: 0 });
	expect(context).toHaveBeenCalledOnce();
	expect(query).not.toHaveBeenCalled();
	context.mockRejectedValueOnce(new AuthContextError(401, "Invalid session"));
	expect((await call()).status).toBe(401);
	expect(query).not.toHaveBeenCalled();
});
