import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const findUnique = vi.fn();

const contentCreate = vi.fn();
const contentList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: { liveChannel: { findUnique } },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => {
	class Resource {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	}
	return {
		default: class MockBitmovinApi {
			encoding = {
				encodings: {
					live: {
						insertableContent: { create: contentCreate, list: contentList },
					},
				},
			};
		},
		InsertableContent: Resource,
		InsertableContentInput: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const INPUT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

const validContent = {
	name: "slate",
	inputs: [{ inputId: INPUT_ID, inputPath: "/slates/brb.mp4" }],
};

function postRequest(body: unknown): Request {
	return new Request("http://test/insertable-content", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

function channel(status: string) {
	findUnique.mockResolvedValue({
		status,
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

afterEach(() => vi.unstubAllEnvs());

it("allows an existing input ID through the channel and preflight boundary", async () => {
	channel("RUNNING");
	contentCreate.mockResolvedValueOnce({
		id: "content-existing-input",
		status: "CREATED",
	});
	const response = await POST(
		postRequest({ bitmovinAccountId: ACCOUNT_ID, content: validContent }),
		params,
	);
	expect(response.status).toBe(201);
	expect(revealApiKey).toHaveBeenCalledWith(ACCOUNT_ID);
	expect(contentCreate).toHaveBeenCalledWith(
		ENCODING_ID,
		expect.objectContaining({ name: "slate" }),
	);
});

describe("GET /api/live-channels/[id]/insertable-content", () => {
	it("clamps limit to 100 (C6) and scopes to the channel's encoding", async () => {
		channel("RUNNING");
		contentList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/insertable-content?bitmovinAccountId=${ACCOUNT_ID}&limit=500`,
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(contentList).toHaveBeenCalledWith(ENCODING_ID, {
			offset: 0,
			limit: 100,
		});
	});

	it("still lists after the channel stopped (reads are not RUNNING-gated)", async () => {
		channel("STOPPED");
		contentList.mockResolvedValueOnce({ totalCount: 1, items: [] });
		const res = await GET(
			new Request(
				`http://test/insertable-content?bitmovinAccountId=${ACCOUNT_ID}`,
			),
			params,
		);
		expect(res.status).toBe(200);
	});

	it("sanitizes list items to the allowlist", async () => {
		channel("RUNNING");
		contentList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "content-1",
					name: "slate",
					status: "READY",
					inputs: [
						{ inputId: INPUT_ID, inputPath: "/slates/brb.mp4", secret: "nope" },
					],
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/insertable-content?bitmovinAccountId=${ACCOUNT_ID}`,
			),
			params,
		);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("READY");
		expect(body).not.toContain("internalTrace");
		expect(body).not.toContain("nope");
	});

	it("400s a missing bitmovinAccountId", async () => {
		const res = await GET(
			new Request("http://test/insertable-content"),
			params,
		);
		expect(res.status).toBe(400);
	});
});

describe("POST /api/live-channels/[id]/insertable-content", () => {
	it("requires at least one input", async () => {
		channel("RUNNING");
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, content: { inputs: [] } }),
			params,
		);
		expect(res.status).toBe(400);
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("rejects a non-UUID inputId and a blank inputPath", async () => {
		channel("RUNNING");
		for (const inputs of [
			[{ inputId: "not-a-uuid", inputPath: "/a.mp4" }],
			[{ inputId: INPUT_ID, inputPath: "" }],
		]) {
			const res = await POST(
				postRequest({ bitmovinAccountId: ACCOUNT_ID, content: { inputs } }),
				params,
			);
			expect(res.status).toBe(400);
		}
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("409s a channel that is not RUNNING", async () => {
		channel("CREATED");
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, content: validContent }),
			params,
		);
		expect(res.status).toBe(409);
		expect(contentCreate).not.toHaveBeenCalled();
	});

	it("409s a channel that has no Bitmovin encoding yet", async () => {
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: null,
			bitmovinAccountId: ACCOUNT_ID,
		});
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, content: validContent }),
			params,
		);
		expect(res.status).toBe(409);
	});

	it("registers content and audits the encoding-scoped path", async () => {
		channel("RUNNING");
		contentCreate.mockResolvedValueOnce({
			id: "content-1",
			name: "slate",
			status: "CREATED",
		});
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, content: validContent }),
			params,
		);
		expect(res.status).toBe(201);
		expect((await res.json()).status).toBe("CREATED");
		expect(contentCreate).toHaveBeenCalledWith(
			ENCODING_ID,
			expect.objectContaining({ name: "slate" }),
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/encodings/${ENCODING_ID}/live/insertable-content`,
		);
	});

	it("surfaces a curated upstream error and audits the failure", async () => {
		channel("RUNNING");
		contentCreate.mockRejectedValueOnce(
			Object.assign(new Error("request: SHOULD_NOT_LEAK"), {
				httpStatusCode: 404,
				shortMessage: "Input not found",
			}),
		);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, content: validContent }),
			params,
		);
		expect(res.status).toBe(404);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("Input not found");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.statusCode).toBe(404);
	});
});
