import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const update = vi.fn();
const remove = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		credentials: { get, update, remove },
	}),
}));

import { DELETE, GET, PATCH } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function patchRequest(body: unknown): Request {
	return new Request(`http://test/api/credentials/${ID}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

describe("PATCH /api/credentials/[id]", () => {
	it("rejects non-uuid ids without touching the store", async () => {
		const res = await PATCH(patchRequest({ label: "x" }), params("../etc"));
		expect(res.status).toBe(400);
		expect(get).not.toHaveBeenCalled();
	});

	it("404s on unknown credentials", async () => {
		get.mockResolvedValueOnce(null);
		const res = await PATCH(patchRequest({ label: "x" }), params(ID));
		expect(res.status).toBe(404);
	});

	it("updates label/config without re-encrypting the secret", async () => {
		get.mockResolvedValueOnce({ id: ID, provider: "AWS_S3" });
		update.mockResolvedValueOnce({ id: ID });
		const res = await PATCH(
			patchRequest({ label: "renamed", config: { region: "eu-west-1" } }),
			params(ID),
		);
		expect(res.status).toBe(200);
		expect(update).toHaveBeenCalledWith(ID, {
			label: "renamed",
			config: { region: "eu-west-1" },
			secret: undefined,
		});
	});

	it("re-serializes the secret when re-keying", async () => {
		get.mockResolvedValueOnce({ id: ID, provider: "AWS_S3" });
		update.mockResolvedValueOnce({ id: ID });
		await PATCH(
			patchRequest({
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			}),
			params(ID),
		);
		expect(update).toHaveBeenCalledWith(ID, {
			label: undefined,
			config: undefined,
			secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "s" }),
		});
	});

	it("rejects a secret of the wrong shape for the row's provider", async () => {
		get.mockResolvedValueOnce({ id: ID, provider: "AZURE_BLOB" });
		const res = await PATCH(
			patchRequest({ secret: { secretAccessKey: "wrong" } }),
			params(ID),
		);
		expect(res.status).toBe(400);
		expect(update).not.toHaveBeenCalled();
	});

	it("returns a stable locale-owned code when a Generic S3 endpoint is blocked", async () => {
		vi.stubEnv("STORAGE_ENDPOINT_ALLOWED_HOSTS", "allowed.example.com");
		get.mockResolvedValueOnce({ id: ID, provider: "GENERIC_S3" });
		const res = await PATCH(
			patchRequest({ config: { host: "blocked.example.com", ssl: true } }),
			params(ID),
		);
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			details: { code: "STORAGE_ENDPOINT_NOT_ALLOWED" },
		});
		expect(update).not.toHaveBeenCalled();
	});
});

describe("GET/DELETE /api/credentials/[id]", () => {
	it("GET 404s when missing", async () => {
		get.mockResolvedValueOnce(null);
		const res = await GET(new Request("http://test"), params(ID));
		expect(res.status).toBe(404);
	});

	it("DELETE returns 204", async () => {
		remove.mockResolvedValueOnce(undefined);
		const res = await DELETE(new Request("http://test"), params(ID));
		expect(res.status).toBe(204);
	});
});
