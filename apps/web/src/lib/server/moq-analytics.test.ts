import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	run: vi.fn(),
	store: vi.fn(),
	audit: vi.fn(),
	client: vi.fn(),
	query: vi.fn(),
	settings: vi.fn(),
}));
vi.mock("./moq-observations", async (original) => ({
	...(await original<typeof import("./moq-observations")>()),
	moqObservationContext: mocks.context,
	readMoqObservationRun: mocks.run,
	parseMoqObservationStore: mocks.store,
	auditMoqHistory: mocks.audit,
}));
vi.mock("./bitmovin", () => ({ bitmovinClientForAccount: mocks.client }));
vi.mock("./player-config", () => ({ readPlayerSettings: mocks.settings }));

import { getMoqAnalytics } from "./moq-analytics";

const id = "b0fb2928-b14d-46b3-ae6d-1b16f4718c94",
	runId = "56233f56-aa9f-41d3-b162-51ccdd9006fb",
	encodingId = "1dddf95f-8373-42fa-9267-c2a966dfe843",
	impressionId = "e95fbd1b-d81b-4691-9de5-a113f2442970",
	accountId = "be162edd-9f5f-4d53-a273-3976fa3d056f";
const params = { id, runId };
const videoId = `bitovp-moq:${encodingId}:${runId}`;
const licenseKey = "private-test-license";
const session = {
	analyticsImpressionId: impressionId,
	analyticsVideoId: videoId,
	analyticsLicenseKeySha256: createHash("sha256")
		.update(licenseKey)
		.digest("hex"),
	createdAt: "2026-11-18T01:00:05.000Z",
	updatedAt: "2026-11-18T01:00:20.000Z",
};
const request = (query = `impressionId=${impressionId}`) =>
	new Request(
		`http://localhost/api/live-channels/${id}/runs/${runId}/moq-analytics?${query}`,
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.context.mockResolvedValue({ tenant: { role: "OPERATOR" } });
	mocks.run.mockResolvedValue({
		id: runId,
		bitmovinEncodingId: encodingId,
		originalBitmovinAccountId: accountId,
		moqObservations: {},
	});
	mocks.store.mockReturnValue({ sessions: [session] });
	mocks.audit.mockResolvedValue(undefined);
	mocks.settings.mockResolvedValue({ analyticsLicenseKey: licenseKey });
	mocks.client.mockResolvedValue({
		analytics: { queries: { count: { create: mocks.query } } },
	});
	mocks.query.mockResolvedValue({
		rows: [["1234", "2026-11-18T01:00:10.000Z", 1]],
		rowCount: 1,
	});
});

describe("run-bound Analytics custom latency readback", () => {
	it("uses original account plus saved license and exact immutable run, encoding, video and impression filters", async () => {
		const response = await getMoqAnalytics(request(), params);
		expect(response.status).toBe(200);
		expect(mocks.context).toHaveBeenCalledWith(
			expect.any(Request),
			params,
			false,
			["impressionId"],
		);
		expect(mocks.client).toHaveBeenCalledWith(
			expect.anything(),
			accountId,
			expect.any(AbortSignal),
		);
		const query = mocks.query.mock.calls[0]?.[0];
		expect(query).toMatchObject({
			licenseKey,
			dimension: "IMPRESSION_ID",
			groupBy: ["CUSTOM_DATA_1", "CUSTOM_DATA_3"],
			limit: 200,
			offset: 0,
		});
		expect(query.filters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "VIDEO_ID",
					operator: "EQ",
					value: videoId,
				}),
				expect.objectContaining({
					name: "IMPRESSION_ID",
					operator: "EQ",
					value: impressionId,
				}),
				expect.objectContaining({
					name: "CUSTOM_DATA_2",
					operator: "EQ",
					value: "moq-source-barcode",
				}),
				expect.objectContaining({
					name: "CUSTOM_DATA_4",
					operator: "EQ",
					value: runId,
				}),
				expect.objectContaining({
					name: "CUSTOM_DATA_5",
					operator: "EQ",
					value: encodingId,
				}),
			]),
		);
		expect(await response.json()).toMatchObject({
			runId,
			encodingId,
			impressionId,
			videoId,
			source: "bitmovin-analytics-custom-data",
			measurement: "moq-source-barcode",
			nativeLatency: false,
			unit: "ms",
			points: [{ observedAt: "2026-11-18T01:00:10.000Z", latencyMs: 1234 }],
			truncated: false,
		});
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("rejects duplicate, missing or malformed IDs before querying Analytics", async () => {
		for (const query of [
			"",
			"impressionId=bad",
			`impressionId=${impressionId}&impressionId=${impressionId}`,
		]) {
			expect((await getMoqAnalytics(request(query), params)).status).toBe(400);
		}
		expect(mocks.client).not.toHaveBeenCalled();
	});

	it("requires the impression to be stored in this run and refuses mismatched immutable video metadata", async () => {
		mocks.store.mockReturnValue({ sessions: [] });
		expect((await getMoqAnalytics(request(), params)).status).toBe(409);
		mocks.store.mockReturnValue({
			sessions: [{ ...session, analyticsVideoId: "other-run" }],
		});
		expect((await getMoqAnalytics(request(), params)).status).toBe(409);
		expect(mocks.client).not.toHaveBeenCalled();
	});
	it("requires the current license to match the immutable digest and never falls back to a changed key", async () => {
		mocks.settings.mockResolvedValue({
			analyticsLicenseKey: "changed-license",
		});
		expect((await getMoqAnalytics(request(), params)).status).toBe(409);
		expect(mocks.client).not.toHaveBeenCalled();
	});

	it("projects only bounded numeric latency and UTC observations, never raw provider fields or missing as zero", async () => {
		mocks.query.mockResolvedValue({
			rows: [
				["0", "2026-11-18T01:00:10.000Z", 1],
				["2", "2026-11-18T01:00:11.000Z", 1, "SECRET"],
				["SECRET", "2026-11-18T01:00:12.000Z", 1],
				["NaN", "2026-11-18T01:00:13.000Z", 1],
				["-1", "2026-11-18T01:00:14.000Z", 1],
				["10", "bad-time", 1],
				["10", "2020-01-01T00:00:00.000Z", 1],
			],
			rowCount: 7,
			ipAddress: "SECRET",
			url: "SECRET",
		});
		const response = await getMoqAnalytics(request(), params),
			value = await response.json();
		expect(value.points).toEqual([
			{ observedAt: "2026-11-18T01:00:10.000Z", latencyMs: 0 },
		]);
		expect(JSON.stringify(value)).not.toContain("SECRET");
		expect(JSON.stringify(value)).not.toContain("private-test-license");
	});

	it("reports no matches as pending, not measured zero, and fails closed on upstream errors", async () => {
		mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
		const value = await (await getMoqAnalytics(request(), params)).json();
		expect(value).toMatchObject({ status: "pending", points: [] });
		mocks.query.mockRejectedValue(new Error("SECRET provider request"));
		const response = await getMoqAnalytics(request(), params);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("SECRET");
	});
});
