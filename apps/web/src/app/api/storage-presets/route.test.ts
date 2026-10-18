import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const findMany = vi.fn();
const create = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		credentials: { get },
		prisma: { storageLocationPreset: { findMany, create } },
	}),
}));

import { GET, POST } from "./route";

const CRED_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

beforeEach(() => {
	vi.clearAllMocks();
});

function postRequest(body: unknown): Request {
	return new Request("http://test/api/storage-presets", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

describe("storage-presets", () => {
	it("lists presets", async () => {
		findMany.mockResolvedValueOnce([{ id: "1" }]);
		const res = await GET();
		expect(res.status).toBe(200);
	});

	it("rejects invalid payloads", async () => {
		const res = await POST(
			postRequest({ credentialId: "nope", label: "", bucket: "", role: "X" }),
		);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects presets for missing credentials", async () => {
		get.mockResolvedValueOnce(null);
		const res = await POST(
			postRequest({
				credentialId: CRED_ID,
				label: "origin",
				bucket: "media",
				role: "OUTPUT",
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/Credential/);
	});

	it("creates presets with the prefix defaulted", async () => {
		get.mockResolvedValueOnce({ id: CRED_ID });
		create.mockResolvedValueOnce({ id: "p1" });
		const res = await POST(
			postRequest({
				credentialId: CRED_ID,
				label: "origin",
				bucket: "media",
				role: "OUTPUT",
			}),
		);
		expect(res.status).toBe(201);
		expect(create).toHaveBeenCalledWith({
			data: {
				credentialId: CRED_ID,
				label: "origin",
				bucket: "media",
				prefix: "",
				role: "OUTPUT",
			},
		});
	});
});
