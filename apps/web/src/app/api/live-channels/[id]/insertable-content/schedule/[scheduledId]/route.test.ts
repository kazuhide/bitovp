import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const findUnique = vi.fn();

const scheduleDelete = vi.fn();
// : the global stop is on the mock too, so the arm below can pin that
// cancelling one reservation never reaches for it.
const stopCreate = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: owner,
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: { liveChannel: { findUnique } },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			encodings: {
				live: {
					insertableContent: {
						schedule: { delete: scheduleDelete },
						stop: { create: stopCreate },
					},
				},
			},
		};
	},
}));

import { DELETE } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const owner = {
	actorUserId: OWNER_ID,
	effectiveUserId: OWNER_ID,
	actor: `user:${OWNER_ID}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const CONTENT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const SCHEDULED_ID = "22223333-4444-4555-8666-777788889999";

const params = {
	params: Promise.resolve({ id: CHANNEL_ID, scheduledId: SCHEDULED_ID }),
};

function deleteRequest(qs: string): Request {
	return new Request(`http://test/schedule/${SCHEDULED_ID}?${qs}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", OWNER_ID);
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	findUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
	});
});
afterEach(() => vi.unstubAllEnvs());

describe("DELETE .../insertable-content/schedule/[scheduledId]", () => {
	it("cancels a reservation on the AISA encoding without stopping the live insertion", async () => {
		findUnique.mockResolvedValue({
			origin: "MANAGED",
			plan: {
				start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
			},
			status: "RUNNING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
		});
		scheduleDelete.mockResolvedValueOnce({ id: SCHEDULED_ID });
		const response = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}&contentId=${CONTENT_ID}`),
			params,
		);
		expect(response.status).toBe(200);
		expect(scheduleDelete).toHaveBeenCalledWith(
			ENCODING_ID,
			CONTENT_ID,
			SCHEDULED_ID,
		);
		expect(stopCreate).not.toHaveBeenCalled();
	});
	it("400s without contentId — the SDK addresses the entry under its content", async () => {
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(400);
		expect(scheduleDelete).not.toHaveBeenCalled();
	});

	it("400s an invalid route id", async () => {
		const res = await DELETE(deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`), {
			params: Promise.resolve({ id: CHANNEL_ID, scheduledId: "not-a-uuid" }),
		});
		expect(res.status).toBe(400);
	});

	it("de-schedules with the (encodingId, contentId, scheduledId) triple", async () => {
		scheduleDelete.mockResolvedValueOnce({ id: SCHEDULED_ID });
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}&contentId=${CONTENT_ID}`),
			params,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: SCHEDULED_ID,
			descheduled: true,
		});
		expect(scheduleDelete).toHaveBeenCalledWith(
			ENCODING_ID,
			CONTENT_ID,
			SCHEDULED_ID,
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(
			`/encoding/encodings/${ENCODING_ID}/live/insertable-content/${CONTENT_ID}/schedule/${SCHEDULED_ID}`,
		);
	});

	it("cancels ONE reservation — the global stop is never posted, so whatever is playing keeps playing (row #277)", async () => {
		scheduleDelete.mockResolvedValueOnce({ id: SCHEDULED_ID });
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}&contentId=${CONTENT_ID}`),
			params,
		);
		expect(res.status).toBe(200);
		expect(scheduleDelete).toHaveBeenCalledTimes(1);
		expect(stopCreate).not.toHaveBeenCalled();
		// One audited provider call, and it is the per-reservation DELETE.
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
	});

	it("409s a channel that is not RUNNING", async () => {
		findUnique.mockResolvedValue({
			status: "STOPPED",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
		});
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}&contentId=${CONTENT_ID}`),
			params,
		);
		expect(res.status).toBe(409);
	});
});
