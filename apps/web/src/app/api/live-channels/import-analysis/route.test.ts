import { afterEach, beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	importFinal: vi.fn(),
	audit: vi.fn(),
	context: {
		tenant: {
			role: "ADMIN",
			actorRole: "ADMIN",
			isImpersonating: false,
			actorUserId: "11111111-1111-4111-8111-111111111111",
			effectiveUserId: "11111111-1111-4111-8111-111111111111",
			actor: "user:11111111-1111-4111-8111-111111111111",
		},
	},
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => deps.context,
}));
vi.mock("@/lib/server/aisa-live-import", () => ({
	importFinalAisaAnalysis: deps.importFinal,
	AisaImportVerificationError: class extends Error {},
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: deps.audit }));

import { POST } from "./route";

const account = "11111111-1111-4111-8111-111111111111";
const analysis = "22222222-2222-4222-8222-222222222222";
const request = (body: unknown) =>
	new Request("http://localhost/api/live-channels/import-analysis", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv(
		"BITOVP_AISA_LIVE_PREVIEW_USER_ID",
		"11111111-1111-4111-8111-111111111111",
	);
	deps.importFinal.mockReset();
	deps.audit.mockReset();
	deps.context.tenant.role = "ADMIN";
	deps.context.tenant.effectiveUserId = deps.context.tenant.actorUserId;
	deps.importFinal.mockResolvedValue({
		channelId: "channel",
		runId: "run",
		imported: true,
	});
});
afterEach(() => vi.unstubAllEnvs());

it("denies delegated access before a mocked import helper or audit write can bypass access", async () => {
	deps.context.tenant.effectiveUserId = "22222222-2222-4222-8222-222222222222";
	const response = await POST(
		request({ bitmovinAccountId: account, analysisId: analysis }),
	);
	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({ error: "Not found" });
	expect(deps.importFinal).not.toHaveBeenCalled();
	expect(deps.audit).not.toHaveBeenCalled();
});

it("returns the persisted normal channel identity for a verified final Analysis", async () => {
	const response = await POST(
		request({ bitmovinAccountId: account, analysisId: analysis }),
	);
	expect(response.status).toBe(201);
	expect(await response.json()).toEqual({
		channelId: "channel",
		runId: "run",
		imported: true,
	});
	expect(deps.importFinal).toHaveBeenCalledWith(
		deps.context,
		{ bitmovinAccountId: account, analysisId: analysis },
		expect.any(Request),
	);
});
it("reuses an existing import without creating another history entry", async () => {
	deps.importFinal.mockResolvedValue({
		channelId: "channel",
		runId: "run",
		imported: false,
	});
	const response = await POST(
		request({ bitmovinAccountId: account, analysisId: analysis }),
	);
	expect(response.status).toBe(200);
});
it("fails closed for VIEWER and disabled preview before provider verification", async () => {
	deps.context.tenant.role = "VIEWER";
	expect(
		(await POST(request({ bitmovinAccountId: account, analysisId: analysis })))
			.status,
	).toBe(404);
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "false");
	expect(
		(await POST(request({ bitmovinAccountId: account, analysisId: analysis })))
			.status,
	).toBe(404);
	expect(deps.importFinal).not.toHaveBeenCalled();
});
it("rejects unvalidated provider snapshots and surplus request fields", async () => {
	const response = await POST(
		request({
			bitmovinAccountId: account,
			analysisId: analysis,
			snapshot: { isFinal: true },
		}),
	);
	expect(response.status).toBe(400);
	expect(deps.importFinal).not.toHaveBeenCalled();
});
