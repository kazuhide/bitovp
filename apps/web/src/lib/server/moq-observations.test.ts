import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMoqObservations,
	putMoqObservation,
	readMoqBoundedBody,
} from "./moq-observations";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	run: vi.fn(),
	channel: vi.fn(),
	latest: vi.fn(),
	update: vi.fn(),
	lock: vi.fn(),
	audit: vi.fn(),
	provenance: vi.fn(),
	settings: vi.fn(),
	heartbeat: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock("./moq-heartbeat", () => ({
	readMoqHeartbeatHistory: mocks.heartbeat,
}));
vi.mock("./player-config", () => ({ readPlayerSettings: mocks.settings }));
const ORG = "00000000-0000-4000-8000-000000000001",
	CHANNEL = "00000000-0000-4000-8000-000000000002",
	RUN = "00000000-0000-4000-8000-000000000003",
	SESSION = "00000000-0000-4000-8000-000000000004",
	ENCODING = "00000000-0000-4000-8000-000000000005",
	OUTPUT = "00000000-0000-4000-8000-000000000006";
const sample = (elapsedMs = 0) => ({
	elapsedMs,
	latencyMs: null,
	fps: null,
	bufferSeconds: null,
	droppedFrames: null,
	decodedFrames: null,
	presentedFrames: null,
	totalFrames: null,
	resolution: null,
});
const payload = () => ({
	startedAt: new Date().toISOString(),
	endedAt: null,
	samples: [sample()],
	events: [{ elapsedMs: 0, type: "started" }],
});
const params = { id: CHANNEL, runId: RUN, sessionId: SESSION };
const req = (body: unknown = payload()) =>
	new Request(
		`http://test/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
const run = () => ({
	id: RUN,
	organizationId: ORG,
	liveChannelId: CHANNEL,
	status: "RUNNING",
	bitmovinEncodingId: ENCODING,
	endedAt: null,
	updatedAt: new Date(),
	moqObservations: { version: 1, sessions: [] },
	stepLog: [
		{
			step: "encoding",
			kind: "CREATE_ENCODING",
			status: "DONE",
			payload: {},
			refs: {},
			resourceId: ENCODING,
		},
		{
			step: "output",
			kind: "CREATE_OUTPUT_MOQ",
			status: "DONE",
			payload: {},
			refs: {},
			resourceId: OUTPUT,
		},
		{
			step: "muxing",
			kind: "CREATE_MUXING_FMP4",
			status: "DONE",
			payload: {},
			refs: { encodingId: "encoding", outputId: "output" },
		},
	],
});
let row: ReturnType<typeof run>;
beforeEach(() => {
	vi.resetAllMocks();
	row = run();
	const prisma = {
		liveChannelRun: { findFirst: mocks.run, update: mocks.update },
		liveChannel: { findUnique: mocks.channel },
		auditLog: { findMany: mocks.provenance },
		$queryRaw: mocks.lock,
	};
	Object.assign(prisma, {
		$transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
	});
	mocks.context.mockResolvedValue({
		tenant: {
			organizationId: ORG,
			role: "OPERATOR",
			actor: "user:owner",
			isImpersonating: false,
		},
		prisma,
	});
	mocks.run.mockImplementation(({ orderBy }) => (orderBy ? { id: RUN } : row));
	mocks.channel.mockResolvedValue({
		id: CHANNEL,
		organizationId: ORG,
		status: "RUNNING",
		bitmovinEncodingId: ENCODING,
	});
	mocks.update.mockImplementation(({ data }) => {
		row = { ...row, ...data };
		return row;
	});
	mocks.heartbeat.mockResolvedValue({
		source: "live-encoder-heartbeat",
		points: [],
		truncated: false,
	});
	mocks.settings.mockResolvedValue({
		analyticsLicenseKey: "public-analytics-license",
	});
	mocks.provenance.mockImplementation(({ where }) => [
		{
			organizationId: ORG,
			bitmovinAccountId: SESSION,
			response: {
				id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
			},
		},
	]);
});

describe("run-bound MoQ observation persistence", () => {
	it("rejects a different actor's mixed-case UUID alias before creating a second session", async () => {
		const lower = "abcdefab-0000-4000-8000-000000000004";
		expect(
			(await putMoqObservation(req(), { ...params, sessionId: lower })).status,
		).toBe(200);
		const ctx = await mocks.context();
		ctx.tenant.actor = "user:other";
		const writesBefore = mocks.update.mock.calls.length;
		expect(
			(
				await putMoqObservation(req(), {
					...params,
					sessionId: lower.toUpperCase(),
				})
			).status,
		).toBe(400);
		expect(mocks.update).toHaveBeenCalledTimes(writesBefore);
	});
	it("bounds the entire body read even when source cancellation never settles", async () => {
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel,
		});
		const init = { method: "PUT", body: stream, duplex: "half" };
		const request = new Request("http://test/stalled", init);
		await expect(readMoqBoundedBody(request, 100, 25)).rejects.toMatchObject({
			status: 408,
			code: "MOQ_HISTORY_BODY_TIMEOUT",
		});
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("creates a bounded session owned by the server actor, omitting actor from the response", async () => {
		const response = await putMoqObservation(req(), params);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.session).toMatchObject({
			id: SESSION,
			samples: [sample()],
			archive: null,
		});
		expect(body.session).not.toHaveProperty("actor");
		expect(mocks.lock).toHaveBeenCalledOnce();
		expect(JSON.stringify(mocks.update.mock.calls)).toContain("user:owner");
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("latencyMs");
	});
	it("preserves history after stop and permits only an existing owner's final flush for ten minutes", async () => {
		const input = payload();
		expect((await putMoqObservation(req(input), params)).status).toBe(200);
		row.status = "STOPPED";
		row.endedAt = new Date() as never;
		const flushed = {
			...input,
			endedAt: new Date().toISOString(),
			samples: [...input.samples, sample(1_000)],
		};
		expect((await putMoqObservation(req(flushed), params)).status).toBe(200);
		const get = await getMoqObservations(
			new Request("http://test/history"),
			params,
		);
		expect(get.status).toBe(200);
		expect((await get.json()).sessions).toHaveLength(1);
		row.endedAt = new Date(Date.now() - 600_001) as never;
		expect((await putMoqObservation(req(flushed), params)).status).toBe(409);
	});
	it.each([
		"VIEWER",
		"missing-tenant",
		"impersonating",
	])("refuses unauthorized persistence: %s", async (kind) => {
		const ctx = await mocks.context();
		if (kind === "missing-tenant") ctx.tenant = undefined;
		else if (kind === "impersonating") ctx.tenant.isImpersonating = true;
		else ctx.tenant.role = kind;
		expect((await putMoqObservation(req(), params)).status).toBe(403);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it.each([
		"cross-tenant",
		"cross-channel",
		"non-moq",
		"new-after-stop",
		"not-current",
	])("refuses a session unbound to an active MoQ run: %s", async (kind) => {
		if (kind === "cross-tenant") row.organizationId = SESSION;
		if (kind === "cross-channel") row.liveChannelId = SESSION;
		if (kind === "non-moq") row.stepLog = [];
		if (kind === "new-after-stop") row.status = "STOPPED";
		if (kind === "not-current")
			mocks.run.mockImplementation(({ orderBy }) =>
				orderBy ? { id: SESSION } : row,
			);
		expect((await putMoqObservation(req(), params)).status).toBe(
			kind.startsWith("cross") ? 404 : 409,
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("refuses another actor and rewriting or truncating stored samples", async () => {
		const input = payload();
		await putMoqObservation(req(input), params);
		const ctx = await mocks.context();
		ctx.tenant.actor = "user:other";
		expect((await putMoqObservation(req(input), params)).status).toBe(403);
		ctx.tenant.actor = "user:owner";
		expect(
			(await putMoqObservation(req({ ...input, samples: [] }), params)).status,
		).toBe(409);
		expect(
			(
				await putMoqObservation(
					req({ ...input, samples: [{ ...sample(), fps: 999 }] }),
					params,
				)
			).status,
		).toBe(409);
	});
	it("limits each run to five observation sessions", async () => {
		for (let i = 0; i < 5; i++)
			expect(
				(
					await putMoqObservation(req(), {
						...params,
						sessionId: `00000000-0000-4000-8000-00000000001${i}`,
					})
				).status,
			).toBe(200);
		expect((await putMoqObservation(req(), params)).status).toBe(409);
	});
	it("binds optional Analytics IDs to this run and refuses replacing an impression", async () => {
		const input = { ...payload(), analyticsImpressionId: SESSION };
		const response = await putMoqObservation(req(input), params);
		expect(response.status).toBe(200);
		expect((await response.json()).session.analyticsVideoId).toBe(
			`bitovp-moq:${ENCODING}:${RUN}`,
		);
		const persisted = JSON.stringify(mocks.update.mock.calls);
		expect(persisted).toContain("analyticsLicenseKeySha256");
		expect(persisted).not.toContain("public-analytics-license");
		expect(
			(
				await putMoqObservation(
					req({ ...input, analyticsImpressionId: OUTPUT }),
					params,
				)
			).status,
		).toBe(409);
	});
	it("refuses conflicting original provider account provenance", async () => {
		mocks.provenance.mockImplementation(({ where }) => [
			{
				organizationId: ORG,
				bitmovinAccountId:
					where.path === "/encoding/encodings" ? SESSION : OUTPUT,
				response: {
					id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
				},
			},
		]);
		expect((await putMoqObservation(req(), params)).status).toBe(409);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("rejects secrets, oversized JSON, and arbitrary source parameters without persistence", async () => {
		expect(
			(
				await putMoqObservation(
					req({ ...payload(), playbackUrl: "https://relay/private-token" }),
					params,
				)
			).status,
		).toBe(400);
		expect(
			(await putMoqObservation(req({ junk: "x".repeat(300_000) }), params))
				.status,
		).toBe(413);
		expect(
			(
				await getMoqObservations(
					new Request("http://test/history?url=https://attacker"),
					params,
				)
			).status,
		).toBe(400);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
