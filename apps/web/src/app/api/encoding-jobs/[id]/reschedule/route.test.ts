import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getAccount = vi.fn();
const revealApiKey = vi.fn();
const auditCreate = vi.fn();
const reschedule = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique },
			auditLog: { create: auditCreate },
		},
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = { encodings: { reschedule } };
	},
	// The REAL model carries ONLY infrastructureId — no date/time field exists.
	RescheduleEncodingRequest: class {
		infrastructureId?: string;
		constructor(obj: { infrastructureId?: string }) {
			Object.assign(this, obj);
		}
	},
}));

import { POST } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const INFRA_ID = "00000000-0000-4000-8000-00000000f00d";
const ENCODING_ID = "bm-enc-1";

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}
function postRequest(body: unknown): Request {
	return new Request(`http://test/api/encoding-jobs/${JOB_ID}/reschedule`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}
function jobRow(over: Record<string, unknown> = {}) {
	return {
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
		stepLog: [],
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	auditCreate.mockResolvedValue({});
	findUnique.mockResolvedValue(jobRow());
	reschedule.mockResolvedValue({ id: ENCODING_ID });
});

describe("POST /api/encoding-jobs/[id]/reschedule", () => {
	it("400s a non-uuid job id before touching the DB", async () => {
		const res = await POST(
			postRequest({ infrastructureId: INFRA_ID }),
			ctx("nope"),
		);
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it.each([
		["missing infrastructureId", {}],
		["non-uuid infrastructureId", { infrastructureId: "aws-eu" }],
		["wrong type", { infrastructureId: 42 }],
	])("400s %s", async (_label, body) => {
		const res = await POST(postRequest(body), ctx(JOB_ID));
		expect(res.status).toBe(400);
		expect(reschedule).not.toHaveBeenCalled();
	});

	it("400s a time-shaped payload — this endpoint is NOT a time-based reschedule", async () => {
		// The strict schema is the guard against the naming trap: Bitmovin's
		// RescheduleEncodingRequest has no date field, so anything time-like is a
		// caller misunderstanding and must fail loudly instead of being dropped.
		const res = await POST(
			postRequest({
				infrastructureId: INFRA_ID,
				startAt: "2026-08-07T00:00:00Z",
			}),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(400);
		expect(reschedule).not.toHaveBeenCalled();
	});

	it("moves the encoding onto the target infrastructure", async () => {
		const res = await POST(
			postRequest({ infrastructureId: INFRA_ID }),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: JOB_ID,
			encodingId: ENCODING_ID,
			infrastructureId: INFRA_ID,
		});
		const [encodingId, request] = reschedule.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(encodingId).toBe(ENCODING_ID);
		// ONLY infrastructureId rides the wire.
		expect({ ...request }).toEqual({ infrastructureId: INFRA_ID });
	});

	it("404s a missing job and 409s one without an encoding id", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect(
			(await POST(postRequest({ infrastructureId: INFRA_ID }), ctx(JOB_ID)))
				.status,
		).toBe(404);
		findUnique.mockResolvedValueOnce(jobRow({ bitmovinEncodingId: null }));
		expect(
			(await POST(postRequest({ infrastructureId: INFRA_ID }), ctx(JOB_ID)))
				.status,
		).toBe(409);
		expect(reschedule).not.toHaveBeenCalled();
	});

	it.each([
		"DRAFT",
		"FINISHED",
		"ERROR",
		"CANCELED",
	])("409s a job that is not in flight (%s) — a finished encoding has nowhere to move", async (status) => {
		findUnique.mockResolvedValueOnce(jobRow({ status }));
		const res = await POST(
			postRequest({ infrastructureId: INFRA_ID }),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(409);
		expect(reschedule).not.toHaveBeenCalled();
	});

	it("409s (fail closed) when the Bitmovin account was deleted", async () => {
		findUnique.mockResolvedValueOnce(jobRow({ bitmovinAccountId: null }));
		const res = await POST(
			postRequest({ infrastructureId: INFRA_ID }),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(409);
		expect(revealApiKey).not.toHaveBeenCalled();
	});

	it("audits the call with the infrastructure reference", async () => {
		await POST(postRequest({ infrastructureId: INFRA_ID }), ctx(JOB_ID));
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "POST",
			path: `/encoding/encodings/${ENCODING_ID}/reschedule`,
			bitmovinAccountId: ACCOUNT_ID,
		});
		expect(arg.data.request).toMatchObject({ infrastructureId: INFRA_ID });
	});

	it("passes an upstream 404 through and maps a 403 to 502", async () => {
		reschedule.mockRejectedValueOnce({
			httpStatusCode: 404,
			shortMessage: "Infrastructure not found",
		});
		expect(
			(await POST(postRequest({ infrastructureId: INFRA_ID }), ctx(JOB_ID)))
				.status,
		).toBe(404);
		reschedule.mockRejectedValueOnce({
			httpStatusCode: 403,
			shortMessage: "Cloud Connect not entitled",
		});
		expect(
			(await POST(postRequest({ infrastructureId: INFRA_ID }), ctx(JOB_ID)))
				.status,
		).toBe(502);
	});
});
