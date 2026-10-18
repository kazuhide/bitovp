import { beforeEach, describe, expect, it, vi } from "vitest";

const accountId = "11111111-1111-4111-8111-111111111111";
const clientForAccount = vi.fn();
const readCatalog = vi.fn();
const readUsage = vi.fn();
const stored = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: {
			get: async (id: string) =>
				id === accountId
					? {
							id,
							updatedAt: new Date("2026-10-04"),
							tenantOrgId: "main-tenant",
						}
					: null,
		},
		prisma: {
			bitmovinAccount: {
				findMany: async () => [{ id: accountId, label: "Main" }],
			},
			usageDailyStatistic: { findMany: stored },
			usageSweepCursor: { findMany: stored },
		},
	}),
}));
vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: (...args: unknown[]) => clientForAccount(...args),
}));
vi.mock("@/lib/server/statistics-labels", async (original) => ({
	...(await original<object>()),
	readLabelCatalogPage: (...args: unknown[]) => readCatalog(...args),
	readLabelUsage: (...args: unknown[]) => readUsage(...args),
}));

import {
	LabelCatalogRestartError,
	LabelStatisticsError,
} from "@/lib/server/statistics-labels";
import { GET as LABELS } from "./labels/route";
import { GET } from "./route";

const request = (query: string) =>
	new Request(`http://test/api/dashboard/usage?${query}`);
beforeEach(() => {
	vi.clearAllMocks();
	clientForAccount.mockResolvedValue({ marker: "account-provider" });
	readCatalog.mockResolvedValue({
		labels: ["customer-a"],
		offset: 0,
		totalCount: 860,
		nextOffset: 1,
		source: "PROVIDER",
		readAt: "2026-10-04T00:00:00Z",
	});
	readUsage.mockResolvedValue({
		scope: "LABEL",
		label: "customer-a",
		days: [],
	});
});
describe("account-scoped label statistics routes", () => {
	it("reads the selected label through its account without touching account-wide stored snapshots", async () => {
		const res = await GET(
			request(
				`accountId=${accountId}&label=customer-a&from=2026-01-01&to=2026-01-07`,
			),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			scope: "LABEL",
			label: "customer-a",
		});
		expect(readUsage).toHaveBeenCalledWith(
			{ marker: "account-provider" },
			{ id: accountId, label: "Main" },
			"customer-a",
			"2026-01-01",
			"2026-01-07",
			expect.any(Function),
		);
		expect(clientForAccount.mock.calls[0]?.[1]).toBe(accountId);
		expect(clientForAccount.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
		expect(clientForAccount.mock.calls[0]?.[3]).toBeInstanceOf(Function);
		expect(stored).not.toHaveBeenCalled();
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});
	it.each([
		"label=a",
		`accountId=${accountId}&label=a,b`,
		`accountId=${accountId}&label=a&label=b`,
	])("rejects ambiguous label selection before any provider read", async (query) => {
		expect((await GET(request(query))).status).toBe(400);
		expect(clientForAccount).not.toHaveBeenCalled();
	});
	it("uses stable provider errors without SDK secret text", async () => {
		readUsage.mockRejectedValue({
			message: "apiKey=secret provider request body",
			httpStatusCode: 401,
		});
		const res = await GET(request(`accountId=${accountId}&label=customer-a`));
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Label statistics unavailable" });
	});
	it("returns a missing account or label as 404", async () => {
		expect(
			(
				await GET(
					request(
						"accountId=22222222-2222-4222-8222-222222222222&label=customer-a",
					),
				)
			).status,
		).toBe(404);
		readUsage.mockRejectedValue(
			new LabelStatisticsError(
				404,
				"Statistics label not found for this account",
			),
		);
		expect(
			(await GET(request(`accountId=${accountId}&label=missing`))).status,
		).toBe(404);
	});
	it.each([
		[400, "Label statistics support one label and at most 90 days"],
		[404, "Statistics label not found for this account"],
		[502, "Label statistics unavailable"],
	] as const)("maps typed status %s without forwarding raw prose", async (status, error) => {
		readUsage.mockRejectedValue(
			new LabelStatisticsError(status, "apiKey=secret provider request body"),
		);
		const res = await GET(request(`accountId=${accountId}&label=customer-a`));
		expect(res.status).toBe(status);
		expect(await res.json()).toEqual({ error });
	});
	it("lists labels for exactly one account with private responses", async () => {
		const res = await LABELS(request(`accountId=${accountId}`));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			labels: ["customer-a"],
			totalCount: 860,
			nextOffset: 1,
		});
		expect(readCatalog).toHaveBeenCalledWith(
			{ marker: "account-provider" },
			{
				offset: 0,
				cacheScope: JSON.stringify([
					accountId,
					"2026-10-04T00:00:00.000Z",
					"main-tenant",
				]),
			},
		);
		expect(clientForAccount.mock.calls[0]?.[1]).toBe(accountId);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect((await LABELS(request(""))).status).toBe(400);
	});
	it("forwards only bounded offset, expected count and exact label filters", async () => {
		expect(
			(
				await LABELS(
					request(`accountId=${accountId}&offset=100&totalCount=860`),
				)
			).status,
		).toBe(200);
		expect(readCatalog.mock.calls[0]?.[1]).toMatchObject({
			offset: 100,
			totalCount: 860,
		});
		expect(
			(await LABELS(request(`accountId=${accountId}&label=customer-a`))).status,
		).toBe(200);
		expect(readCatalog.mock.calls[1]?.[1]).toMatchObject({
			offset: 0,
			label: "customer-a",
		});
	});
	it("allows only an explicit fresh offset-zero restart and exposes a sanitized drift hint", async () => {
		expect(
			(await LABELS(request(`accountId=${accountId}&offset=0&refresh=1`)))
				.status,
		).toBe(200);
		expect(readCatalog.mock.calls[0]?.[1]).toMatchObject({
			offset: 0,
			refresh: true,
		});
		readCatalog.mockRejectedValueOnce(
			new LabelCatalogRestartError("secret-provider-body"),
		);
		const response = await LABELS(
			request(`accountId=${accountId}&offset=100&totalCount=860`),
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Statistics labels unavailable",
			details: { restart: true },
		});
	});
	it.each([
		"offset=-1",
		"offset=1000",
		"offset=1&label=a",
		"label=a,b",
		"offset=0&offset=100",
		"totalCount=1001",
		"unknown=a",
		"refresh=true",
		"refresh=1&offset=1",
		"refresh=1&label=a",
		"refresh=1&totalCount=861",
	])("rejects invalid catalog pagination before resolving an SDK client (%s)", async (query) => {
		expect(
			(await LABELS(request(`accountId=${accountId}&${query}`))).status,
		).toBe(400);
		expect(clientForAccount).not.toHaveBeenCalled();
	});
});
