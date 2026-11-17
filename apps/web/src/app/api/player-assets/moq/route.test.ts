import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bundle: vi.fn() }));
vi.mock("@/lib/server/moq-player-asset", () => ({
	readMoqPlayerBundle: mocks.bundle,
}));

import { GET } from "./route";

beforeEach(() => vi.resetAllMocks());
describe("fixed MoQ player asset route", () => {
	it("serves the validated local asset privately without accepting a source parameter", async () => {
		mocks.bundle.mockResolvedValue(
			new TextEncoder().encode("/* verified bytes */").buffer,
		);
		const response = await GET(
			new Request("http://test/api/player-assets/moq"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/javascript; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await response.text()).toBe("/* verified bytes */");
		expect(mocks.bundle).toHaveBeenCalledWith();
	});
	it.each([
		"?path=/tmp/private",
		"?url=https://private.example/",
		"?sha256=anything",
	])("rejects request-controlled asset selection %s before reading a file", async (query) => {
		expect(
			(await GET(new Request(`http://test/api/player-assets/moq${query}`)))
				.status,
		).toBe(400);
		expect(mocks.bundle).not.toHaveBeenCalled();
	});
	it("withholds paths and arbitrary underlying error text", async () => {
		mocks.bundle.mockRejectedValue(new Error("/private/secret/token.js"));
		const response = await GET(
			new Request("http://test/api/player-assets/moq"),
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			error: "MoQ player bundle unavailable",
		});
	});
});
