import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const informationGet = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
});

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		account = { information: { get: informationGet } };
	},
}));

import { POST } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const params = { params: Promise.resolve({ id: ID }) };
const req = () => new Request("http://test", { method: "POST" });

describe("POST /api/bitmovin-accounts/[id]/test", () => {
	it("returns ok with latency and email, never the key", async () => {
		getAccount.mockResolvedValueOnce({ id: ID, tenantOrgId: null });
		revealApiKey.mockResolvedValueOnce("super-secret-key");
		informationGet.mockResolvedValueOnce({ email: "ops@example.com" });

		const res = await POST(req(), params);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Object.keys(body).sort()).toEqual([
			"accountEmail",
			"latencyMs",
			"ok",
		]);
		expect(body.ok).toBe(true);
		expect(JSON.stringify(body)).not.toContain("super-secret-key");
	});

	it("maps API failure to ok:false with a curated message", async () => {
		getAccount.mockResolvedValueOnce({ id: ID, tenantOrgId: null });
		revealApiKey.mockResolvedValueOnce("super-secret-key");
		const sdkError = Object.assign(
			new Error(
				"request:\n method: GET\n url: https://api.bitmovin.com\n body: {SHOULD_NOT_LEAK}",
			),
			{ httpStatusCode: 401, shortMessage: "Invalid API key" },
		);
		informationGet.mockRejectedValueOnce(sdkError);

		const res = await POST(req(), params);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.message).toBe(
			"Authentication failed (401) — check API key and org id",
		);
		expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
		expect(JSON.stringify(body)).not.toContain("super-secret-key");
	});

	it("404s for unknown accounts before any decryption", async () => {
		getAccount.mockResolvedValueOnce(null);
		const res = await POST(req(), params);
		expect(res.status).toBe(404);
		expect(revealApiKey).not.toHaveBeenCalled();
	});
});
