import { createHash } from "node:crypto";
import type { StepLogEntry } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMoqObservations,
	putMoqObservation,
	readMoqBoundedBody,
} from "./moq-observations";
import { getMoqPlaybackDescriptor } from "./moq-playback";

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
	credential: vi.fn(),
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
const run = (
	muxingKind:
		| "CREATE_MUXING_FMP4"
		| "CREATE_MUXING_CMAF" = "CREATE_MUXING_FMP4",
): {
	id: string;
	organizationId: string;
	liveChannelId: string;
	status: string;
	bitmovinEncodingId: string;
	endedAt: Date | null;
	updatedAt: Date;
	moqObservations: unknown;
	stepLog: StepLogEntry[];
} => ({
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
			payload: {
				credentialId: "00000000-0000-4000-8000-000000000009",
				trackNamespace: ["run-namespace"],
				draftVersion: "DRAFT_18",
			},
			refs: {},
			resourceId: OUTPUT,
			startedAt: "2026-11-17T00:00:02.000Z",
		},
		{
			step: "muxing",
			kind: muxingKind,
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
		$executeRaw: mocks.update,
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
		credentials: { revealVersioned: mocks.credential },
	});
	mocks.run.mockImplementation(({ orderBy, select }) =>
		orderBy && !select?.stepLog ? { id: RUN } : row,
	);
	mocks.channel.mockResolvedValue({
		id: CHANNEL,
		organizationId: ORG,
		status: "RUNNING",
		bitmovinEncodingId: ENCODING,
	});
	mocks.update.mockImplementation((command, ...values: unknown[]) => {
		if (Array.isArray(command)) {
			const [json, updatedAt, runId, organizationId] = values;
			if (runId !== row.id || organizationId !== row.organizationId) return 0;
			if (typeof json !== "string") throw new Error("Expected JSON text");
			row = {
				...row,
				moqObservations: JSON.parse(json),
				updatedAt: updatedAt as Date,
			};
			return 1;
		}
		// Measured with Prisma's real Json model-write path; TEXT::jsonb keeps it exact.
		const data = JSON.parse(
			JSON.stringify(command.data, (_key, value) =>
				value === 1.9994801351648572 ? 1.999480135164857 : value,
			),
		);
		row = { ...row, ...data };
		return row;
	});
	mocks.heartbeat.mockResolvedValue({
		source: "live-encoder-heartbeat",
		points: [],
		truncated: false,
	});
	mocks.settings.mockResolvedValue({
		playerLicenseKey: "tenant-player-key",
		analyticsLicenseKey: "public-analytics-license",
	});
	mocks.credential.mockResolvedValue({
		id: "00000000-0000-4000-8000-000000000009",
		provider: "MOQ",
		updatedAt: new Date("2026-11-17T00:00:00.000Z"),
		secret: JSON.stringify({
			relayUrl: "moqt://publisher.example",
			playbackUrl: "https://subscriber.example/moq",
		}),
	});
	mocks.provenance.mockImplementation(({ where }) => [
		{
			organizationId: ORG,
			bitmovinAccountId: SESSION,
			at: new Date("2026-11-17T00:00:04.000Z"),
			request: { trackNamespace: ["run-namespace"], draftVersion: "DRAFT_18" },
			response: {
				id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
			},
		},
	]);
});

describe("run-bound MoQ observation persistence", () => {
	it("appends a legitimate cumulative float prefix without a storage-induced 409", async () => {
		const input = {
			...payload(),
			samples: [{ ...sample(), fps: 1.9994801351648572 }],
		};
		expect((await putMoqObservation(req(input), params)).status).toBe(200);
		const appended = await putMoqObservation(
			req({ ...input, samples: [...input.samples, sample(1_000)] }),
			params,
		);
		const body = await appended.json();
		expect({ status: appended.status, code: body.details?.code }).toEqual({
			status: 200,
			code: undefined,
		});
		expect(body.session.samples[0].fps).toBe(1.9994801351648572);
		expect(body.session.samples).toHaveLength(2);
	});
	it("keeps the immutable sample guard exact even for a one-ULP metric change", async () => {
		const input = {
			...payload(),
			samples: [{ ...sample(), fps: 1.9994801351648572 }],
		};
		expect((await putMoqObservation(req(input), params)).status).toBe(200);
		const rewritten = await putMoqObservation(
			req({
				...input,
				samples: [{ ...input.samples[0], fps: 1.999480135164857 }],
			}),
			params,
		);
		expect(rewritten.status).toBe(409);
		expect((await rewritten.json()).details.code).toBe(
			"MOQ_HISTORY_SESSION_CONFLICT",
		);
	});
	it("does not report a saved session when the scoped persistence matches zero rows", async () => {
		mocks.update.mockResolvedValueOnce(0);
		const response = await putMoqObservation(req(), params);
		expect(response.status).toBe(503);
		expect((await response.json()).details.code).toBe(
			"MOQ_HISTORY_UNAVAILABLE",
		);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("retains a configured draft16 namespace tuple proven by the original output CREATE", async () => {
		row.stepLog = row.stepLog.map((entry) =>
			entry.kind === "CREATE_OUTPUT_MOQ"
				? {
						...entry,
						payload: {
							credentialId: "00000000-0000-4000-8000-000000000009",
							trackNamespace: ["parent", "broadcast"],
							draftVersion: "DRAFT_16",
						},
					}
				: entry,
		);
		mocks.provenance.mockImplementation(({ where }) => [
			{
				organizationId: ORG,
				bitmovinAccountId: SESSION,
				response: {
					id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
				},
				request: {
					trackNamespace: ["parent", "broadcast"],
					draftVersion: "DRAFT_16",
					relayUrl: "private-publisher-url",
					authToken: "private-publisher-token",
				},
			},
		]);
		const response = await getMoqObservations(
				new Request("http://test/history"),
				params,
			),
			body = await response.json();
		expect(response.status).toBe(200);
		expect(body.configuration).toEqual({
			namespace: ["parent", "broadcast"],
			draftVersion: 16,
			catalogTrackName: "catalog",
		});
		expect(JSON.stringify(body)).not.toContain("private-publisher");
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it("returns historical configured namespace/draft/catalog from matching immutable output proof without credentials", async () => {
		row.status = "STOPPED";
		const response = await getMoqObservations(
			new Request("http://test/history"),
			params,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).configuration).toEqual({
			namespace: ["run-namespace"],
			draftVersion: 18,
			catalogTrackName: "catalog",
		});
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it("omits unproven historical configuration without substituting current channel settings", async () => {
		mocks.provenance.mockImplementation(({ where }) => [
			{
				organizationId: ORG,
				bitmovinAccountId: SESSION,
				response: {
					id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
				},
				request: {
					trackNamespace: ["changed-namespace"],
					draftVersion: "DRAFT_18",
				},
			},
		]);
		const response = await getMoqObservations(
			new Request("http://test/history"),
			params,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).configuration).toBeUndefined();
		expect(mocks.credential).not.toHaveBeenCalled();
	});
	it("binds the first impression to the actual descriptor license and rejects intervening key rotation", async () => {
		const namespace = `run-namespace-bitovp-${RUN}`;
		const output = row.stepLog.find(
			(entry) => entry.kind === "CREATE_OUTPUT_MOQ",
		);
		if (!output) throw new Error("Missing output fixture");
		output.payload.trackNamespace = [namespace];
		mocks.provenance.mockImplementation(({ where }) => [
			{
				organizationId: ORG,
				bitmovinAccountId: SESSION,
				at: new Date("2026-11-17T00:00:04.000Z"),
				request: { trackNamespace: [namespace], draftVersion: "DRAFT_18" },
				response: {
					id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
				},
			},
		]);
		const descriptor = await getMoqPlaybackDescriptor(
			new Request("http://test/moq-playback"),
			params,
		);
		expect(descriptor.status).toBe(200);
		const analytics = (await descriptor.json()).analytics;
		const digestA = createHash("sha256")
			.update("public-analytics-license")
			.digest("hex");
		expect(analytics.licenseKeySha256).toBe(digestA);
		const input = {
			...payload(),
			analyticsImpressionId: SESSION,
			analyticsLicenseKeySha256: analytics.licenseKeySha256,
		};
		mocks.settings.mockResolvedValue({
			analyticsLicenseKey: "rotated-license-B",
		});
		expect((await putMoqObservation(req(input), params)).status).toBe(409);
		expect(mocks.update).not.toHaveBeenCalled();
		mocks.settings.mockResolvedValue({
			analyticsLicenseKey: "public-analytics-license",
		});
		const saved = await putMoqObservation(req(input), params);
		expect(saved.status).toBe(200);
		expect((await saved.json()).session).not.toHaveProperty(
			"analyticsLicenseKeySha256",
		);
		expect(JSON.stringify(mocks.update.mock.calls)).toContain(digestA);
		mocks.settings.mockResolvedValue({
			analyticsLicenseKey: "rotated-license-B",
		});
		const advanced = { ...input, samples: [...input.samples, sample(1_000)] };
		expect((await putMoqObservation(req(advanced), params)).status).toBe(200);
		const changed = await putMoqObservation(
			req({
				...advanced,
				analyticsLicenseKeySha256: createHash("sha256")
					.update("rotated-license-B")
					.digest("hex"),
			}),
			params,
		);
		expect(changed.status).toBe(409);
		expect((await changed.json()).details.code).toBe(
			"MOQ_HISTORY_ANALYTICS_LICENSE_CHANGED",
		);
	});
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
	it.each([
		"CREATE_MUXING_FMP4",
		"CREATE_MUXING_CMAF",
	] as const)("creates a bounded session for %s owned by the server actor, omitting actor from the response", async (kind) => {
		row = run(kind);
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
		const input = {
			...payload(),
			analyticsImpressionId: SESSION,
			analyticsLicenseKeySha256: createHash("sha256")
				.update("public-analytics-license")
				.digest("hex"),
		};
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
	it("reserves an impression for one session within the run", async () => {
		const binding = {
			analyticsImpressionId: SESSION,
			analyticsLicenseKeySha256: createHash("sha256")
				.update("public-analytics-license")
				.digest("hex"),
		};
		expect(
			(await putMoqObservation(req({ ...payload(), ...binding }), params))
				.status,
		).toBe(200);
		const second = { ...params, sessionId: OUTPUT };
		const duplicate = await putMoqObservation(
			req({ ...payload(), ...binding }),
			second,
		);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toMatchObject({
			details: { code: "MOQ_HISTORY_ANALYTICS_IMPRESSION_CONFLICT" },
		});
		expect((await putMoqObservation(req(payload()), second)).status).toBe(200);
		const history = await getMoqObservations(
			new Request("http://test/history"),
			params,
		);
		const data = await history.json();
		expect(
			data.sessions.filter(
				(session: { analyticsImpressionId?: string }) =>
					session.analyticsImpressionId === SESSION,
			),
		).toHaveLength(1);
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
