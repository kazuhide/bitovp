import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getAccount = vi.fn();
const revealApiKey = vi.fn();
const auditCreate = vi.fn();
const reprioritize = vi.fn();

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
		encoding = { encodings: { reprioritize } };
	},
	// Mirrors the real model: a plain carrier of the request fields.
	ReprioritizeEncodingRequest: class {
		priority?: number;
		constructor(obj: { priority?: number }) {
			Object.assign(this, obj);
		}
	},
}));

import { POST } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const ENCODING_ID = "bm-enc-1";

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}
function postRequest(body: unknown): Request {
	return new Request(`http://test/api/encoding-jobs/${JOB_ID}/reprioritize`, {
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
	reprioritize.mockResolvedValue({ id: ENCODING_ID });
});

describe("POST /api/encoding-jobs/[id]/reprioritize", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await POST(postRequest({ priority: 10 }), ctx("nope"));
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it.each([
		["missing priority", {}],
		["non-integer", { priority: 12.5 }],
		["below range", { priority: -1 }],
		["above range", { priority: 101 }],
		["wrong type", { priority: "50" }],
		["unknown extra field (strict)", { priority: 50, startAt: "2026-01-01" }],
	])("400s %s", async (_label, body) => {
		const res = await POST(postRequest(body), ctx(JOB_ID));
		expect(res.status).toBe(400);
		expect(reprioritize).not.toHaveBeenCalled();
	});

	it.each([
		0, 50, 100,
	])("accepts the boundary priority %i", async (priority) => {
		const res = await POST(postRequest({ priority }), ctx(JOB_ID));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: JOB_ID,
			encodingId: ENCODING_ID,
			priority,
		});
		const [encodingId, request] = reprioritize.mock.calls[0] as [
			string,
			{ priority: number },
		];
		expect(encodingId).toBe(ENCODING_ID);
		expect(request.priority).toBe(priority);
	});

	it("404s a missing job and 409s one without an encoding id", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await POST(postRequest({ priority: 5 }), ctx(JOB_ID))).status).toBe(
			404,
		);
		findUnique.mockResolvedValueOnce(jobRow({ bitmovinEncodingId: null }));
		expect((await POST(postRequest({ priority: 5 }), ctx(JOB_ID))).status).toBe(
			409,
		);
		expect(reprioritize).not.toHaveBeenCalled();
	});

	it.each([
		"DRAFT",
		"FINISHED",
		"ERROR",
		"CANCELED",
	])("409s a job that is not in flight (%s) — priority only bites while queued", async (status) => {
		findUnique.mockResolvedValueOnce(jobRow({ status }));
		const res = await POST(postRequest({ priority: 60 }), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining(status),
		});
		expect(reprioritize).not.toHaveBeenCalled();
	});

	it.each([
		"QUEUED",
		"RUNNING",
	])("allows an in-flight job (%s)", async (status) => {
		findUnique.mockResolvedValueOnce(jobRow({ status }));
		const res = await POST(postRequest({ priority: 60 }), ctx(JOB_ID));
		expect(res.status).toBe(200);
	});

	it("409s (fail closed) when the Bitmovin account was deleted", async () => {
		findUnique.mockResolvedValueOnce(jobRow({ bitmovinAccountId: null }));
		const res = await POST(postRequest({ priority: 60 }), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(revealApiKey).not.toHaveBeenCalled();
	});

	it("audits the call with the (non-secret) payload", async () => {
		await POST(postRequest({ priority: 77 }), ctx(JOB_ID));
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "POST",
			path: `/encoding/encodings/${ENCODING_ID}/reprioritize`,
			statusCode: 201,
			bitmovinAccountId: ACCOUNT_ID,
		});
		expect(arg.data.request).toMatchObject({ priority: 77 });
	});

	it("passes an upstream 422 through and maps a 429 to 502", async () => {
		reprioritize.mockRejectedValueOnce({
			httpStatusCode: 422,
			shortMessage: "priority out of range",
		});
		expect((await POST(postRequest({ priority: 5 }), ctx(JOB_ID))).status).toBe(
			422,
		);
		reprioritize.mockRejectedValueOnce({
			httpStatusCode: 429,
			shortMessage: "too many requests",
		});
		expect((await POST(postRequest({ priority: 5 }), ctx(JOB_ID))).status).toBe(
			502,
		);
	});
});
