import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	provenance: vi.fn(),
	account: vi.fn(),
	audit: vi.fn(),
	summary: vi.fn(),
	events: vi.fn(),
	streams: vi.fn(),
	srt: vi.fn(),
	srtInput: vi.fn(),
	final: vi.fn(),
	hdStart: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannelRun: { findFirst: mocks.run },
			auditLog: { findMany: mocks.provenance },
		},
	}),
}));
vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: mocks.account,
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: mocks.audit }));

import { GET as finalGET } from "../final-heartbeat/route";
import { GET } from "./route";

const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const ENCODING = "00000000-0000-4000-8000-000000000003";
const ACCOUNT = "00000000-0000-4000-8000-000000000004";
const INPUT = "00000000-0000-4000-8000-000000000005";
const time = "2026-10-01T00:00:00.000Z";
const context = () => ({
	params: Promise.resolve({ id: CHANNEL, runId: RUN }),
});
const request = (query = "") =>
	new Request(
		`http://test/api/live-channels/${CHANNEL}/runs/${RUN}/diagnostics${query}`,
		{ headers: { "x-bitovp-actor": "tester" } },
	);

beforeEach(() => {
	vi.resetAllMocks();
	mocks.run.mockResolvedValue({
		id: RUN,
		status: "RUNNING",
		endedAt: null,
		bitmovinEncodingId: ENCODING,
	});
	mocks.provenance.mockResolvedValue([{ bitmovinAccountId: ACCOUNT }]);
	mocks.account.mockResolvedValue({
		encoding: {
			statistics: {
				encodings: {
					liveStatistics: {
						get: mocks.summary,
						events: { list: mocks.events },
						streams: { list: mocks.streams },
						srt: { list: mocks.srt, listBySrtInputId: mocks.srtInput },
					},
				},
			},
			encodings: {
				live: {
					heartbeatFinal: { get: mocks.final },
					hd: { getStartRequest: mocks.hdStart },
				},
			},
		},
	});
	mocks.summary.mockResolvedValue({
		status: "CONNECTED",
		events: [{ details: { message: "secret" } }],
		statistics: [{ password: "secret" }],
		orgId: "private",
	});
	for (const list of [mocks.events, mocks.streams, mocks.srt, mocks.srtInput])
		list.mockResolvedValue({ items: [], totalCount: 0 });
	mocks.final.mockResolvedValue({
		url: "https://provider.example/heartbeat?signature=secret",
	});
});

describe("run-bound provider diagnostics", () => {
	it("reports HD start provider errors without falling back to regular start or blank data", async () => {
		mocks.hdStart.mockRejectedValue(
			Object.assign(new Error("secret-key"), { httpStatusCode: 404 }),
		);
		const res = await GET(request("?kind=hd-start"), context());
		expect(res.status).toBe(404);
		expect(
			JSON.stringify([await res.json(), mocks.audit.mock.calls]),
		).not.toContain("secret-key");
		expect(mocks.summary).not.toHaveBeenCalled();
	});
	it("reads HD start details from the original account and whitelists secrets and URLs out of response and audit", async () => {
		mocks.hdStart.mockResolvedValue({
			streamKey: "secret-key",
			manifestGenerator: "V2",
			liveEncodingMode: "STANDARD",
			hlsManifests: [
				{
					manifestId: INPUT,
					timeshift: 600,
					liveEdgeOffset: 10,
					url: "https://secret",
				},
			],
			autoShutdownConfiguration: {
				streamTimeoutMinutes: 30,
				password: "secret",
			},
			esamSettings: { poisEndpoint: "https://secret" },
			unknown: "secret",
		});
		const res = await GET(request("?kind=hd-start"), context());
		expect(res.status).toBe(200);
		expect(mocks.hdStart).toHaveBeenCalledWith(ENCODING);
		expect(mocks.account).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
		const result = await res.json();
		expect(result.data).toEqual({
			manifestGenerator: "V2",
			liveEncodingMode: "STANDARD",
			hlsManifests: [{ manifestId: INPUT, timeshift: 600, liveEdgeOffset: 10 }],
			autoShutdownConfiguration: { streamTimeoutMinutes: 30 },
		});
		expect(JSON.stringify([result, mocks.audit.mock.calls])).not.toContain(
			"secret",
		);
		expect(mocks.audit.mock.calls[0]?.[1]?.path).toBe(
			`/encoding/encodings/${ENCODING}/live/hd/start`,
		);
	});
	it("uses the exact run and its original audit account, snapshots only safe summary and actor request", async () => {
		const req = request();
		const res = await GET(req, context());
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(await res.json()).toMatchObject({
			kind: "summary",
			runId: RUN,
			encodingId: ENCODING,
			data: { status: "CONNECTED" },
		});
		expect(mocks.run).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: RUN, liveChannelId: CHANNEL } }),
		);
		expect(mocks.account).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
		expect(mocks.summary).toHaveBeenCalledWith(ENCODING);
		expect(mocks.provenance).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					method: "POST",
					statusCode: { gte: 200, lt: 300 },
					OR: [
						{ path: `/encoding/encodings/${ENCODING}/live/start` },
						{ path: `/encoding/encodings/${ENCODING}/live/hd/start` },
						{
							path: "/encoding/encodings",
							response: { path: ["id"], equals: ENCODING },
						},
					],
				}),
			}),
		);
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				method: "GET",
				bitmovinAccountId: ACCOUNT,
				request: expect.objectContaining({
					liveChannelId: CHANNEL,
					runId: RUN,
				}),
				response: expect.objectContaining({ data: { status: "CONNECTED" } }),
			}),
			req,
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
	it.each([
		"?offset=-1",
		"?offset=1.5",
		"?limit=101",
		"?limit=0",
		"?limit=",
		"?offset=9007199254740992",
		"?kind=other",
		"?kind=final-heartbeat",
		`?bitmovinAccountId=${ACCOUNT}`,
		`?srtInputId=${INPUT}`,
		"?kind=srt&srtInputId=invalid",
		"?kind=srt&kind=events",
	])("rejects invalid or account-override query %s before DB/provider", async (query) => {
		expect((await GET(request(query), context())).status).toBe(400);
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.account).not.toHaveBeenCalled();
	});
	it("rejects invalid ids and missing or wrong-channel runs without provider calls", async () => {
		expect(
			(
				await GET(request(), {
					params: Promise.resolve({ id: CHANNEL, runId: "bad" }),
				})
			).status,
		).toBe(400);
		mocks.run.mockResolvedValue(null);
		expect((await GET(request(), context())).status).toBe(404);
		expect(mocks.account).not.toHaveBeenCalled();
	});
	it.each([
		{ rows: [] },
		{ rows: [{ bitmovinAccountId: null }] },
		{ rows: [{ bitmovinAccountId: ACCOUNT }, { bitmovinAccountId: INPUT }] },
	])("fails closed when original account evidence is missing or ambiguous: %j", async ({
		rows,
	}) => {
		mocks.provenance.mockResolvedValue(rows);
		expect((await GET(request(), context())).status).toBe(409);
		expect(mocks.account).not.toHaveBeenCalled();
	});
	it("does not borrow a current account if the historical account was removed", async () => {
		mocks.account.mockResolvedValue(null);
		expect((await GET(request(), context())).status).toBe(404);
		expect(mocks.summary).not.toHaveBeenCalled();
	});
	it("refuses a run without an encoding", async () => {
		mocks.run.mockResolvedValue({ id: RUN, bitmovinEncodingId: null });
		expect((await GET(request(), context())).status).toBe(409);
		expect(mocks.provenance).not.toHaveBeenCalled();
	});
	it("preserves event page counts/offsets while excluding messages and unknown nested fields", async () => {
		mocks.events.mockResolvedValue({
			items: [
				{
					time: new Date(time),
					details: {
						eventType: "RECONNECT",
						message: "password=secret",
						year: 2026,
						streamKey: "secret",
					},
				},
			],
			totalCount: 8,
		});
		const res = await GET(request("?kind=events&offset=3&limit=1"), context());
		expect(mocks.events).toHaveBeenCalledWith(ENCODING, {
			offset: 3,
			limit: 1,
		});
		expect(await res.json()).toMatchObject({
			kind: "events",
			offset: 3,
			limit: 1,
			totalCount: 8,
			nextOffset: 4,
			data: [{ time, details: { eventType: "RECONNECT", year: 2026 } }],
		});
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
	it("projects stream metrics and uses default paging", async () => {
		mocks.streams.mockResolvedValue({
			items: [
				{
					time,
					streamInfos: [
						{
							id: INPUT,
							mediaType: "VIDEO",
							codec: "H264",
							width: 1920,
							bytesReadPerSecondAvg: 12000,
							url: "secret",
							password: "secret",
						},
					],
				},
			],
			totalCount: 1,
		});
		const res = await GET(request("?kind=streams"), context());
		expect(mocks.streams).toHaveBeenCalledWith(ENCODING, {
			offset: 0,
			limit: 25,
		});
		expect(await res.json()).toMatchObject({
			kind: "streams",
			nextOffset: null,
			data: [
				{
					time,
					streamInfos: [
						{
							id: INPUT,
							mediaType: "VIDEO",
							codec: "H264",
							width: 1920,
							bytesReadPerSecondAvg: 12000,
						},
					],
				},
			],
		});
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
	it.each([
		false,
		true,
	])("projects SRT nested numeric metrics, input filter=%s", async (filtered) => {
		const list = filtered ? mocks.srtInput : mocks.srt;
		list.mockResolvedValue({
			items: [
				{
					id: INPUT,
					encodingId: ENCODING,
					srtInputId: INPUT,
					createdAt: new Date(time),
					srtInputSelected: true,
					orgId: "secret",
					userId: "secret",
					link: { rtt: 9, bandwidth: 10, password: "secret" },
					recv: { packetsLost: 2, bytes: "secret" },
					send: { packets: 9 },
					window: { flow: 5, token: "secret" },
				},
			],
			totalCount: 1,
		});
		const res = await GET(
			request(`?kind=srt${filtered ? `&srtInputId=${INPUT}` : ""}`),
			context(),
		);
		const args = filtered
			? [ENCODING, INPUT, { offset: 0, limit: 25 }]
			: [ENCODING, { offset: 0, limit: 25 }];
		expect(list).toHaveBeenCalledWith(...args);
		expect(await res.json()).toMatchObject({
			kind: "srt",
			data: [
				{
					createdAt: time,
					srtInputId: INPUT,
					link: { rtt: 9, bandwidth: 10 },
					recv: { packetsLost: 2 },
					send: { packets: 9 },
					window: { flow: 5 },
				},
			],
		});
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
	it("keeps an empty page's totalCount without inventing another cursor", async () => {
		mocks.events.mockResolvedValue({ items: [], totalCount: 10 });
		expect(
			await (await GET(request("?kind=events&offset=20"), context())).json(),
		).toMatchObject({ data: [], offset: 20, totalCount: 10, nextOffset: null });
	});
	it("refuses malformed provider pagination rather than silently losing history", async () => {
		mocks.events.mockResolvedValue({ items: [{}] });
		expect((await GET(request("?kind=events"), context())).status).toBe(502);
	});
	it.each([
		[404, 404],
		[409, 409],
		[401, 502],
		[429, 502],
		[500, 502],
	])("maps provider %s to %s without storing or exposing SDK error contents", async (upstream, expected) => {
		mocks.summary.mockRejectedValue({
			httpStatusCode: upstream,
			shortMessage: "signed?token=secret",
			message: "password=secret",
		});
		const res = await GET(request(), context());
		expect(res.status).toBe(expected);
		expect(await res.text()).not.toContain("secret");
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
});

describe("final heartbeat download capability", () => {
	beforeEach(() =>
		mocks.run.mockResolvedValue({
			id: RUN,
			status: "STOPPED",
			endedAt: new Date(time),
			bitmovinEncodingId: ENCODING,
		}),
	);
	it("returns an HTTPS URL only for an ended run and excludes it from audit storage", async () => {
		const req = request();
		const res = await finalGET(req, context());
		expect(res.status).toBe(200);
		expect(mocks.final).toHaveBeenCalledWith(ENCODING);
		expect(await res.json()).toMatchObject({
			kind: "final-heartbeat",
			runId: RUN,
			encodingId: ENCODING,
			data: { url: "https://provider.example/heartbeat?signature=secret" },
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: `/encoding/encodings/${ENCODING}/live/heartbeat-final`,
				response: expect.objectContaining({ data: { available: true } }),
			}),
			req,
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("secret");
	});
	it.each([
		"CREATED",
		"PROVISIONING",
		"RUNNING",
		"STOPPING",
	])("refuses %s before the provider call", async (status) => {
		mocks.run.mockResolvedValue({
			id: RUN,
			status,
			endedAt: new Date(time),
			bitmovinEncodingId: ENCODING,
		});
		expect((await finalGET(request(), context())).status).toBe(409);
		expect(mocks.final).not.toHaveBeenCalled();
	});
	it.each([
		"http://provider.example/file",
		"https://user:password@provider.example/file",
		"javascript:alert(1)",
	])("rejects unsafe URL %s", async (url) => {
		mocks.final.mockResolvedValue({ url });
		expect((await finalGET(request(), context())).status).toBe(502);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(url);
	});
	it("rejects account overrides on the final endpoint", async () => {
		expect(
			(await finalGET(request(`?bitmovinAccountId=${ACCOUNT}`), context()))
				.status,
		).toBe(400);
		expect(mocks.final).not.toHaveBeenCalled();
	});
});
