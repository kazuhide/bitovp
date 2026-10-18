import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();

const inputsList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = { inputs: { list: inputsList } };
	},
}));

import { GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

function request(query = `?bitmovinAccountId=${ACCOUNT_ID}`): Request {
	return new Request(`http://test/api/live/inputs${query}`);
}

/**
 * `count` synthetic inputs, so a full page (100) can be produced cheaply.
 * `totalCount: null` reproduces an envelope that omits the field.
 */
function page(count: number, prefix: string, totalCount: number | null = 512) {
	return {
		...(totalCount !== null ? { totalCount } : {}),
		items: Array.from({ length: count }, (_, i) => ({
			id: `${prefix}-${i}`,
			name: `${prefix}-name-${i}`,
			type: "S3",
		})),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("name search (ledger #30)", () => {
	it("passes the name filter through to every page of the Bitmovin list (C24)", async () => {
		inputsList.mockResolvedValue({ items: [{ id: "in-1", name: "slate" }] });
		const res = await GET(
			new Request(
				`http://test/api/live/inputs?bitmovinAccountId=${ACCOUNT_ID}&name=slate`,
			),
		);
		expect(res.status).toBe(200);
		expect(inputsList).toHaveBeenCalledWith(
			expect.objectContaining({ name: "slate" }),
		);
	});

	it("the name filter rides EVERY page, not just the first (review-176 M11)", async () => {
		const full = Array.from({ length: 100 }, (_, i) => ({
			id: `in-${i}`,
			name: "slate",
		}));
		inputsList
			.mockResolvedValueOnce({ items: full })
			.mockResolvedValueOnce({ items: [{ id: "in-last", name: "slate" }] });
		await GET(
			new Request(
				`http://test/api/live/inputs?bitmovinAccountId=${ACCOUNT_ID}&name=slate`,
			),
		);
		expect(inputsList).toHaveBeenCalledTimes(2);
		for (const call of inputsList.mock.calls) {
			expect(call[0]).toEqual(expect.objectContaining({ name: "slate" }));
		}
	});

	it("absent name keeps the drain byte-identical (no name key at all)", async () => {
		inputsList.mockResolvedValue({ items: [] });
		await GET(
			new Request(
				`http://test/api/live/inputs?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const arg = inputsList.mock.calls[0]?.[0] as Record<string, unknown>;
		expect("name" in arg).toBe(false);
	});
});

describe("GET /api/live/inputs", () => {
	it("projects to {id, name, type} — per-type connection fields never leave the server", async () => {
		inputsList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "in-1",
					name: "slates",
					type: "S3",
					bucketName: "my-bucket",
					accessKey: "AKIAEXAMPLE",
					secretKey: "super-secret",
					cloudRegion: "EU_WEST_1",
				},
			],
		});
		const res = await GET(request());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items).toEqual([{ id: "in-1", name: "slates", type: "S3" }]);
		expect(JSON.stringify(body)).not.toContain("super-secret");
		expect(JSON.stringify(body)).not.toContain("AKIAEXAMPLE");
	});

	it("stops after a short page (C6 limit 100 per call)", async () => {
		inputsList.mockResolvedValueOnce(page(100, "a"));
		inputsList.mockResolvedValueOnce(page(3, "b"));
		const res = await GET(request());
		const body = (await res.json()) as {
			items: unknown[];
			totalCount?: number;
			truncated?: boolean;
		};
		expect(inputsList).toHaveBeenNthCalledWith(1, { offset: 0, limit: 100 });
		expect(inputsList).toHaveBeenNthCalledWith(2, { offset: 100, limit: 100 });
		expect(inputsList).toHaveBeenCalledTimes(2);
		expect(body.items).toHaveLength(103);
		expect(body.totalCount).toBe(512);
		expect(body.truncated).toBeUndefined();
	});

	it("caps the drain at 5 pages and reports truncated instead of pretending to be complete", async () => {
		for (let i = 0; i < 5; i += 1) {
			inputsList.mockResolvedValueOnce(page(100, `p${i}`));
		}
		const res = await GET(request());
		const body = (await res.json()) as {
			items: unknown[];
			truncated?: boolean;
		};
		expect(inputsList).toHaveBeenCalledTimes(5);
		expect(body.items).toHaveLength(500);
		expect(body.truncated).toBe(true);
	});

	// Filling the last allowed page is not evidence of a 501st input. The
	// envelope's own total settles it, and the UI must not tell an operator
	// their COMPLETE list is partial (C24).
	it("does not claim truncated when totalCount says the cap is the whole list", async () => {
		for (let i = 0; i < 5; i += 1) {
			inputsList.mockResolvedValueOnce(page(100, `p${i}`, 500));
		}
		const res = await GET(request());
		const body = (await res.json()) as {
			items: unknown[];
			totalCount?: number;
			truncated?: boolean;
		};
		expect(inputsList).toHaveBeenCalledTimes(5);
		expect(body.items).toHaveLength(500);
		expect(body.totalCount).toBe(500);
		expect(body.truncated).toBeUndefined();
	});

	// `PaginationResponse.totalCount` is optional on every list and there is no
	// `includeTotalCount` to force it, so the page cap stays the fail-safe: a
	// spurious paste prompt beats hiding an input.
	it("falls back to the page cap when the envelope omits totalCount", async () => {
		for (let i = 0; i < 5; i += 1) {
			inputsList.mockResolvedValueOnce(page(100, `p${i}`, null));
		}
		const res = await GET(request());
		const body = (await res.json()) as {
			totalCount?: number;
			truncated?: boolean;
		};
		expect(body.totalCount).toBeUndefined();
		expect(body.truncated).toBe(true);
	});

	// An id-less row cannot be picked so it is dropped from `items` — but it was
	// still one of the rows the total counts, so the comparison uses rows
	// RECEIVED. Otherwise the projection itself would fake a partial list.
	it("compares the total against rows received, not rows kept", async () => {
		for (let i = 0; i < 4; i += 1) {
			inputsList.mockResolvedValueOnce(page(100, `p${i}`, 500));
		}
		const last = page(100, "p4", 500);
		// `delete`, deliberately: reproduces an id-less API row (the former
		// noDelete suppression stopped suppressing anything under biome 2.4).
		delete (last.items[0] as { id?: string }).id;
		inputsList.mockResolvedValueOnce(last);
		const res = await GET(request());
		const body = (await res.json()) as {
			items: unknown[];
			truncated?: boolean;
		};
		expect(body.items).toHaveLength(499);
		expect(body.truncated).toBeUndefined();
	});

	it("400s a missing bitmovinAccountId and 404s an unknown one", async () => {
		expect((await GET(request(""))).status).toBe(400);
		expect(inputsList).not.toHaveBeenCalled();
		getAccount.mockResolvedValueOnce(null);
		expect((await GET(request())).status).toBe(404);
	});

	it("maps an upstream 429 to 502 (our quota standing, not the browser's)", async () => {
		inputsList.mockRejectedValueOnce(
			Object.assign(new Error("slow down"), {
				httpStatusCode: 429,
				shortMessage: "Too many requests",
			}),
		);
		expect((await GET(request())).status).toBe(502);
	});
});
