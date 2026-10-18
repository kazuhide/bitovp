import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const findUnique = vi.fn();

const stopCreate = vi.fn();
// : the two reservation endpoints are ALSO on the mock, so the arm
// below can pin that a stop never reaches for them.
const scheduleDelete = vi.fn();
const scheduledList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
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
						stop: { create: stopCreate },
						schedule: { delete: scheduleDelete },
						scheduled: { list: scheduledList },
					},
				},
			},
		};
	},
}));

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

function postRequest(body: unknown): Request {
	return new Request("http://test/insertable-content/stop", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	findUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
	});
});

describe("POST /api/live-channels/[id]/insertable-content/stop", () => {
	it("treats the SDK's raw 2xx Response as success (no id to snapshot)", async () => {
		stopCreate.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID }),
			params,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			encodingId: ENCODING_ID,
			stopped: true,
		});
		expect(stopCreate).toHaveBeenCalledWith(ENCODING_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.response).toEqual({ stopped: true });
	});

	it("stops the CURRENT insertion only — no reservation is listed or cancelled, so future reservations are retained (row #277)", async () => {
		stopCreate.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID }),
			params,
		);
		expect(res.status).toBe(200);
		expect(stopCreate).toHaveBeenCalledTimes(1);
		// The stop is not "cancel everything": the reservation queue is neither
		// read nor touched. A reservation is cancelled per row, by the DELETE
		// under `schedule/[scheduledId]`, and that route never posts a stop.
		expect(scheduledList).not.toHaveBeenCalled();
		expect(scheduleDelete).not.toHaveBeenCalled();
		// One audited provider call, and it is the stop.
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/encodings/${ENCODING_ID}/live/insertable-content/stop`,
		);
	});

	it("rejects an unexpected body field (strict)", async () => {
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, force: true }),
			params,
		);
		expect(res.status).toBe(400);
		expect(stopCreate).not.toHaveBeenCalled();
	});

	it("409s a channel that is not RUNNING", async () => {
		findUnique.mockResolvedValue({
			status: "PROVISIONING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
		});
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID }),
			params,
		);
		expect(res.status).toBe(409);
		expect(stopCreate).not.toHaveBeenCalled();
	});

	it("surfaces a curated 409 when nothing is playing", async () => {
		stopCreate.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 409,
				shortMessage: "No inserted content is currently running",
			}),
		);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID }),
			params,
		);
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body).toMatchObject({
			error: "No inserted content is currently active",
			details: { code: "CONTENT_INSERT_NOT_ACTIVE" },
		});
		expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
	});
});
