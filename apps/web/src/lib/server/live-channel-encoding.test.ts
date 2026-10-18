import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const bitmovinClientForAccount = vi.fn();

vi.mock("./bitmovin", () => ({
	bitmovinClientForAccount: (...args: unknown[]) =>
		bitmovinClientForAccount(...args),
}));

import { resolveLiveEncoding } from "./live-channel-encoding";

const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ACCOUNT_A = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ACCOUNT_B = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";

// biome-ignore lint/suspicious/noExplicitAny: minimal ServerContext stand-in
const ctx = { prisma: { liveChannel: { findUnique } } } as any;

function resolve(bitmovinAccountId: string) {
	return resolveLiveEncoding({
		ctx,
		channelId: CHANNEL_ID,
		bitmovinAccountId,
		requireRunning: true,
		subject: "ESAM media points",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	bitmovinClientForAccount.mockResolvedValue({ encoding: {} });
});

describe("resolveLiveEncoding", () => {
	it("resolves a RUNNING channel whose account matches", async () => {
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: "bm-enc",
			bitmovinAccountId: ACCOUNT_A,
		});
		const result = await resolve(ACCOUNT_A);
		expect(result.ok).toBe(true);
		expect(bitmovinClientForAccount).toHaveBeenCalledWith(ctx, ACCOUNT_A);
	});

	it("refuses a channel whose account is NULL instead of accepting any caller account", async () => {
		// The column is String? with onDelete: SetNull and the account-delete
		// route has no referential guard, so a deleted account nulls it. If null
		// meant "matches anything", account B's decrypted key would drive account
		// A's encoding and the audit row would be written under B.
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: "bm-enc",
			bitmovinAccountId: null,
		});
		const result = await resolve(ACCOUNT_B);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected a refusal");
		}
		expect(result.response.status).toBe(409);
		await expect(result.response.json()).resolves.toMatchObject({
			error: expect.stringContaining("no Bitmovin account"),
		});
		// Never builds a client for the caller-supplied account.
		expect(bitmovinClientForAccount).not.toHaveBeenCalled();
	});

	it("refuses a cross-account request", async () => {
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: "bm-enc",
			bitmovinAccountId: ACCOUNT_A,
		});
		const result = await resolve(ACCOUNT_B);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected a refusal");
		}
		expect(result.response.status).toBe(400);
		expect(bitmovinClientForAccount).not.toHaveBeenCalled();
	});

	it("404s an unknown channel, 409s a non-RUNNING one and one without an encoding", async () => {
		findUnique.mockResolvedValue(null);
		const missing = await resolve(ACCOUNT_A);
		expect(missing.ok === false && missing.response.status).toBe(404);

		findUnique.mockResolvedValue({
			status: "STOPPED",
			bitmovinEncodingId: "bm-enc",
			bitmovinAccountId: ACCOUNT_A,
		});
		const stopped = await resolve(ACCOUNT_A);
		expect(stopped.ok === false && stopped.response.status).toBe(409);

		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: null,
			bitmovinAccountId: ACCOUNT_A,
		});
		const noEncoding = await resolve(ACCOUNT_A);
		expect(noEncoding.ok === false && noEncoding.response.status).toBe(409);
		expect(bitmovinClientForAccount).not.toHaveBeenCalled();
	});

	it("keeps the connected-ingest refusal free of internal registry references", async () => {
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: "bm-enc",
			bitmovinAccountId: ACCOUNT_A,
			lastHeartbeat: null,
			runs: [{ lastHeartbeat: null }],
		});

		const result = await resolveLiveEncoding({
			ctx,
			channelId: CHANNEL_ID,
			bitmovinAccountId: ACCOUNT_A,
			requireRunning: true,
			requireIngestConnected: true,
			subject: "Scheduling insertable content",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a refusal");
		const body = (await result.response.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toMatch(/CONNECTED ingest/);
		expect(body.error).not.toMatch(/ledger|STATUS #|task #/i);
		expect(body.details.code).toBe("LIVE_RUNTIME_INGEST_NOT_CONNECTED");
	});
});
