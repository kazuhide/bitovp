import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma: { auditLog: { findMany, findUnique } } }),
}));

import { GET as detail } from "./[id]/route";
import { GET as list } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("GET /api/audit-logs", () => {
	it("withholds legacy webhook exception strings while retaining failure status and other actors", async () => {
		findMany.mockResolvedValueOnce([
			{
				id: ID,
				actor: "worker:webhook-registrar",
				statusCode: 409,
				error: "SYNTHETIC_AUDIT_SECRET_CANARY",
			},
			{
				id: "other",
				actor: "worker:other",
				statusCode: 500,
				error: "ordinary diagnostic",
			},
			{
				id: "success",
				actor: "worker:webhook-registrar",
				statusCode: 200,
				error: null,
			},
		]);
		const body = await (
			await list(new Request("http://t/api/audit-logs"))
		).json();
		expect(body.items[0]).toMatchObject({
			statusCode: 409,
			error: "Webhook provider operation failed",
		});
		expect(body.items[1].error).toBe("ordinary diagnostic");
		expect(body.items[2].error).toBeNull();
		expect(JSON.stringify(body)).not.toContain("SYNTHETIC_AUDIT_SECRET_CANARY");
	});
	/**
	 * Re-audit HIGH-7: the list answered WHAT happened and never WHO. A
	 * verification run records `token:<id>` in the same convention, so this is
	 * the column the two join on.
	 */
	it("selects the actor, and still omits the request/response payloads", async () => {
		findMany.mockResolvedValueOnce([]);
		await list(new Request("http://t/api/audit-logs"));
		const select = findMany.mock.calls[0]?.[0]?.select as Record<
			string,
			boolean
		>;
		expect(select.actor).toBe(true);
		expect(select.request).toBeUndefined();
		expect(select.response).toBeUndefined();
	});

	it("returns the actor to the caller", async () => {
		findMany.mockResolvedValueOnce([
			{ id: ID, actor: "token:tok-1", method: "POST", path: "/encoding" },
		]);
		const res = await list(new Request("http://t/api/audit-logs"));
		expect((await res.json()).items[0].actor).toBe("token:tok-1");
	});
});

describe("GET /api/audit-logs/[id]", () => {
	it.each([
		null,
		"SYNTHETIC_AUDIT_SECRET_CANARY",
		"",
	])("withholds legacy webhook payloads and retains error presence (case %#)", async (error) => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			actor: "worker:webhook-registrar",
			statusCode: error === null ? 200 : 409,
			error,
			request: { url: "https://example.invalid/SYNTHETIC_AUDIT_SECRET_CANARY" },
			response: { message: "SYNTHETIC_AUDIT_SECRET_CANARY" },
		});
		const body = await (
			await detail(new Request("http://t/x"), {
				params: Promise.resolve({ id: ID }),
			})
		).json();
		expect(body.error).toBe(
			error === null ? null : "Webhook provider operation failed",
		);
		expect(body.statusCode).toBe(error === null ? 200 : 409);
		expect(body.request).toBe("[withheld]");
		expect(body.response).toBe("[withheld]");
		expect(JSON.stringify(body)).not.toContain("SYNTHETIC_AUDIT_SECRET_CANARY");
	});
	/**
	 * Other actors retain their existing at-rest-redacted projection; legacy
	 * webhook registrar rows have the stricter read boundary tested above.
	 */
	it("returns the row with its redacted request and response", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			actor: "token:tok-1",
			method: "POST",
			path: "/encoding/encodings",
			request: { apiKey: "[REDACTED]", name: "run" },
			response: { id: "enc-1" },
		});
		const res = await detail(new Request("http://t/x"), {
			params: Promise.resolve({ id: ID }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.request).toEqual({ apiKey: "[REDACTED]", name: "run" });
		expect(body.response).toEqual({ id: "enc-1" });
	});

	it("404s an unknown id and 400s a non-uuid one, without touching the database", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect(
			(
				await detail(new Request("http://t/x"), {
					params: Promise.resolve({ id: ID }),
				})
			).status,
		).toBe(404);
		findUnique.mockClear();
		expect(
			(
				await detail(new Request("http://t/x"), {
					params: Promise.resolve({ id: "nope" }),
				})
			).status,
		).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});
});
