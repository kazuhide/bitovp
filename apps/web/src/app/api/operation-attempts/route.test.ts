import { moqRunNamespaceSuffix } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "10000000-0000-4000-8000-000000000001";
const CHANNEL = "20000000-0000-4000-8000-000000000002";
const RUN = "30000000-0000-4000-8000-000000000003";
const ATTEMPT = "40000000-0000-4000-8000-000000000004";
const state = vi.hoisted(() => ({
	context: vi.fn(),
	flags: vi.fn(),
	query: vi.fn(),
	transaction: vi.fn(),
	findRun: vi.fn(),
	insert: vi.fn(),
	finish: vi.fn(),
	findAttempt: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ getServerContext: state.context }));
vi.mock("@/lib/server/feature-flags", () => ({
	readLockedFeatureFlags: state.flags,
}));

import { POST } from "./route";

const event = {
	operation: "LIVE_MOQ_PLAYBACK",
	attemptId: ATTEMPT,
	channelId: CHANNEL,
	runId: RUN,
	stage: "STARTED",
};
const actor = {
	organizationId: ORG,
	actor: "user:operator",
	role: "OPERATOR",
	isImpersonating: false,
};
const tx = {
	$queryRaw: state.query,
	liveChannelRun: { findFirst: state.findRun },
	operationAttempt: {
		createMany: state.insert,
		updateMany: state.finish,
		findFirst: state.findAttempt,
	},
};
const prisma = { $transaction: state.transaction };
const ENCODING = "50000000-0000-4000-8000-000000000005";
const readyRun = {
	id: RUN,
	liveChannelId: CHANNEL,
	organizationId: ORG,
	status: "RUNNING",
	endedAt: null,
	cancelRequested: false,
	bitmovinEncodingId: ENCODING,
	stepLog: [
		{
			step: "output:moq",
			kind: "CREATE_OUTPUT_MOQ",
			status: "DONE",
			payload: {
				credentialId: "60000000-0000-4000-8000-000000000006",
				trackNamespace: [`run${moqRunNamespaceSuffix(RUN)}`],
				draftVersion: "DRAFT_18",
			},
			refs: {},
			resourceId: "70000000-0000-4000-8000-000000000007",
			startedAt: "2026-11-17T00:00:02.000Z",
		},
		{
			step: "encoding:main",
			kind: "CREATE_ENCODING",
			status: "DONE",
			payload: {},
			refs: {},
			resourceId: ENCODING,
		},
		{
			step: "muxing:video",
			kind: "CREATE_MUXING_FMP4",
			status: "DONE",
			payload: {},
			refs: { encodingId: "encoding:main", outputId: "output:moq" },
			resourceId: "80000000-0000-4000-8000-000000000008",
		},
	],
};

function request(body: unknown = event, organizationId: string | null = ORG) {
	const headers = new Headers({ "content-type": "application/json" });
	if (organizationId) headers.set("x-bitovp-expected-org", organizationId);
	return new Request("https://test.invalid/api/operation-attempts", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	state.context.mockResolvedValue({ tenant: actor, prisma });
	state.flags.mockResolvedValue({ operationAnalytics: true });
	state.transaction.mockImplementation(
		async (run: (db: typeof tx) => Promise<Response>) => run(tx),
	);
	state.query.mockResolvedValue([{ id: CHANNEL }]);
	state.findRun.mockResolvedValue(readyRun);
	state.insert.mockResolvedValue({ count: 1 });
	state.finish.mockResolvedValue({ count: 1 });
	state.findAttempt.mockResolvedValue(null);
});

describe("POST /api/operation-attempts", () => {
	it("stores a start without storing the user, channel or run", async () => {
		expect((await POST(request())).status).toBe(204);
		expect(state.findRun).toHaveBeenCalledWith({
			where: { liveChannelId: CHANNEL, organizationId: ORG },
			orderBy: { seq: "desc" },
			select: expect.objectContaining({ id: true, stepLog: true }),
		});
		expect(state.insert).toHaveBeenCalledWith({
			data: {
				organizationId: ORG,
				id: ATTEMPT,
				operation: "LIVE_MOQ_PLAYBACK",
				ownerDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			skipDuplicates: true,
		});
	});

	it("replays a start after its run is deleted and refuses another owner or target", async () => {
		expect((await POST(request())).status).toBe(204);
		const digest = state.insert.mock.calls[0]?.[0].data.ownerDigest;
		state.findAttempt.mockResolvedValue({
			operation: "LIVE_MOQ_PLAYBACK",
			ownerDigest: digest,
		});
		state.findRun.mockClear();
		state.findRun.mockResolvedValue(null);
		expect((await POST(request())).status).toBe(204);
		expect((await POST(request({ ...event, channelId: ORG }))).status).toBe(
			409,
		);
		expect(state.findRun).not.toHaveBeenCalled();
		expect(state.insert).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ status: "STOPPED" },
		{ cancelRequested: true },
		{
			stepLog: [
				{ ...readyRun.stepLog[0], kind: "CREATE_OUTPUT_S3" },
				...readyRun.stepLog.slice(1),
			],
		},
	])("refuses to admit a start for a non-playable run %o", async (override) => {
		state.findRun.mockResolvedValue({ ...readyRun, ...override });
		expect((await POST(request())).status).toBe(409);
		expect(state.insert).not.toHaveBeenCalled();
	});

	it("retries a serializable conflict and respects the newly paused setting", async () => {
		state.transaction.mockRejectedValueOnce({
			code: "P2010",
			meta: { code: "40001" },
		});
		state.flags.mockResolvedValue({ operationAnalytics: false });
		expect((await POST(request())).status).toBe(404);
		expect(state.transaction).toHaveBeenCalledTimes(2);
		expect(state.transaction).toHaveBeenLastCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
		});
		expect(state.flags).toHaveBeenCalledWith(tx, ORG);
		expect(state.insert).not.toHaveBeenCalled();
	});

	it("accepts a single recent outcome from the same owner and target", async () => {
		await POST(request());
		const digest = state.insert.mock.calls[0]?.[0].data.ownerDigest;
		const response = await POST(
			request({ ...event, stage: "FIRST_FRAME", elapsedMs: 0 }),
		);
		expect(response.status).toBe(204);
		expect(state.finish).toHaveBeenCalledWith({
			where: {
				organizationId: ORG,
				id: ATTEMPT,
				operation: "LIVE_MOQ_PLAYBACK",
				ownerDigest: digest,
				outcome: null,
				startedAt: { gte: expect.any(Date) },
			},
			data: { outcome: "FIRST_FRAME", elapsedMs: 0 },
		});
		expect(state.insert).toHaveBeenCalledTimes(1);
	});

	it("accepts an exact outcome retry but does not replace an existing or expired result", async () => {
		const outcome = { ...event, stage: "FAILED", elapsedMs: 150 };
		state.finish.mockResolvedValue({ count: 0 });
		state.findAttempt.mockResolvedValueOnce({
			outcome: "FAILED",
			elapsedMs: 150,
		});
		expect((await POST(request(outcome))).status).toBe(204);
		state.findAttempt.mockResolvedValueOnce({
			outcome: "FIRST_FRAME",
			elapsedMs: 150,
		});
		expect((await POST(request(outcome))).status).toBe(409);
		state.findAttempt.mockResolvedValueOnce({ outcome: null, elapsedMs: null });
		expect((await POST(request(outcome))).status).toBe(409);
		expect((await POST(request(outcome))).status).toBe(404);
	});

	it("rejects starts for a run outside the admitted channel and organization", async () => {
		state.findRun.mockResolvedValue(null);
		expect((await POST(request())).status).toBe(404);
		expect(state.insert).not.toHaveBeenCalled();
	});

	it("fails closed when the setting is off", async () => {
		state.flags.mockResolvedValue({ operationAnalytics: false });
		expect((await POST(request())).status).toBe(404);
		expect(state.findRun).not.toHaveBeenCalled();
		expect(state.insert).not.toHaveBeenCalled();
	});

	it.each([
		{ role: "VIEWER" },
		{ isImpersonating: true },
		{ actor: "token:operator" },
	])("rejects an ineligible session %o", async (override) => {
		state.context.mockResolvedValue({
			tenant: { ...actor, ...override },
			prisma,
		});
		expect((await POST(request())).status).toBe(403);
		expect(state.flags).not.toHaveBeenCalled();
	});

	it("rejects stale and missing organization bindings", async () => {
		expect((await POST(request(event, CHANNEL))).status).toBe(409);
		expect((await POST(request(event, null))).status).toBe(409);
		expect(state.flags).not.toHaveBeenCalled();
	});

	it("rejects unexpected fields, invalid timings and oversized input", async () => {
		expect(
			(await POST(request({ ...event, username: "operator" }))).status,
		).toBe(400);
		expect(
			(await POST(request({ ...event, stage: "FAILED", elapsedMs: 600001 })))
				.status,
		).toBe(400);
		expect((await POST(request({ extra: "a".repeat(2000) }))).status).toBe(413);
		expect(state.insert).not.toHaveBeenCalled();
		expect(state.finish).not.toHaveBeenCalled();
	});
});
