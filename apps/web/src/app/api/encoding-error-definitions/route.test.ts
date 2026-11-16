import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getServerContext, clientForAccount, list } = vi.hoisted(() => ({
	getServerContext: vi.fn(),
	clientForAccount: vi.fn(),
	list: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ getServerContext }));
vi.mock("@/lib/server/bitmovin", async (original) => ({
	...(await original<typeof import("@/lib/server/bitmovin")>()),
	bitmovinClientForAccount: clientForAccount,
}));

import { AuthContextError } from "@/lib/auth/tenancy";
import { GET } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ctx = { tenant: { organizationId: "current-org" } };
const req = (id = ID) =>
	new Request(
		`http://test/api/encoding-error-definitions?bitmovinAccountId=${id}`,
	);
const definition = (code: number) => ({
	code,
	category: "INPUT",
	message: "Input {1} is unavailable",
	description: "Check the source file.",
	retryHint: "NO_RETRY",
});
const page = (start: number, count: number, totalCount: number) => ({
	totalCount,
	offset: start,
	items: Array.from({ length: count }, (_, i) => definition(start + i)),
});

beforeEach(() => {
	vi.resetAllMocks();
	getServerContext.mockResolvedValue(ctx);
	clientForAccount.mockResolvedValue({
		encoding: { errorDefinitions: { list } },
	});
});
afterEach(() => vi.useRealTimers());

describe("GET /api/encoding-error-definitions", () => {
	it.each([
		"",
		"not-a-uuid",
	])("rejects invalid account %s before access", async (id) => {
		expect((await GET(req(id))).status).toBe(400);
		expect(getServerContext).not.toHaveBeenCalled();
		expect(clientForAccount).not.toHaveBeenCalled();
	});
	it("does not access another organization's absent account", async () => {
		clientForAccount.mockResolvedValue(null);
		expect((await GET(req())).status).toBe(404);
		expect(clientForAccount).toHaveBeenCalledWith(
			ctx,
			ID,
			expect.any(AbortSignal),
		);
		expect(list).not.toHaveBeenCalled();
	});

	it("keeps local authorization errors at the local boundary", async () => {
		getServerContext.mockRejectedValue(
			new AuthContextError(403, "TENANT_FORBIDDEN"),
		);
		expect((await GET(req())).status).toBe(403);
		expect(clientForAccount).not.toHaveBeenCalled();
	});

	it("returns every page and only the documented safe fields", async () => {
		const first = page(0, 100, 102);
		const firstItem = first.items[0];
		if (!firstItem) throw new Error("Missing fixture item");
		Object.assign(firstItem, { apiKey: "secret", injected: "hidden" });
		list.mockResolvedValueOnce(first).mockResolvedValueOnce(page(100, 2, 102));
		const response = await GET(req());
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.totalCount).toBe(102);
		expect(data.items).toHaveLength(102);
		expect(data.items[0]).toEqual(definition(0));
		expect(data.items[101].code).toBe(101);
		expect(list.mock.calls).toEqual([
			[{ limit: 100, offset: 0 }],
			[{ limit: 100, offset: 100 }],
		]);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("accepts a known empty catalogue, not a missing response", async () => {
		list.mockResolvedValue(page(0, 0, 0));
		const response = await GET(req());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [], totalCount: 0 });
	});

	it("preserves absent or future retry hints without promising a retry", async () => {
		list.mockResolvedValue({
			totalCount: 2,
			items: [{ code: 1 }, { code: 2, retryHint: "FUTURE_HINT" }],
		});
		const response = await GET(req());
		expect(response.status).toBe(200);
		expect((await response.json()).items).toEqual([
			{ code: 1 },
			{ code: 2, retryHint: "FUTURE_HINT" },
		]);
	});

	it.each([
		undefined,
		{},
		{ totalCount: 1, items: [] },
		{ totalCount: 1, items: [{ code: "123" }] },
		{ totalCount: 1, items: [{ code: 1, message: { unsafe: true } }] },
		{ totalCount: 1, items: [{ code: 1, description: "x".repeat(16_001) }] },
		{ totalCount: 1, offset: 100, items: [{ code: 1 }] },
		{ totalCount: 0, items: [{ code: 1 }] },
		{ totalCount: 10_001, items: [] },
	])("rejects malformed or incomplete upstream data %#", async (value) => {
		list.mockResolvedValue(value);
		const response = await GET(req());
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Invalid encoding error catalogue from Bitmovin",
		});
	});

	it("rejects changing counts and duplicate pages instead of claiming completeness", async () => {
		list
			.mockResolvedValueOnce(page(0, 1, 2))
			.mockResolvedValueOnce(page(1, 1, 3));
		expect((await GET(req())).status).toBe(502);
		list
			.mockReset()
			.mockResolvedValue({ totalCount: 2, items: [definition(0)] });
		expect((await GET(req())).status).toBe(502);
	});

	it("does not share a cached response with another selected account", async () => {
		list.mockResolvedValue(page(0, 1, 1));
		await GET(req());
		await GET(req("3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b12"));
		expect(clientForAccount.mock.calls.map((args) => args[1])).toEqual([
			ID,
			"3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b12",
		]);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("maps upstream authentication to 502 without leaking its raw request", async () => {
		list.mockRejectedValue(
			Object.assign(new Error("raw request SECRET"), { httpStatusCode: 401 }),
		);
		const response = await GET(req());
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Bitmovin API error (401)",
		});
	});

	it("bounds the whole catalogue read and aborts the SDK transport", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		clientForAccount.mockImplementation((_ctx, _id, suppliedSignal) => {
			signal = suppliedSignal;
			return { encoding: { errorDefinitions: { list } } };
		});
		list.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal?.reason), {
						once: true,
					});
				}),
		);
		const pending = GET(req());
		await vi.advanceTimersByTimeAsync(15_000);
		const response = await pending;
		expect(response.status).toBe(504);
		expect(signal?.aborted).toBe(true);
	});

	it("forwards caller cancellation and stops before reading another page", async () => {
		const controller = new AbortController();
		list.mockImplementation(async () => {
			controller.abort();
			return page(0, 1, 2);
		});
		const request = new Request(req(), { signal: controller.signal });
		expect((await GET(request)).status).toBe(499);
		expect(list).toHaveBeenCalledOnce();
		expect(clientForAccount.mock.calls[0]?.[2].aborted).toBe(true);
	});
});
