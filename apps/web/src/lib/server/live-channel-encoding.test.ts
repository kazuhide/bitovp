import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const owner = {
	actorUserId: OWNER_ID,
	effectiveUserId: OWNER_ID,
	actor: `user:${OWNER_ID}`,
	role: "ADMIN",
	actorRole: "ADMIN",
	isImpersonating: false,
};
const otherAdmin = {
	...owner,
	actorUserId: OTHER_ID,
	effectiveUserId: OTHER_ID,
	actor: `user:${OTHER_ID}`,
};
const managedChannel = {
	origin: "MANAGED",
	plan: {
		start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
	},
	status: "RUNNING",
	bitmovinEncodingId: "bm-enc",
	bitmovinAccountId: ACCOUNT_A,
};

// biome-ignore lint/suspicious/noExplicitAny: minimal ServerContext stand-in
const ctx = { tenant: owner, prisma: { liveChannel: { findUnique } } } as any;

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
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "true");
	vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", OWNER_ID);
	ctx.tenant = owner;
	bitmovinClientForAccount.mockResolvedValue({ encoding: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe("resolveLiveEncoding", () => {
	it.each([
		["other ADMIN", otherAdmin, "true"],
		[
			"other OPERATOR",
			{ ...otherAdmin, role: "OPERATOR", actorRole: "OPERATOR" },
			"true",
		],
		["flag off", owner, "false"],
		["token actor", { ...owner, actor: "token:synthetic" }, "true"],
		["impersonation", { ...owner, isImpersonating: true }, "true"],
		["missing principal", undefined, "true"],
	])("denies managed mutations for %s before provider work, retaining reads", async (_label, tenant, flag) => {
		ctx.tenant = tenant;
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", flag);
		findUnique.mockResolvedValue(managedChannel);
		for (const mutation of ["encoding", "graph"] as const) {
			const result = await resolveLiveEncoding({
				ctx,
				channelId: CHANNEL_ID,
				bitmovinAccountId: ACCOUNT_A,
				requireRunning: true,
				mutation,
				subject: "Runtime mutation",
			});
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected owner refusal");
			expect(result.response.status).toBe(404);
			expect(await result.response.json()).toEqual({ error: "Not found" });
			expect(bitmovinClientForAccount).not.toHaveBeenCalled();
		}
		const read = await resolve(ACCOUNT_A);
		expect(read.ok).toBe(true);
		expect(bitmovinClientForAccount).toHaveBeenCalledWith(ctx, ACCOUNT_A);
	});

	it("keeps ordinary Live mutations available without the preview flag or owner", async () => {
		ctx.tenant = { ...otherAdmin, role: "OPERATOR", actorRole: "OPERATOR" };
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW", "false");
		vi.stubEnv("BITOVP_AISA_LIVE_PREVIEW_USER_ID", "");
		findUnique.mockResolvedValue({ ...managedChannel, plan: {} });
		const result = await resolveLiveEncoding({
			ctx,
			channelId: CHANNEL_ID,
			bitmovinAccountId: ACCOUNT_A,
			requireRunning: true,
			mutation: "encoding",
			subject: "Runtime mutation",
		});
		expect(result.ok).toBe(true);
		expect(bitmovinClientForAccount).toHaveBeenCalledWith(ctx, ACCOUNT_A);
	});

	it("allows encoding-only operations on managed AISA while retaining imported history read-only", async () => {
		for (const origin of ["MANAGED", "AISA_IMPORTED"]) {
			findUnique.mockResolvedValue({
				origin,
				plan: {
					start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
				},
				status: "RUNNING",
				bitmovinEncodingId: "bm-enc",
				bitmovinAccountId: ACCOUNT_A,
			});
			bitmovinClientForAccount.mockClear();
			const result = await resolveLiveEncoding({
				ctx,
				channelId: CHANNEL_ID,
				bitmovinAccountId: ACCOUNT_A,
				requireRunning: true,
				mutation: "encoding",
				subject: "Stopping inserted content",
			});
			expect(result.ok).toBe(origin === "MANAGED");
			if (origin === "AISA_IMPORTED") {
				expect(bitmovinClientForAccount).not.toHaveBeenCalled();
				if (result.ok) throw new Error("expected imported history refusal");
				expect(await result.response.json()).toMatchObject({
					details: { code: "AISA_IMPORTED_READ_ONLY" },
				});
			}
		}
	});
	it("explicitly guards AISA mutations before resolving provider credentials while keeping reads", async () => {
		for (const channel of [
			{ origin: "AISA_IMPORTED", plan: null },
			{
				origin: "MANAGED",
				plan: {
					start: { aiSceneAnalysisLive: { preset: "AISA_PREVIEW_MANAGED" } },
				},
			},
		]) {
			findUnique.mockResolvedValue({
				...channel,
				status: "RUNNING",
				bitmovinEncodingId: "bm-enc",
				bitmovinAccountId: ACCOUNT_A,
			});
			bitmovinClientForAccount.mockClear();
			const mutation = await resolveLiveEncoding({
				ctx,
				channelId: CHANNEL_ID,
				bitmovinAccountId: ACCOUNT_A,
				requireRunning: true,
				mutation: "graph",
				subject: "Neutral operation label",
			});
			expect(mutation.ok).toBe(false);
			if (mutation.ok) throw new Error("expected refusal");
			expect(mutation.response.status).toBe(409);
			expect(bitmovinClientForAccount).not.toHaveBeenCalled();
			const read = await resolveLiveEncoding({
				ctx,
				channelId: CHANNEL_ID,
				bitmovinAccountId: ACCOUNT_A,
				requireRunning: false,
				subject: "Registering insertable content",
			});
			expect(read.ok).toBe(true);
		}
	});
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
