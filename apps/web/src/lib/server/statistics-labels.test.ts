import BitmovinApi from "@bitmovin/api-sdk";
import { describe, expect, it, vi } from "vitest";
import { bitmovinClientForAccount } from "./bitmovin";
import {
	labelStatisticsWireReader,
	readLabelCatalog,
	readLabelCatalogPage,
	readLabelUsage,
} from "./statistics-labels";

function provider() {
	const list = vi.fn().mockResolvedValue({
		items: [{ label: "customer-a" }],
		totalCount: 1,
	});
	const daily = vi.fn().mockResolvedValue({ items: [], totalCount: 0 });
	const api = {
		encoding: {
			statistics: { labels: { list, daily: { listByDateRange: daily } } },
		},
	} as unknown as BitmovinApi;
	return { api, list, daily };
}
const account = { id: "main-id", label: "Main" };
const dailyUrl =
	"https://api.bitmovin.com/v1/encoding/statistics/labels/daily/2026-10-01/2026-10-01";
function wireResponse(items: unknown[], totalCount = items.length) {
	return new Response(
		JSON.stringify({ data: { result: { items, totalCount } } }),
	);
}
function wireApi(rows: unknown[]) {
	const wire = labelStatisticsWireReader();
	const api = new BitmovinApi({
		apiKey: "test-key",
		fetch: async (url) => {
			const response = wireResponse(
				String(url).includes("/daily/") ? rows : [{ label: "customer-a" }],
			);
			await wire.observe(String(url), response);
			return response;
		},
	});
	return { api, wire };
}

describe("provider label statistics reads", () => {
	it("fresh restart bypasses obsolete cached counts and invalidates only that credential scope", async () => {
		const { api, list } = provider();
		const scope = { offset: 0, cacheScope: "restart-scope" };
		await readLabelCatalogPage(api, scope);
		await readLabelCatalogPage(api, {
			...scope,
			cacheScope: "other-restart-scope",
		});
		list.mockResolvedValue({
			items: [{ label: "new" }, { label: "second" }],
			totalCount: 2,
		});
		expect(await readLabelCatalogPage(api, scope)).toMatchObject({
			totalCount: 1,
			source: "CACHE",
		});
		expect(
			await readLabelCatalogPage(api, { ...scope, refresh: true }),
		).toMatchObject({ totalCount: 2, source: "PROVIDER" });
		expect(await readLabelCatalogPage(api, scope)).toMatchObject({
			totalCount: 2,
			source: "CACHE",
		});
		expect(
			await readLabelCatalogPage(api, {
				...scope,
				cacheScope: "other-restart-scope",
			}),
		).toMatchObject({ totalCount: 1, source: "CACHE" });
		expect(list).toHaveBeenCalledTimes(3);
	});
	it("an older in-flight page cannot repopulate a freshly restarted scope with its obsolete count", async () => {
		const { api, list } = provider();
		let finish!: (page: {
			items: { label: string }[];
			totalCount: number;
		}) => void;
		list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const stale = readLabelCatalogPage(api, {
			offset: 1,
			cacheScope: "restart-generation",
		});
		list.mockResolvedValue({ items: [{ label: "first" }], totalCount: 3 });
		await readLabelCatalogPage(api, {
			offset: 0,
			cacheScope: "restart-generation",
			refresh: true,
		});
		finish({ items: [{ label: "obsolete" }], totalCount: 2 });
		await stale;
		list.mockResolvedValue({
			items: [{ label: "second" }, { label: "third" }],
			totalCount: 3,
		});
		expect(
			await readLabelCatalogPage(api, {
				offset: 1,
				totalCount: 3,
				cacheScope: "restart-generation",
			}),
		).toMatchObject({ totalCount: 3, source: "PROVIDER" });
		expect(list).toHaveBeenCalledTimes(3);
	});
	it("makes the first hundred labels usable after one request, without waiting for the other 760", async () => {
		const { api, list } = provider();
		list.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, i) => ({ label: `label-${i}` })),
			totalCount: 860,
		});
		const result = await readLabelCatalogPage(api, { offset: 0 });
		expect(result.labels).toHaveLength(100);
		expect(result).toMatchObject({ totalCount: 860, nextOffset: 100 });
		expect(list).toHaveBeenCalledTimes(1);
	});
	it("validates a selected label with the SDK exact filter rather than reading the entire catalog", async () => {
		const { api, list } = provider();
		await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-10-01",
			"2026-10-01",
		);
		expect(list.mock.calls).toEqual([
			[{ labels: "customer-a", limit: 100, offset: 0 }],
		]);
	});
	it("caches successful pages for sixty seconds, isolated by account and credential revision", async () => {
		const { api, list } = provider();
		vi.useFakeTimers();
		try {
			const options = { offset: 0, cacheScope: "cache-test-account-a-rev1" };
			const first = await readLabelCatalogPage(api, options);
			first.labels.push("client-cannot-poison-cache");
			expect(await readLabelCatalogPage(api, options)).toMatchObject({
				labels: ["customer-a"],
				source: "CACHE",
			});
			expect(list).toHaveBeenCalledTimes(1);
			await readLabelCatalogPage(api, {
				...options,
				cacheScope: "cache-test-account-b-rev1",
			});
			await readLabelCatalogPage(api, {
				...options,
				cacheScope: "cache-test-account-a-rev2",
			});
			expect(list).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await readLabelCatalogPage(api, options)).toMatchObject({
				source: "PROVIDER",
			});
			expect(list).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not cache provider failures, and rejects changed counts even on a cached page", async () => {
		const { api, list } = provider();
		const options = { offset: 0, cacheScope: "cache-failure-test" };
		list.mockRejectedValueOnce(new Error("provider unavailable"));
		await expect(readLabelCatalogPage(api, options)).rejects.toThrow(
			/unavailable/,
		);
		await readLabelCatalogPage(api, options);
		expect(list).toHaveBeenCalledTimes(2);
		await expect(
			readLabelCatalogPage(api, { ...options, totalCount: 2 }),
		).rejects.toThrow(/pagination changed/);
	});
	it("advances incremental pages by their actual short length and refuses incomplete pages", async () => {
		const { api, list } = provider();
		list.mockResolvedValue({
			items: [{ label: "first" }, { label: "second" }],
			totalCount: 860,
		});
		expect(await readLabelCatalogPage(api, { offset: 0 })).toMatchObject({
			nextOffset: 2,
			totalCount: 860,
		});
		list.mockResolvedValue({ items: [], totalCount: 860 });
		await expect(
			readLabelCatalogPage(api, { offset: 2, totalCount: 860 }),
		).rejects.toThrow();
	});
	it("rejects unexpected rows in an exact lookup before reading any daily metrics", async () => {
		const { api, daily } = provider();
		await expect(
			readLabelUsage(api, account, "missing", "2026-10-01", "2026-10-01"),
		).rejects.toThrow(/Invalid statistics label page/);
		expect(daily).not.toHaveBeenCalled();
	});
	it.each([
		["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00Z"],
		["2026-09-30T20:00:00-04:00", "2026-10-01T09:00:00+09:00"],
	])("normalizes wire day and label ISO dates to the same UTC date (%s)", async (date, labelDate) => {
		const { api, wire } = wireApi([
			{
				date,
				labels: [{ label: "customer-a", date: labelDate, bytesEncoded: 0 }],
			},
		]);
		const result = await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-10-01",
			"2026-10-01",
			wire.take,
		);
		expect(result.days[0]).toEqual({
			date: "2026-10-01",
			bytesEncoded: 0,
			billableEncodingMinutes: null,
			billableEgressBytes: null,
		});
	});
	it.each([
		["2026-02-30", undefined],
		["2026-02-30T00:00:00Z", undefined],
		["2026-10-01", "2026-10-02T00:00:00Z"],
		["2026-10-01T00:00:00", undefined],
	])("rejects invalid, unzoned or inconsistent wire dates (%s)", async (date, labelDate) => {
		const { api, wire } = wireApi([
			{
				date,
				labels: [
					{ label: "customer-a", ...(labelDate ? { date: labelDate } : {}) },
				],
			},
		]);
		await expect(
			readLabelUsage(
				api,
				account,
				"customer-a",
				"2026-10-01",
				"2026-10-01",
				wire.take,
			),
		).rejects.toThrow();
	});
	it("keeps concurrent account requests and their wire metric presence isolated", async () => {
		const transport = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (url, init) => {
				const id = new Headers(init?.headers).get("X-Tenant-Org-Id");
				return wireResponse(
					String(url).includes("/daily/")
						? [
								{
									date: "2026-10-01",
									labels: [
										{
											label: "customer-a",
											bytesEncoded: id === "account-a" ? 1 : 2,
											...(id === "account-a"
												? {
														billableEncodingMinutes: [],
														billableEgressBytes: [],
													}
												: {}),
										},
									],
								},
							]
						: [{ label: "customer-a" }],
				);
			});
		try {
			const ctx = {
				bitmovinAccounts: {
					get: async (id: string) => ({ tenantOrgId: id }),
					revealApiKey: async () => "test-key",
				},
			} as never;
			const requests = ["account-a", "account-b"].map(async (id) => {
				const wire = labelStatisticsWireReader(),
					signal = new AbortController().signal;
				const api = await bitmovinClientForAccount(
					ctx,
					id,
					signal,
					wire.observe,
				);
				if (!api) throw new Error("Missing test client");
				return readLabelUsage(
					api,
					{ id, label: id },
					"customer-a",
					"2026-10-01",
					"2026-10-01",
					wire.take,
				);
			});
			const [a, b] = await Promise.all(requests);
			expect(a?.totals).toEqual({
				billableEncodingMinutes: 0,
				billableEgressBytes: 0,
				bytesEncoded: 1,
			});
			expect(b?.totals).toEqual({
				billableEncodingMinutes: null,
				billableEgressBytes: null,
				bytesEncoded: 2,
			});
			expect(a?.account.id).toBe("account-a");
			expect(b?.account.id).toBe("account-b");
			expect(
				transport.mock.calls.every(
					([, init]) => init?.signal instanceof AbortSignal,
				),
			).toBe(true);
		} finally {
			transport.mockRestore();
		}
	});
	it("consumes one bounded wire page once and refuses an overlapping read", async () => {
		const wire = labelStatisticsWireReader();
		const results = await Promise.allSettled([
			wire.observe(dailyUrl, wireResponse([])),
			wire.observe(dailyUrl, wireResponse([])),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		await expect(wire.observe(dailyUrl, wireResponse([]))).rejects.toThrow(
			/not consumed/,
		);
		expect(wire.take()).toEqual({ items: [], totalCount: 0 });
		expect(() => wire.take()).toThrow(/missing/);
		await expect(
			wire.observe(
				dailyUrl,
				wireResponse(Array.from({ length: 101 }, () => ({}))),
			),
		).rejects.toThrow();
		await expect(
			wire.observe(dailyUrl, wireResponse([], 1001)),
		).rejects.toThrow();
	});
	it.each([
		false,
		true,
	])("preserves omitted metric arrays versus explicit empty arrays through the real SDK (empty=%s)", async (empty) => {
		const wire = labelStatisticsWireReader();
		const api = new BitmovinApi({
			apiKey: "test-key",
			fetch: async (url) => {
				const response = new Response(
					JSON.stringify({
						data: {
							result: {
								items: String(url).includes("/daily/")
									? [
											{
												date: "2026-10-01",
												labels: [
													{
														label: "customer-a",
														bytesEncoded: 0,
														...(empty
															? {
																	billableEncodingMinutes: [],
																	billableEgressBytes: [],
																}
															: {}),
													},
												],
											},
										]
									: [{ label: "customer-a" }],
								totalCount: 1,
								limit: 100,
								offset: 0,
							},
						},
					}),
					{ status: 200 },
				);
				await wire.observe(String(url), response);
				return response;
			},
		});
		const result = await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-10-01",
			"2026-10-01",
			wire.take,
		);
		expect(result.totals.billableEncodingMinutes).toBe(empty ? 0 : null);
		expect(result.totals.billableEgressBytes).toBe(empty ? 0 : null);
		expect(result.coverage.missingDays).toBe(empty ? 0 : 1);
	});

	it("uses the real SDK GET transport for exact label, account and calendar dates", async () => {
		const transport = vi.fn(
			async (url: string) =>
				new Response(
					JSON.stringify({
						data: {
							result: {
								items: url.includes("/daily/")
									? [
											{
												date: "2026-10-01",
												labels: [
													{
														label: "customer-a",
														bytesEncoded: 0,
														billableEncodingMinutes: [],
														billableEgressBytes: [],
													},
												],
											},
										]
									: [{ label: "customer-a" }],
								totalCount: 1,
								limit: 100,
								offset: 0,
							},
						},
					}),
					{ status: 200 },
				),
		);
		const api = new BitmovinApi({
			apiKey: "test-key",
			tenantOrgId: "test-tenant",
			fetch: transport,
		});
		const result = await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-10-01",
			"2026-10-01",
		);
		expect(result.totals.billableEncodingMinutes).toBe(0);
		const catalogUrl = new URL(transport.mock.calls[0]?.[0] ?? "http://test");
		expect(catalogUrl.pathname).toBe("/v1/encoding/statistics/labels");
		expect(catalogUrl.searchParams.get("labels")).toBe("customer-a");
		const [url, options] = transport.mock.calls[1] as unknown as [
			string,
			RequestInit,
		];
		const parsed = new URL(url);
		expect(parsed.pathname).toBe(
			"/v1/encoding/statistics/labels/daily/2026-10-01/2026-10-01",
		);
		expect(parsed.searchParams.get("labels")).toBe("customer-a");
		expect(parsed.searchParams.get("limit")).toBe("100");
		expect(options.method).toBe("GET");
		expect(new Headers(options.headers).get("X-Tenant-Org-Id")).toBe(
			"test-tenant",
		);
	});
	it("paginates the account's label catalog to exhaustion at limit 100", async () => {
		const { api, list } = provider();
		list
			.mockResolvedValueOnce({
				items: Array.from({ length: 100 }, (_, i) => ({
					label: `customer-${i}`,
				})),
				totalCount: 101,
			})
			.mockResolvedValueOnce({ items: [{ label: "last" }], totalCount: 101 });
		expect(await readLabelCatalog(api)).toHaveLength(101);
		expect(list.mock.calls).toEqual([
			[{ limit: 100, offset: 0 }],
			[{ limit: 100, offset: 100 }],
		]);
	});
	it("reads nine delayed catalog pages with at most three concurrent requests", async () => {
		const { api, list } = provider();
		vi.useFakeTimers();
		try {
			let active = 0;
			let maximum = 0;
			list.mockImplementation(async ({ offset }: { offset: number }) => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 2000));
				active -= 1;
				return {
					items: Array.from(
						{ length: Math.min(100, 860 - offset) },
						(_, i) => ({ label: `label-${offset + i}` }),
					),
					totalCount: 860,
				};
			});
			const start = Date.now();
			const result = readLabelCatalog(api);
			await vi.advanceTimersByTimeAsync(8000);
			expect(await result).toHaveLength(860);
			expect(Date.now() - start).toBe(8000);
			expect(maximum).toBe(3);
			expect(list.mock.calls.map((call) => call[0].offset)).toEqual([
				0, 100, 200, 300, 400, 500, 600, 700, 800,
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("discards later catalog prefetches after a short page and never skips labels", async () => {
		const { api, list } = provider();
		list.mockImplementation(async ({ offset }: { offset: number }) => ({
			items: Array.from(
				{ length: offset === 100 ? 50 : Math.min(100, 260 - offset) },
				(_, i) => ({ label: `label-${offset + i}` }),
			),
			totalCount: 260,
		}));
		expect(await readLabelCatalog(api)).toEqual(
			Array.from({ length: 260 }, (_, i) => `label-${i}`).sort((a, b) =>
				a.localeCompare(b),
			),
		);
		expect(list.mock.calls.map((call) => call[0].offset)).toEqual([
			0, 100, 200, 150, 250,
		]);
	});
	it("refuses a totalCount change in any prefetched catalog page", async () => {
		const { api, list } = provider();
		list.mockImplementation(async ({ offset }: { offset: number }) => ({
			items: Array.from({ length: Math.min(100, 260 - offset) }, (_, i) => ({
				label: `label-${offset + i}`,
			})),
			totalCount: offset === 200 ? 261 : 260,
		}));
		await expect(readLabelCatalog(api)).rejects.toThrow(/pagination changed/);
	});
	it("keeps short-page fallback within the total twenty-request budget", async () => {
		const { api, list } = provider();
		list.mockImplementation(async ({ offset }: { offset: number }) => ({
			items: Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) => ({
				label: `label-${offset + i}`,
			})),
			totalCount: 860,
		}));
		await expect(readLabelCatalog(api)).rejects.toThrow(/page limit reached/);
		expect(list).toHaveBeenCalledTimes(20);
	});
	it.each([
		{ items: [], totalCount: 2 },
		{ items: [{ label: "same" }, { label: "same" }], totalCount: 2 },
		{ items: [{ label: "first" }] },
		{ items: [], totalCount: 1001 },
	])("rejects incomplete, duplicate and unbounded catalogs", async (page) => {
		const { api, list } = provider();
		list.mockResolvedValue(page);
		await expect(readLabelCatalog(api)).rejects.toThrow();
	});
	it("requires the exact selected label to exist in the selected account", async () => {
		const { api, daily, list } = provider();
		list.mockResolvedValue({ items: [], totalCount: 0 });
		await expect(
			readLabelUsage(
				api,
				account,
				"another-account-label",
				"2026-10-01",
				"2026-10-01",
			),
		).rejects.toMatchObject({ status: 404 });
		expect(daily).not.toHaveBeenCalled();
	});
	it("uses one label name, bounded 25-day windows and local-calendar SDK path dates", async () => {
		const { api, daily } = provider();
		const data = await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-09-01",
			"2026-09-30",
		);
		expect(data.account).toEqual(account);
		expect(data.coverage.missingDays).toBe(30);
		expect(data.totals.bytesEncoded).toBeNull();
		expect(daily.mock.calls).toEqual([
			[
				new Date(2026, 8, 1),
				new Date(2026, 8, 25),
				{ labels: "customer-a", limit: 100, offset: 0 },
			],
			[
				new Date(2026, 8, 26),
				new Date(2026, 8, 30),
				{ labels: "customer-a", limit: 100, offset: 0 },
			],
		]);
	});
	it("continues a short page when totalCount says more daily records remain", async () => {
		const { api, daily } = provider();
		daily
			.mockResolvedValueOnce({
				items: [{ date: "2026-10-01", labels: [] }],
				totalCount: 2,
			})
			.mockResolvedValueOnce({
				items: [{ date: "2026-10-02", labels: [] }],
				totalCount: 2,
			});
		await readLabelUsage(
			api,
			account,
			"customer-a",
			"2026-10-01",
			"2026-10-02",
		);
		expect(daily.mock.calls[1]?.[2]).toMatchObject({ offset: 1, limit: 100 });
	});
	it("rejects a day outside its own requested window", async () => {
		const { api, daily } = provider();
		daily.mockResolvedValueOnce({
			items: [{ date: "2026-09-26", labels: [] }],
			totalCount: 1,
		});
		await expect(
			readLabelUsage(api, account, "customer-a", "2026-09-01", "2026-09-30"),
		).rejects.toThrow();
	});
	it("rejects comma filters and oversized ranges before any provider read", async () => {
		const { api, list } = provider();
		await expect(
			readLabelUsage(api, account, "a,b", "2026-10-01", "2026-10-01"),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			readLabelUsage(api, account, "customer-a", "2026-01-01", "2026-10-01"),
		).rejects.toMatchObject({ status: 400 });
		expect(list).not.toHaveBeenCalled();
	});
});
