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

const path = "/api/library/scenes/options";
const call = (params = "") =>
	GET(new Request(`http://localhost${path}?${params}`));
beforeEach(() => {
	vi.clearAllMocks();
	query.mockResolvedValue([{ locale: "en" }, { locale: "ja" }]);
	context.mockResolvedValue({ prisma: { $queryRaw: query } });
});
it("uses the guarded VIEWER read and only projects validated language choices", async () => {
	expect(classifyPath(path)).toBe("api-guarded");
	expect(evaluateRole("VIEWER", path, "GET")).toMatchObject({ allowed: true });
	query.mockResolvedValue([
		{ locale: "en", raw: "PRIVATE" },
		{ locale: "und" },
		{ locale: "bad/path" },
		{ locale: "" },
	]);
	expect(await (await call()).json()).toEqual({ locales: ["en", "und"] });
});
it("rejects invalid scope before querying and requires fresh organization context", async () => {
	expect((await call("archived=yes")).status).toBe(400);
	expect(query).not.toHaveBeenCalled();
	context.mockRejectedValueOnce(new AuthContextError(401, "Invalid session"));
	expect((await call()).status).toBe(401);
	expect(query).not.toHaveBeenCalled();
});
