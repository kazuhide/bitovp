import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	accountClient: vi.fn(),
	context: vi.fn(),
	audit: vi.fn(),
	boundRun: vi.fn(),
	client: {
		list: vi.fn(),
		create: vi.fn(),
		get: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		latest: vi.fn(),
	},
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock("./aisa-live-sdk", () => ({
	aisaLivePreviewEnabled: mocks.enabled,
	aisaLiveClientForAccount: mocks.accountClient,
	AisaLiveError: class extends Error {
		constructor(
			readonly httpStatusCode: number,
			readonly code?: string,
		) {
			super("AISA request unavailable");
		}
	},
}));

import { evaluateRole } from "@/lib/auth/roles";
import {
	aisaAction,
	aisaCreate,
	aisaDetail,
	aisaIngest,
	aisaList,
	aisaResults,
} from "./aisa-live-routes";
import { AisaLiveError } from "./aisa-live-sdk";

const accountId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const analysisId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const encodingId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const outputId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const resource = {
	analysisId,
	encodingId,
	status: "CREATED",
	name: "Tennis preview",
};
const destination = { outputId, outputPath: "synthetic/analysis" };
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	producedAt: "2026-11-07T00:00:00.000Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: false,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 10,
	metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
	observations: [],
	keyMoments: [],
	sourceGaps: [],
};
const get = (suffix = "", query = "") =>
	new Request(
		`http://test/api/live/analyses${suffix}?bitmovinAccountId=${accountId}${query}`,
	);
const post = (body: unknown) =>
	new Request("http://test/api/live/analyses", {
		method: "POST",
		body: JSON.stringify(body),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.enabled.mockReturnValue(true);
	mocks.boundRun.mockResolvedValue(null);
	mocks.context.mockResolvedValue({
		bitmovinAccounts: {},
		prisma: { liveChannelRun: { findFirst: mocks.boundRun } },
	});
	mocks.accountClient.mockResolvedValue(mocks.client);
	mocks.client.get.mockResolvedValue(resource);
	mocks.client.create.mockResolvedValue(resource);
	mocks.client.start.mockResolvedValue({ ...resource, status: "QUEUED" });
	mocks.client.stop.mockResolvedValue({ ...resource, status: "RUNNING" });
	mocks.client.latest.mockResolvedValue(snapshot);
	mocks.client.list.mockResolvedValue({ items: [resource], totalCount: 1 });
});

describe("AISA Live Preview routes", () => {
	it("prevents legacy actions from bypassing the persisted channel lifecycle", async () => {
		mocks.boundRun.mockResolvedValue({ id: "bound-run" });
		const response = await aisaAction(
			post({ bitmovinAccountId: accountId, action: "stop" }),
			analysisId,
		);
		expect(response.status).toBe(409);
		expect(mocks.client.get).not.toHaveBeenCalled();
		expect(mocks.client.stop).not.toHaveBeenCalled();
	});
	it("does not reveal publisher coordinates for a different run encoding", async () => {
		mocks.client.get.mockResolvedValue({
			...resource,
			status: "RUNNING",
			rtmpIngest: { encoderIp: "192.0.2.3", streamKey: "synthetickey" },
		});
		const response = await aisaIngest(
			get("", "&encodingId=dddddddd-dddd-4ddd-addd-dddddddddddd"),
			analysisId,
		);
		expect(response.status).toBe(409);
		expect(JSON.stringify(await response.json())).not.toContain("synthetickey");
	});
	it("hides every endpoint before account resolution when disabled", async () => {
		mocks.enabled.mockReturnValue(false);
		const responses = await Promise.all([
			aisaList(get()),
			aisaCreate(post(null)),
			aisaDetail(get(), analysisId),
			aisaAction(post(null), analysisId),
			aisaResults(get(), analysisId),
			aisaIngest(get(), analysisId),
		]);
		expect(responses.map((r) => r.status)).toEqual([
			404, 404, 404, 404, 404, 404,
		]);
		expect(mocks.context).not.toHaveBeenCalled();
	});
	it("rejects invalid identifiers and unknown tenant accounts before vendor reads", async () => {
		expect((await aisaDetail(get(), "not-a-uuid")).status).toBe(400);
		expect(
			(
				await aisaList(
					new Request("http://test/api/live/analyses?bitmovinAccountId=bad"),
				)
			).status,
		).toBe(400);
		expect(mocks.accountClient).not.toHaveBeenCalled();
		mocks.accountClient.mockResolvedValue(null);
		expect((await aisaList(get())).status).toBe(404);
		expect(mocks.client.list).not.toHaveBeenCalled();
	});
	it("bounds paging and allowlists list and detail fields", async () => {
		mocks.client.list.mockResolvedValue({
			items: [
				{ ...resource, apiKey: "secret", rtmpIngest: { streamKey: "secret" } },
			],
			totalCount: 1,
		});
		const response = await aisaList(get("", "&limit=500"));
		expect(mocks.client.list).toHaveBeenCalledWith({ offset: 0, limit: 100 });
		expect(JSON.stringify(await response.json())).not.toContain("secret");
		mocks.client.get.mockResolvedValue({
			...resource,
			rtmpIngest: { streamKey: "secret" },
		});
		const detail = await aisaDetail(get(), analysisId);
		expect(await detail.json()).toEqual(resource);
		expect(detail.headers.get("Cache-Control")).toContain("no-store");
	});
	it("rejects detail and result identity mismatches", async () => {
		mocks.client.get.mockResolvedValueOnce({
			...resource,
			analysisId: outputId,
		});
		expect((await aisaDetail(get(), analysisId)).status).toBe(502);
		mocks.client.latest.mockResolvedValueOnce({
			...snapshot,
			encodingId: outputId,
		});
		expect((await aisaResults(get(), analysisId)).status).toBe(502);
	});
	it("treats only the explicit no-result code as pending after checking resource access", async () => {
		mocks.client.latest.mockRejectedValueOnce(
			new AisaLiveError(404, "LIVE_ANALYSIS_RESULT_NOT_AVAILABLE"),
		);
		const pending = await aisaResults(get(), analysisId);
		expect(await pending.json()).toEqual({ availability: "pending" });
		expect(mocks.client.get).toHaveBeenCalledWith(analysisId);
		mocks.client.latest.mockRejectedValueOnce(new AisaLiveError(404));
		expect((await aisaResults(get(), analysisId)).status).toBe(404);
		mocks.client.get.mockRejectedValueOnce(new AisaLiveError(404));
		mocks.client.latest.mockClear();
		expect((await aisaResults(get(), analysisId)).status).toBe(404);
		expect(mocks.client.latest).not.toHaveBeenCalled();
	});
	it("returns cumulative results and discards unexpected upstream secrets", async () => {
		mocks.client.latest.mockResolvedValue({
			...snapshot,
			key: "secret",
			metadata: { ...snapshot.metadata, token: "secret" },
		});
		const response = await aisaResults(get(), analysisId);
		expect(await response.json()).toEqual({
			availability: "available",
			snapshot,
		});
	});
	it("creates once and keeps source credentials out of the audit", async () => {
		const analysis = {
			name: "Tennis preview",
			input: {
				type: "HLS",
				url: "https://example.org/live.m3u8?signature=PRIVATE",
			},
			recording: {
				outputs: [{ ...destination, outputPath: "synthetic/recording" }],
			},
			outputs: [destination],
		};
		const response = await aisaCreate(
			post({ bitmovinAccountId: accountId, analysis }),
		);
		expect(response.status).toBe(201);
		expect(mocks.client.create).toHaveBeenCalledExactlyOnceWith(analysis);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("PRIVATE");
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("live.m3u8");
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
	it("enforces lifecycle states and forwards start overrides separately", async () => {
		const request = post({
			bitmovinAccountId: accountId,
			action: "start",
			esVersion: "develop-test",
		});
		expect((await aisaAction(request, analysisId)).status).toBe(200);
		expect(mocks.accountClient).toHaveBeenCalledWith(
			expect.anything(),
			accountId,
			{ esVersion: "develop-test" },
		);
		expect(mocks.client.start).toHaveBeenCalledExactlyOnceWith(analysisId);
		mocks.client.get.mockResolvedValue({ ...resource, status: "RUNNING" });
		expect(
			(
				await aisaAction(
					post({ bitmovinAccountId: accountId, action: "start" }),
					analysisId,
				)
			).status,
		).toBe(409);
		expect(mocks.client.start).toHaveBeenCalledTimes(1);
		expect(
			(
				await aisaAction(
					post({ bitmovinAccountId: accountId, action: "stop" }),
					analysisId,
				)
			).status,
		).toBe(200);
	});
	it("audits uncertain outcomes without automatically retrying the mutation", async () => {
		mocks.client.start.mockRejectedValue(new AisaLiveError(502));
		const response = await aisaAction(
			post({ bitmovinAccountId: accountId, action: "start" }),
			analysisId,
		);
		expect(response.status).toBe(502);
		expect(mocks.client.start).toHaveBeenCalledTimes(1);
		expect(mocks.audit.mock.calls[0]?.[1]).toMatchObject({ statusCode: 502 });
	});
	it("separates operator-only ingest reads from viewer result reads", () => {
		expect(
			evaluateRole("VIEWER", `/api/live/analyses/${analysisId}/ingest`, "GET")
				.allowed,
		).toBe(false);
		expect(
			evaluateRole("OPERATOR", `/api/live/analyses/${analysisId}/ingest`, "GET")
				.allowed,
		).toBe(true);
		expect(
			evaluateRole("VIEWER", `/api/live/analyses/${analysisId}/results`, "GET")
				.allowed,
		).toBe(true);
		expect(
			evaluateRole("VIEWER", `/api/live/analyses/${analysisId}/actions`, "POST")
				.allowed,
		).toBe(false);
	});
});
