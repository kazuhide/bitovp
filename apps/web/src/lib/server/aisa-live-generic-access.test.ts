import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	tenant: undefined as Record<string, unknown> | undefined,
	channel: vi.fn(),
	runs: vi.fn(),
	preset: vi.fn(),
	presets: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	transaction: vi.fn(),
	queue: vi.fn(),
	replay: vi.fn(),
	audit: vi.fn(),
	audits: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: mocks.tenant,
		prisma: {
			liveChannel: { findUnique: mocks.channel, create: mocks.create },
			liveChannelRun: { findMany: mocks.runs },
			preset: {
				findFirst: mocks.preset,
				findMany: mocks.presets,
				create: mocks.create,
				updateMany: mocks.update,
				deleteMany: mocks.remove,
			},
			vmafJob: { findFirst: async () => null },
			createRequest: { findFirst: mocks.replay },
			auditLog: { findUnique: mocks.audit, findMany: mocks.audits },
			$transaction: mocks.transaction,
		},
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: mocks.queue }),
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/server/live-heartbeat-reception", () => ({
	readHeartbeatReception: async () => ({ state: "available", latest: null }),
}));
vi.mock("@/lib/server/playback-links", () => ({
	playbackLinksForLivePlan: async () => [],
}));

import { GET as auditDetail } from "@/app/api/audit-logs/[id]/route";
import { GET as auditList } from "@/app/api/audit-logs/route";
import { POST as channelAction } from "@/app/api/live-channels/[id]/actions/route";
import {
	GET as channelDetail,
	DELETE as deleteChannel,
	PATCH as patchChannel,
} from "@/app/api/live-channels/[id]/route";
import { GET as runHistory } from "@/app/api/live-channels/[id]/runs/route";
import { POST as createChannel } from "@/app/api/live-channels/route";
import {
	DELETE as deletePreset,
	PATCH as patchPreset,
	GET as presetDetail,
} from "@/app/api/presets/[id]/route";
import {
	POST as createPreset,
	GET as presetList,
} from "@/app/api/presets/route";

const id = "00000000-0000-4000-8000-0000000000a1";
const ownerId = "00000000-0000-4000-8000-0000000000a2";
const otherId = "00000000-0000-4000-8000-0000000000a3";
const analysisId = "00000000-0000-4000-8000-0000000000a4";
const plan = {
	planVersion: 1,
	name: "Managed feature",
	bitmovin: {
		accountId: id,
		cloudRegion: "GOOGLE_EUROPE_WEST_1",
		encoderVersion: "STABLE",
	},
	liveInput: { key: "main", kind: "RTMP" },
	outputs: [],
	ingest: [],
	renditions: [],
	muxings: [],
	liveManifests: [],
	start: {
		streamKey: "synthetic",
		aiSceneAnalysisLive: {
			preset: "AISA_PREVIEW_MANAGED",
			outputId: id,
			recordingPath: "recording",
			analysisPath: "analysis",
		},
	},
};
const params = () => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: unknown) =>
	new Request(`http://test/api/live-channels/${id}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"x-bitovp-role": "ADMIN",
			"x-bitovp-actor": `user:${ownerId}`,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", ownerId);
	mocks.tenant = {
		actor: `user:${otherId}`,
		actorUserId: otherId,
		effectiveUserId: otherId,
		role: "ADMIN",
		actorRole: "ADMIN",
		isImpersonating: false,
	};
	mocks.channel.mockResolvedValue({
		id,
		status: "STOPPED",
		origin: "MANAGED",
		plan,
		runs: [
			{
				id,
				seq: 1,
				status: "STOPPED",
				bitmovinEncodingId: id,
				aisaAnalysisId: analysisId,
				aisaStatus: "FINISHED",
				aisaSnapshot: { observations: [{ text: "private result" }] },
				createdAt: new Date("2026-11-08T00:00:00Z"),
			},
		],
	});
	mocks.runs.mockResolvedValue([
		{
			id,
			seq: 1,
			status: "STOPPED",
			bitmovinEncodingId: id,
			aisaAnalysisId: analysisId,
			aisaStatus: "FINISHED",
			aisaObservedAt: "2026-11-08T00:00:00Z",
		},
	]);
	mocks.preset.mockResolvedValue({ id, kind: "LIVE_PLAN", body: plan });
	mocks.replay.mockResolvedValue(null);
	mocks.transaction.mockResolvedValue(0);
});
afterEach(() => vi.unstubAllEnvs());

describe("single-owner AISA boundaries on ordinary routes", () => {
	it("keeps normal channel status readable without returning Analysis identity or results to another ADMIN", async () => {
		const response = await channelDetail(request("GET"), params());
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.status).toBe("STOPPED");
		expect(body.aisaFeatureAllowed).toBe(false);
		expect(JSON.stringify(body)).not.toContain(analysisId);
		expect(JSON.stringify(body)).not.toContain("private result");
		expect(body.monitoringSafeForViewer).toBe(true);
	});
	it("withholds AISA fields from run history while preserving run and Encoding identity", async () => {
		const response = await runHistory(request("GET"), params());
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.runs[0]).toMatchObject({
			id,
			bitmovinEncodingId: id,
			status: "STOPPED",
		});
		expect(JSON.stringify(body)).not.toContain(analysisId);
		expect(body.runs[0].aisaStatus).toBeFalsy();
	});
	it("refuses creation before idempotency replay or any paid dispatch", async () => {
		const response = await createChannel(request("POST", { plan }));
		expect(response.status).toBe(404);
		expect(mocks.replay).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it.each([
		"start",
		"stop",
		"cancel-start",
	])("refuses an AISA channel %s before mutation", async (action) => {
		const response = await channelAction(
			request("POST", {
				action,
				...(action === "cancel-start" ? { generation: 0 } : {}),
			}),
			params(),
		);
		expect(response.status).toBe(404);
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});
	it("refuses deletion of an AISA channel before a transaction", async () => {
		const response = await deleteChannel(request("DELETE"), params());
		expect(response.status).toBe(404);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("refuses an AISA channel update", async () => {
		const response = await patchChannel(
			request("PATCH", { maxRunMinutes: null }),
			params(),
		);
		expect(response.status).toBe(404);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("withholds a saved AISA plan from another ADMIN", async () => {
		const response = await presetDetail(request("GET"), params());
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("AISA_PREVIEW_MANAGED");
	});
	it("refuses saving an AISA plan before persistence", async () => {
		const response = await createPreset(
			request("POST", { kind: "LIVE_PLAN", name: "private preset", plan }),
		);
		expect(response.status).toBe(404);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("refuses edits to an existing AISA preset before persistence", async () => {
		const response = await patchPreset(
			request("PATCH", {
				name: "changed",
				expectedUpdatedAt: "2026-11-08T00:00:00Z",
			}),
			params(),
		);
		expect(response.status).toBe(404);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("refuses deletion of an AISA preset", async () => {
		const response = await deletePreset(request("DELETE"), params());
		expect(response.status).toBe(404);
		expect(mocks.remove).not.toHaveBeenCalled();
	});
	it("refuses converting a normal preset into an AISA plan", async () => {
		mocks.preset.mockResolvedValue({
			id,
			kind: "LIVE_PLAN",
			body: { planVersion: 1 },
		});
		const response = await patchPreset(
			request("PATCH", { plan, expectedUpdatedAt: "2026-11-08T00:00:00Z" }),
			params(),
		);
		expect(response.status).toBe(404);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("reauthorizes the body reread after an ordinary preset PATCH", async () => {
		mocks.preset
			.mockResolvedValueOnce({
				id,
				kind: "LIVE_PLAN",
				body: { planVersion: 1, name: "ordinary" },
			})
			.mockResolvedValueOnce({ id, kind: "LIVE_PLAN", body: plan });
		mocks.update.mockResolvedValueOnce({ count: 1 });
		const response = await patchPreset(
			request("PATCH", {
				name: "ordinary edit",
				expectedUpdatedAt: "2026-11-08T00:00:00Z",
			}),
			params(),
		);
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain("AISA_PREVIEW_MANAGED");
	});
	it("filters AISA preset metadata without returning any plan body", async () => {
		mocks.presets.mockResolvedValue([
			{ id, name: "normal", body: {} },
			{ id: analysisId, name: "private preset", body: plan },
		]);
		const response = await presetList(
			new Request("http://test/api/presets?kind=LIVE_PLAN"),
		);
		expect(await response.json()).toEqual([{ id, name: "normal" }]);
	});
	it.each([
		`/ai-scene-analysis/live-analyses/${analysisId}/start`,
		`/api/live/analyses/${analysisId}/translations`,
		"/live-channels/import-analysis",
	])("withholds AISA audit detail %s", async (path) => {
		mocks.audit.mockResolvedValue({ id, path, response: { analysisId } });
		const response = await auditDetail(request("GET"), params());
		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain(analysisId);
	});
	it("filters AISA audit paths while preserving ordinary audit rows and pagination filter", async () => {
		mocks.audits.mockResolvedValue([
			{ id, path: "/encoding/encodings", error: null },
			{
				id: analysisId,
				path: `/ai-scene-analysis/live-analyses/${analysisId}`,
			},
		]);
		const response = await auditList(new Request("http://test/api/audit-logs"));
		expect((await response.json()).items).toEqual([
			{ id, path: "/encoding/encodings", error: null },
		]);
		expect(mocks.audits.mock.calls[0]?.[0].where).toBeDefined();
	});
	it("keeps saved AISA plans and audit detail available to the configured owner", async () => {
		mocks.tenant = {
			actor: `user:${ownerId}`,
			actorUserId: ownerId,
			effectiveUserId: ownerId,
			role: "ADMIN",
			actorRole: "ADMIN",
			isImpersonating: false,
		};
		mocks.audit.mockResolvedValue({
			id,
			path: `/ai-scene-analysis/live-analyses/${analysisId}`,
			response: { analysisId },
		});
		const preset = await presetDetail(request("GET"), params());
		expect(preset.status).toBe(200);
		expect((await preset.json()).body).toEqual(plan);
		const audit = await auditDetail(request("GET"), params());
		expect(audit.status).toBe(200);
		expect((await audit.json()).response.analysisId).toBe(analysisId);
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", "");
		expect((await presetDetail(request("GET"), params())).status).toBe(404);
	});
});
