import { beforeEach, describe, expect, it, vi } from "vitest";

/**  PR4: the registration surface (list/register/unregister). */

const listMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
const clientForAccount = vi.fn();
const auditWrites: unknown[] = [];
vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: (...args: unknown[]) => clientForAccount(...args),
	// The real signature: audit-log both directions, curated errors out.
	auditedBitmovinCall: async (options: {
		method: string;
		path: string;
		request?: unknown;
		call: () => Promise<unknown>;
	}) => {
		try {
			const result = await options.call();
			auditWrites.push({
				method: options.method,
				path: options.path,
				request: options.request,
			});
			return { ok: true, result };
		} catch (err) {
			auditWrites.push({ method: options.method, error: true });
			return {
				ok: false,
				response: new Response(
					JSON.stringify({ error: err instanceof Error ? err.message : "x" }),
					{ status: 502 },
				),
			};
		}
	},
	bitmovinProxyError: (err: unknown) =>
		new Response(
			JSON.stringify({
				error: `proxied: ${err instanceof Error ? err.message : "x"}`,
			}),
			{ status: 500 },
		),
}));
vi.mock("@/lib/server/context", () => ({ getServerContext: () => ({}) }));
/**
 * WP-G G-1: the endpoint comes from the PERSISTED ingress + the master
 * secret (`accountReceiver`), not from PUBLIC_BASE_URL — so the seam this
 * test controls is the ingress lib. `null` = no public ingress resolved.
 */
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
const KEY = "0123456789abcdef".repeat(4);
const ENDPOINT = `https://ovp.example.com/api/webhooks/bitmovin/acct/${TOKEN}`;
const LEGACY_ENDPOINT = "https://ovp.example.com/api/webhooks/bitmovin";
let receiver: {
	endpoint: string;
	legacyEndpoint: string;
	signatureKey: string;
	secretSource: "env" | "generated";
} | null = null;
// rev407 #3: the key-bearing target is a separate function that only POST
// calls; the key-free receiver is what GET (and the settings page) see.
const accountReceiver = vi.fn(async () =>
	receiver
		? {
				endpoint: receiver.endpoint,
				legacyEndpoint: receiver.legacyEndpoint,
				secretSource: receiver.secretSource,
			}
		: null,
);
vi.mock("@/lib/server/ingress", () => ({
	accountReceiver: () => accountReceiver(),
	readCurrentIngress: async () => ({
		v: 1,
		mode: "static",
		current: {
			baseUrl: "https://ovp.example.com",
			source: "PUBLIC_BASE_URL",
			observedAt: "2026-09-02T09:00:00.000Z",
		},
		checkedAt: "2026-09-02T09:00:30.000Z",
	}),
}));

import * as routeModule from "./route";
import { DELETE, GET } from "./route";

function makeApi() {
	const kind = () => ({
		list: listMock,
		create: createMock,
		deleteByWebhookId: deleteMock,
	});
	// The mock mirrors the REAL capability split (review-187 C1: the first
	// cut handed every kind an identical full triad and shipped a feature
	// that could not run — liveInputStreamChanged has create ONLY, and it
	// stays here in that shape so a kind swap back into REGISTRATION_KINDS
	// without the triad breaks THESE tests too, not just the SDK probe).
	return {
		notifications: {
			webhooks: {
				encoding: {
					encodings: {
						finished: kind(),
						error: kind(),
						transferError: kind(),
						liveManifestReady: kind(),
						liveInputStreamChanged: { create: createMock },
					},
				},
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	auditWrites.length = 0;
	receiver = {
		endpoint: ENDPOINT,
		legacyEndpoint: LEGACY_ENDPOINT,
		signatureKey: KEY,
		secretSource: "generated",
	};
	clientForAccount.mockResolvedValue(makeApi());
	listMock.mockResolvedValue({ items: [] });
	createMock.mockResolvedValue({ id: "wh-1" });
});

describe("GET /api/webhook-registration", () => {
	it("lists all four kinds, flags OUR endpoint (signed and legacy), and never leaks the key", async () => {
		listMock.mockResolvedValue({
			items: [
				{ id: "wh-ours", url: ENDPOINT },
				{ id: "wh-legacy", url: LEGACY_ENDPOINT },
				{ id: "wh-other", url: "https://elsewhere.example.com/hook" },
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
			),
		);
		const text = await res.text();
		// The signature key is derived server-side and handed to Bitmovin ONLY.
		expect(text).not.toContain(KEY);
		const body = JSON.parse(text) as {
			endpoint: string;
			legacyEndpoint: string;
			secretSource: string;
			ingress: { mode: string; baseUrl: string | null } | null;
			rows: { kind: string; id: string; ours: boolean; legacy: boolean }[];
		};
		expect(body.endpoint).toBe(ENDPOINT);
		expect(body.legacyEndpoint).toBe(LEGACY_ENDPOINT);
		expect(body.secretSource).toBe("generated");
		expect(body.ingress).toMatchObject({
			mode: "static",
			baseUrl: "https://ovp.example.com",
		});
		// 4 kinds × 3 items each (the mock repeats per kind).
		expect(body.rows).toHaveLength(12);
		// IDENTITY, not a count (review-187 I2/M1b: the 4-of-8 count is
		// symmetric under a fully INVERTED flag).
		for (const row of body.rows) {
			expect(row.ours, row.id).toBe(row.id !== "wh-other");
			expect(row.legacy, row.id).toBe(row.id === "wh-legacy");
		}
		expect(listMock).toHaveBeenCalledTimes(4);
		// C6: bounded page on every list.
		expect(listMock).toHaveBeenCalledWith({ offset: 0, limit: 100 });
	});

	it("with no public ingress, GET still lists (nothing is ours) and says endpoint: null", async () => {
		receiver = null;
		listMock.mockResolvedValue({ items: [{ id: "wh-x", url: ENDPOINT }] });
		const res = await GET(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
			),
		);
		const body = (await res.json()) as {
			endpoint: string | null;
			rows: { ours: boolean }[];
		};
		expect(body.endpoint).toBeNull();
		expect(body.rows.every((row) => row.ours === false)).toBe(true);
	});

	it("400s a missing/invalid account id", async () => {
		const res = await GET(
			new Request("http://test/api/webhook-registration?bitmovinAccountId=x"),
		);
		expect(res.status).toBe(400);
		expect(clientForAccount).not.toHaveBeenCalled();
	});

	it("routes failures through bitmovinProxyError — our bugs are logged, not 'unreachable'", async () => {
		// review-187 I1: the hand-rolled 502 turned OUR TypeErrors into a
		// false upstream-outage report with no server-side log.
		listMock.mockRejectedValue(new Error("raw sdk with request body"));
		const res = await GET(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
			),
		);
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: string }).error).toContain(
			"proxied:",
		);
	});

	it("DELETE 400s an invalid account id before any client call (review-187 N4)", async () => {
		expect(
			(
				await DELETE(
					new Request(
						"http://test/api/webhook-registration?bitmovinAccountId=x",
						{
							method: "DELETE",
							body: JSON.stringify({ kind: "finished", webhookId: "wh-1" }),
						},
					),
				)
			).status,
		).toBe(400);
		expect(clientForAccount).not.toHaveBeenCalled();
	});

	it("the account-level POST is GONE (WP-G G-2): the module exports no POST, so nothing can register the standard set", () => {
		expect(Object.keys(routeModule).sort()).toEqual(["DELETE", "GET"]);
	});

	it("DELETE writes the audit trail (review-187 I4)", async () => {
		await DELETE(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
				{
					method: "DELETE",
					body: JSON.stringify({ kind: "finished", webhookId: "wh-1" }),
				},
			),
		);
		expect(auditWrites).toEqual([
			expect.objectContaining({ method: "DELETE" }),
		]);
	});
});

describe("DELETE /api/webhook-registration", () => {
	it("unregisters by kind + webhookId", async () => {
		const res = await DELETE(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
				{
					method: "DELETE",
					body: JSON.stringify({ kind: "finished", webhookId: "wh-1" }),
				},
			),
		);
		expect(res.status).toBe(204);
		expect(deleteMock).toHaveBeenCalledWith("wh-1");
	});

	it("refuses a kind outside the standard set", async () => {
		const res = await DELETE(
			new Request(
				`http://test/api/webhook-registration?bitmovinAccountId=${ACCOUNT}`,
				{
					method: "DELETE",
					body: JSON.stringify({ kind: "everything", webhookId: "wh-1" }),
				},
			),
		);
		expect(res.status).toBe(400);
		expect(deleteMock).not.toHaveBeenCalled();
	});
});
