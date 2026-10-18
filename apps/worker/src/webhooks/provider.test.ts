import BitmovinApi from "@bitmovin/api-sdk";
import { WEBHOOK_REGISTRATION_KINDS } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import {
	createRegistrarProvider,
	heartbeatApi,
	perEncodingApi,
	REQUIRED_HEARTBEAT_METHODS,
	REQUIRED_PER_ENCODING_METHODS,
	registrarFetch,
	WEBHOOK_REGISTRAR_ACTOR,
} from "./provider";

/**
 * Review-187 C1's lesson, applied to the per-encoding surface: the mock must
 * not manufacture what the SDK does not have. The structural probe walks the
 * REAL pinned SDK object; the behavioural arms use a fake `makeApi`.
 */
describe("per-encoding kinds × the real SDK surface", () => {
	const api = new BitmovinApi({ apiKey: "structural-probe-only" });
	for (const kind of WEBHOOK_REGISTRATION_KINDS) {
		it(`${kind} exposes ${REQUIRED_PER_ENCODING_METHODS.join("/")} on the pinned SDK`, () => {
			const target = perEncodingApi(api, kind) as unknown as Record<
				string,
				unknown
			>;
			expect(target, kind).toBeDefined();
			for (const method of REQUIRED_PER_ENCODING_METHODS) {
				expect(typeof target[method], `${kind}.${method}`).toBe("function");
			}
		});
	}

	it("heartbeat exposes account retirement and per-encoding SDK contracts", () => {
		const group = api.notifications.webhooks.encoding
			.encodings as unknown as Record<string, Record<string, unknown>>;
		for (const method of [
			"createByEncodingId",
			"listByEncodingId",
			"getByEncodingIdAndWebhookId",
			"deleteByEncodingIdAndWebhookId",
		]) {
			expect(typeof group.liveEncodingHeartbeat?.[method]).toBe("function");
		}
		expect(
			typeof (
				group.liveEncodingHeartbeat?.customdata as Record<string, unknown>
			)?.getCustomDataByEncodingIdAndWebhookId,
		).toBe("function");
		const target = heartbeatApi(api) as unknown as Record<string, unknown>;
		for (const method of REQUIRED_HEARTBEAT_METHODS) {
			expect(typeof target[method], `liveEncodingHeartbeat.${method}`).toBe(
				"function",
			);
		}
	});
});

describe("per-encoding heartbeat wire", () => {
	it("preserves a two-second interval through the real SDK with object customData, HMAC and explicit POST/TLS", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const meta = {
			bitOvp: {
				v: 1 as const,
				registrationId: "reg",
				channelId: "channel",
				runId: "run",
			},
		};
		const fetchStub = async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			const result = url.endsWith("/customData")
				? { customData: meta }
				: init.method === "GET"
					? { items: [] }
					: { id: "hook-1" };
			return new Response(
				JSON.stringify({ status: "SUCCESS", data: { result } }),
				{ status: 200 },
			);
		};
		const provider = await createRegistrarProvider({
			prisma: {
				auditLog: { create: vi.fn(async () => ({})) },
			} as unknown as AppPrismaClient,
			revealBitmovinAccount: async () => ({
				apiKey: "fake",
				tenantOrgId: null,
			}),
			makeApi: () => new BitmovinApi({ apiKey: "fake", fetch: fetchStub }),
		})("account");
		await provider.createEncodingHeartbeat("enc", {
			name: "Bitmovin OVP reg",
			url: "https://receiver.invalid/hb/token",
			interval: 2,
			signature: { type: "HMAC", key: "secret" },
			customData: meta,
		});
		expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
			interval: 2,
			customData: meta,
			method: "POST",
			insecureSsl: false,
			signature: { type: "HMAC", key: "secret" },
		});
		expect(calls[0]?.url).toMatch(/\/encodings\/enc\/live-encoding-heartbeat$/);
		expect(
			await provider.getEncodingHeartbeatCustomData("enc", "hook-1"),
		).toEqual(meta);
		await provider.listEncodingHeartbeats("enc");
		await provider.removeEncodingHeartbeat("enc", "hook-1");
		expect(calls[1]?.url).toMatch(
			/\/encodings\/enc\/live-encoding-heartbeat\/hook-1\/customData$/,
		);
		expect(calls[3]?.init.method).toBe("DELETE");
	});
	it("does not repeat the heartbeat POST on response loss", async () => {
		const lost = vi.fn(async () => {
			throw new Error("response lost");
		});
		await expect(
			registrarFetch(lost)(
				"https://api.bitmovin.com/v1/notifications/webhooks/encoding/encodings/enc/live-encoding-heartbeat",
				{ method: "POST" },
			),
		).rejects.toThrow("response lost");
		expect(lost).toHaveBeenCalledTimes(1);
	});
});

function fakeSdk() {
	const createByEncodingId = vi.fn(async () => ({ id: "wh-1" }));
	const deleteByEncodingIdAndWebhookId = vi.fn(async () => ({}));
	const heartbeatCreate = vi.fn(async () => ({ id: "hb-1" }));
	const heartbeatDelete = vi.fn(async () => ({}));
	const kind = () => ({ createByEncodingId, deleteByEncodingIdAndWebhookId });
	const api = {
		notifications: {
			webhooks: {
				encoding: {
					encodings: {
						...Object.fromEntries(
							WEBHOOK_REGISTRATION_KINDS.map((k) => [k, kind()]),
						),
						liveEncodingHeartbeat: {
							create: heartbeatCreate,
							createByEncodingId,
							deleteByWebhookId: heartbeatDelete,
						},
					},
				},
			},
		},
	} as unknown as BitmovinApi;
	return {
		api,
		createByEncodingId,
		deleteByEncodingIdAndWebhookId,
		heartbeatCreate,
		heartbeatDelete,
	};
}

describe("createRegistrarProvider", () => {
	const auditRows: Record<string, unknown>[] = [];
	const prisma = {
		auditLog: {
			create: async (args: { data: Record<string, unknown> }) => {
				auditRows.push(args.data);
				return args.data;
			},
		},
	} as unknown as AppPrismaClient;
	const reveal = vi.fn(async () => ({ apiKey: "k", tenantOrgId: "org" }));

	it("creates with url + HMAC signature, audits the call with the KEY redacted, under the registrar actor", async () => {
		auditRows.length = 0;
		const sdk = fakeSdk();
		const makeApi = vi.fn(() => sdk.api);
		const providerFor = createRegistrarProvider({
			prisma,
			revealBitmovinAccount: reveal,
			makeApi,
		});
		const provider = await providerFor("acct-1");
		expect(makeApi).toHaveBeenCalledWith({ apiKey: "k", tenantOrgId: "org" });
		const result = await provider.create("enc-1", "finished", {
			url: "https://x/api/webhooks/bitmovin/j/AAAAAAAAAAAAAAAAAAAAAA",
			signature: { type: "HMAC", key: "s3cret-key" },
		});
		expect(result).toEqual({ id: "wh-1" });
		expect(sdk.createByEncodingId).toHaveBeenCalledWith("enc-1", {
			url: "https://x/api/webhooks/bitmovin/j/AAAAAAAAAAAAAAAAAAAAAA",
			signature: { type: "HMAC", key: "s3cret-key" },
		});
		expect(auditRows).toHaveLength(1);
		const row = auditRows[0] as Record<string, unknown>;
		expect(row.actor).toBe(WEBHOOK_REGISTRAR_ACTOR);
		expect(row.method).toBe("POST");
		expect(row.path).toBe(
			"/notifications/webhooks/encoding/encodings/enc-1/finished",
		);
		expect(JSON.stringify(row)).not.toContain("s3cret-key");
		expect(JSON.stringify(row)).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
	});

	it.each([
		"encoding",
		"heartbeat",
		"delete",
	] as const)("withholds nested exception text from the %s audit without changing propagation", async (operation) => {
		auditRows.length = 0;
		const sdk = fakeSdk();
		const canary = "SYNTHETIC_AUDIT_SECRET_CANARY";
		const failure = Object.assign(
			new Error(
				JSON.stringify({
					requestBody: JSON.stringify({
						signature: { key: canary },
						url: `https://example.invalid/${canary}`,
					}),
				}),
			),
			{ httpStatusCode: 409 },
		);
		sdk.createByEncodingId.mockRejectedValue(failure);
		sdk.heartbeatDelete.mockRejectedValue(failure);
		sdk.deleteByEncodingIdAndWebhookId.mockRejectedValue(failure);
		const provider = await createRegistrarProvider({
			prisma,
			revealBitmovinAccount: reveal,
			makeApi: () => sdk.api,
		})("acct-1");
		const payload = {
			url: `https://example.invalid/${canary}`,
			signature: { type: "HMAC" as const, key: canary },
		};
		const call =
			operation === "encoding"
				? provider.create("enc-1", "finished", payload)
				: operation === "heartbeat"
					? provider.removeHeartbeat("hb-old")
					: provider.remove("enc-1", "finished", "wh-1");
		await expect(call).rejects.toBe(failure);
		expect(auditRows).toHaveLength(1);
		expect(auditRows[0]).toMatchObject({
			statusCode: 409,
			error: "Webhook provider operation failed",
		});
		expect(JSON.stringify(auditRows)).not.toContain(canary);
	});

	it("remove treats a 404 as success and audits it; other errors propagate", async () => {
		auditRows.length = 0;
		const sdk = fakeSdk();
		sdk.deleteByEncodingIdAndWebhookId
			.mockRejectedValueOnce(
				Object.assign(new Error("not found"), { httpStatusCode: 404 }),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("boom"), { httpStatusCode: 500 }),
			);
		const provider = await createRegistrarProvider({
			prisma,
			revealBitmovinAccount: reveal,
			makeApi: () => sdk.api,
		})("acct-1");
		await expect(
			provider.remove("enc-1", "error", "wh-9"),
		).resolves.toBeUndefined();
		await expect(provider.remove("enc-1", "error", "wh-9")).rejects.toThrow(
			"boom",
		);
		expect(auditRows.map((r) => r.statusCode)).toEqual([404, 500]);
	});

	it("a create that returns no id is an error, not a silent ACTIVE row", async () => {
		const sdk = fakeSdk();
		sdk.createByEncodingId.mockResolvedValueOnce({} as { id: string });
		const provider = await createRegistrarProvider({
			prisma,
			revealBitmovinAccount: reveal,
			makeApi: () => sdk.api,
		})("acct-1");
		await expect(
			provider.create("enc-1", "finished", {
				url: "https://x/y",
				signature: { type: "HMAC", key: "k" },
			}),
		).rejects.toThrow(/no webhook id/);
	});

	it("has no account CREATE adapter and retains audited exact-ID retirement with 404 tolerance", async () => {
		auditRows.length = 0;
		const sdk = fakeSdk();
		const provider = await createRegistrarProvider({
			prisma,
			revealBitmovinAccount: reveal,
			makeApi: () => sdk.api,
		})("acct-1");
		expect("createHeartbeat" in provider).toBe(false);
		sdk.heartbeatDelete.mockRejectedValueOnce(
			Object.assign(new Error("gone"), { httpStatusCode: 404 }),
		);
		await expect(provider.removeHeartbeat("hb-old")).resolves.toBeUndefined();
		expect(sdk.heartbeatDelete).toHaveBeenCalledWith("hb-old");
		expect(sdk.heartbeatCreate).not.toHaveBeenCalled();
		expect(auditRows[0]).toMatchObject({ method: "DELETE", statusCode: 404 });
	});
});
