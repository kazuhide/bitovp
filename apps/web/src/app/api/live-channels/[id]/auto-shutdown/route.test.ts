import { createHash } from "node:crypto";
import {
	liveAutoShutdownFingerprint,
	liveChannelJobSchema,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	channel: vi.fn(),
	run: vi.fn(),
	claim: vi.fn(),
	latestClaim: vi.fn(),
	add: vi.fn(),
	getJob: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannel: { findUnique: mocks.channel },
			liveChannelRun: { findFirst: mocks.run },
			liveEffectClaim: {
				findUnique: mocks.claim,
				findFirst: mocks.latestClaim,
			},
		},
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: mocks.add, getJob: mocks.getJob }),
}));

import { GET, POST } from "./route";

const ID = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const REQUEST = "00000000-0000-4000-8000-000000000003";
const KEY = `manual:auto-shutdown:${ID}:${REQUEST}`;
const request = (over: Record<string, unknown> = {}) => ({
	runId: RUN,
	requestId: REQUEST,
	expectedRevision: null,
	configuration: { bytesReadTimeoutSeconds: 30, streamTimeoutMinutes: 5 },
	...over,
});
const post = (body = request(), id = ID) =>
	POST(
		new Request(`http://test/api/live-channels/${id}/auto-shutdown`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
const get = (requestId?: string) =>
	GET(
		new Request(
			`http://test/api/live-channels/${ID}/auto-shutdown?runId=${RUN}${requestId ? `&requestId=${requestId}` : ""}`,
		),
		{ params: Promise.resolve({ id: ID }) },
	);
type QueueJob = {
	data: unknown;
	returnvalue?: unknown;
	getState(): Promise<string>;
	remove(): Promise<void>;
};
const jobs = new Map<string, QueueJob>();
let run: Record<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	jobs.clear();
	run = {
		id: RUN,
		cancelRequested: false,
		bitmovinEncodingId: "encoding-1",
		stepLog: [
			{
				step: "start",
				kind: "START_LIVE_ENCODING",
				payload: {},
				refs: {},
				status: "DONE",
			},
		],
		providerStatus: "RUNNING",
		providerStatusObservedAt: new Date(),
		providerUnknownSince: null,
		providerTerminalAt: null,
	};
	mocks.channel.mockResolvedValue({
		id: ID,
		status: "RUNNING",
		bitmovinEncodingId: "encoding-1",
		liveEffectFenceVersion: 4,
	});
	mocks.run.mockImplementation(async () => run);
	mocks.claim.mockResolvedValue(null);
	mocks.latestClaim.mockResolvedValue(null);
	mocks.getJob.mockImplementation(async (id: string) => jobs.get(id) ?? null);
	mocks.add.mockImplementation(
		async (_name: string, data: unknown, opts: { jobId: string }) => {
			jobs.set(opts.jobId, {
				data,
				getState: async () => "waiting",
				remove: async () => {
					jobs.delete(opts.jobId);
				},
			});
		},
	);
});
afterEach(() => vi.unstubAllEnvs());

describe("running Live automatic stop route", () => {
	it("waits for a run-bound receipt when the claim becomes ACKED after the run snapshot was read", async () => {
		mocks.latestClaim.mockResolvedValue({
			idempotencyKey: KEY,
			state: "ACKED",
		});
		expect(await (await get(REQUEST)).json()).toMatchObject({
			request: { key: KEY, state: "AWAITING_RECEIPT" },
		});
	});
	it("does not invent disabled timers when the recorded start request is missing", async () => {
		run.stepLog = [];
		expect(await (await get()).json()).toMatchObject({ configuration: null });
	});
	it("can retry a completed delivery proved to have been refused before send", async () => {
		await post();
		const queued = jobs.values().next().value as QueueJob;
		queued.getState = async () => "completed";
		queued.returnvalue = {
			acknowledged: true,
			liveChannelId: ID,
			action: "update-auto-shutdown",
			status: "SKIPPED_STALE_GENERATION",
		};
		expect(await (await get(REQUEST)).json()).toMatchObject({
			request: { state: "FAILED" },
		});
		expect((await post()).status).toBe(202);
		expect(mocks.add).toHaveBeenCalledTimes(2);
	});
	it("does not redeliver a completed job with no proof of a pre-send refusal", async () => {
		await post();
		const queued = jobs.values().next().value as QueueJob;
		queued.getState = async () => "completed";
		queued.returnvalue = {
			acknowledged: true,
			liveChannelId: ID,
			action: "update-auto-shutdown",
			status: "EFFECT_AMBIGUOUS",
		};
		expect(await (await get(REQUEST)).json()).toMatchObject({
			request: { state: "AMBIGUOUS" },
		});
		expect((await post()).status).toBe(409);
		expect(mocks.add).toHaveBeenCalledTimes(1);
	});
	it("queues a normalized full replacement bound to the run, encoding, digest and generation", async () => {
		expect((await post()).status).toBe(202);
		const data = mocks.add.mock.calls[0]?.[1];
		expect(liveChannelJobSchema.parse(data)).toEqual({
			liveChannelId: ID,
			action: "update-auto-shutdown",
			params: {
				configuration: request().configuration,
				expectedRevision: null,
			},
			effect: {
				idempotencyKey: KEY,
				liveChannelRunId: RUN,
				providerEncodingId: "encoding-1",
				requestSha256: createHash("sha256")
					.update(liveAutoShutdownFingerprint(RUN, request().configuration))
					.digest("hex"),
				admissionFenceVersion: 4,
				action: "AUTO_SHUTDOWN_UPDATE",
			},
		});
		expect(mocks.add.mock.calls[0]?.[2]).toMatchObject({ attempts: 1 });
	});
	it("requires an explicit full replacement and expected revision, but accepts all timers disabled", async () => {
		expect((await post(request({ configuration: {} }))).status).toBe(202);
		const body = request();
		Reflect.deleteProperty(body, "expectedRevision");
		expect((await post(body)).status).toBe(400);
	});
	it.each([
		{ streamTimeoutMinutes: 4 },
		{ bytesReadTimeoutSeconds: 29 },
		{ waitingForFirstConnectTimeoutMinutes: 4 },
		{ streamTimeoutMinutes: 5.5 },
		{ streamTimeoutMinutes: null },
		{ unknown: 30 },
	])("refuses invalid timer configurations before queuing: %j", async (configuration) => {
		expect((await post(request({ configuration }))).status).toBe(400);
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it.each([
		"STOPPED",
		"ERROR",
		"PROVISIONING",
	])("refuses %s channels", async (status) => {
		mocks.channel.mockResolvedValue({
			status,
			bitmovinEncodingId: "encoding-1",
			liveEffectFenceVersion: 4,
		});
		expect((await post()).status).toBe(409);
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it.each([
		{ id: REQUEST },
		{ cancelRequested: true },
		{ bitmovinEncodingId: "encoding-2" },
		{ providerStatus: "FINISHED", providerTerminalAt: new Date() },
		{ providerStatusObservedAt: new Date(0) },
	])("refuses stale, canceled or unconfirmed runs: %j", async (patch) => {
		Object.assign(run, patch);
		expect((await post()).status).toBe(409);
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it("replays an identical queued request without adding a second delivery", async () => {
		await post();
		expect((await post()).status).toBe(202);
		expect(mocks.add).toHaveBeenCalledTimes(1);
	});
	it("rejects a queue identity collision and a concurrent winner with substituted values", async () => {
		await post();
		const queued = jobs.values().next().value as QueueJob;
		queued.data = { ...(queued.data as object), params: { configuration: {} } };
		expect((await post()).status).toBe(409);
		expect(mocks.add).toHaveBeenCalledTimes(1);
	});
	it("rejects an old form revision after a different accepted update", async () => {
		run.stepLog = [
			{
				step: "record",
				kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
				status: "DONE",
				refs: {},
				payload: {
					configuration: {},
					appliedAt: new Date().toISOString(),
					scheduledShutdownAt: null,
					requestId: "another-update",
				},
			},
		];
		expect((await post()).status).toBe(409);
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it.each([
		"AMBIGUOUS",
		"DISPATCHING",
		"CLAIMED",
		"RESOLVED",
	])("does not requeue a durable %s request", async (state) => {
		mocks.claim.mockResolvedValue({
			liveChannelId: ID,
			liveChannelRunId: RUN,
			providerEncodingId: "encoding-1",
			requestSha256: createHash("sha256")
				.update(liveAutoShutdownFingerprint(RUN, request().configuration))
				.digest("hex"),
			action: "AUTO_SHUTDOWN_UPDATE",
			state,
		});
		expect((await post()).status).toBe(409);
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it("reads queued status and local recorded settings without any provider call", async () => {
		await post();
		const result = await get(REQUEST);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			runId: RUN,
			configuration: {},
			revision: null,
			request: { key: KEY, state: "QUEUED" },
		});
	});
	it("returns the accepted all-disabled replacement instead of reviving old start values", async () => {
		const receipt = {
			configuration: {},
			appliedAt: new Date().toISOString(),
			scheduledShutdownAt: null,
			requestId: KEY,
		};
		run.stepLog = [
			{
				step: "start",
				kind: "START_LIVE_ENCODING",
				status: "DONE",
				refs: {},
				payload: { autoShutdownConfiguration: { streamTimeoutMinutes: 120 } },
			},
			{
				step: "update",
				kind: "LIVE_AUTO_SHUTDOWN_UPDATE",
				status: "DONE",
				refs: {},
				payload: receipt,
			},
		];
		mocks.latestClaim.mockResolvedValue({
			idempotencyKey: KEY,
			state: "ACKED",
		});
		expect(await (await get()).json()).toMatchObject({
			configuration: {},
			revision: KEY,
			receipt,
			request: { key: KEY, state: "ACKED" },
		});
	});
});
