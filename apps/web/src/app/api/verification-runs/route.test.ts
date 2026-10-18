import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { verificationRun: { findMany, findUnique } },
	}),
}));

import { GET as detail } from "./[id]/route";
import { GET as list } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("verification evidence HTTP boundary", () => {
	it.each([
		[
			"a signed-in administrator",
			new Request("http://test/api/verification-runs", {
				headers: { "x-bitovp-role": "ADMIN" },
			}),
		],
		[
			"an API token",
			new Request("http://test/api/verification-runs", {
				headers: { authorization: "Bearer test-token" },
			}),
		],
	] as const)("returns 404 for the list to %s without reading evidence", async (_actor, request) => {
		const response = await list(request);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
		expect(findMany).not.toHaveBeenCalled();
	});

	it.each([
		["a signed-in administrator", { "x-bitovp-role": "ADMIN" }],
		["an API token", { authorization: "Bearer test-token" }],
	] as const)("returns 404 for a detail to %s without reading evidence", async (_actor, headers) => {
		const response = await detail(
			new Request(`http://test/api/verification-runs/${ID}`, { headers }),
			{ params: Promise.resolve({ id: ID }) },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
		expect(findUnique).not.toHaveBeenCalled();
	});
});
