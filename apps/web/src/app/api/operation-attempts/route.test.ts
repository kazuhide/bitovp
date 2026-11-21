import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "10000000-0000-4000-8000-000000000001";
const CHANNEL = "20000000-0000-4000-8000-000000000002";
const RUN = "30000000-0000-4000-8000-000000000003";
const ATTEMPT = "40000000-0000-4000-8000-000000000004";
const state = vi.hoisted(() => ({
	context: vi.fn(),
	flags: vi.fn(),
	findRun: vi.fn(),
	insert: vi.fn(),
	finish: vi.fn(),
	findAttempt: vi.fn(),
}));

vi.mock("@/lib/server/context", () => ({ getServerContext: state.context }));
vi.mock("@/lib/server/feature-flags", () => ({
	readFeatureFlags: state.flags,
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
const prisma = {
	liveChannelRun: { findFirst: state.findRun },
	operationAttempt: {
		createMany: state.insert,
		updateMany: state.finish,
		findFirst: state.findAttempt,
	},
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
	state.findRun.mockResolvedValue({ id: RUN });
	state.insert.mockResolvedValue({ count: 1 });
	state.finish.mockResolvedValue({ count: 1 });
	state.findAttempt.mockResolvedValue(null);
});

describe("POST /api/operation-attempts", () => {
	it("stores a start without storing the user, channel or run", async () => {
		expect((await POST(request())).status).toBe(204);
		expect(state.findRun).toHaveBeenCalledWith({
			where: { id: RUN, liveChannelId: CHANNEL, organizationId: ORG },
			select: { id: true },
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

	it("accepts an exact duplicate and rejects reuse of the ID by another owner or target", async () => {
		state.insert.mockResolvedValue({ count: 0 });
		state.findAttempt.mockResolvedValueOnce({ outcome: null, elapsedMs: null });
		expect((await POST(request())).status).toBe(204);
		expect((await POST(request())).status).toBe(409);
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
