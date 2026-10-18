import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The aggregate infrastructure candidate list . Three contracts:
 * the allow-list sanitization (an SDK model field must not leak by default),
 * the skip-not-fail behaviour per family (a missing Cloud Connect entitlement
 * must not blank the picker), and the id-less-row drop.
 */

const getAccount = vi.fn();
const revealApiKey = vi.fn();

const awsList = vi.fn();
const azureList = vi.fn();
const gceList = vi.fn();
const akamaiList = vi.fn();
const ociList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			infrastructure: {
				aws: { list: awsList },
				azure: { list: azureList },
				gce: { list: gceList },
				akamai: { list: akamaiList },
				oci: { list: ociList },
			},
		};
	},
}));

import { GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

function get() {
	return GET(
		new Request(
			`http://test/api/infrastructure/infrastructures?bitmovinAccountId=${ACCOUNT_ID}`,
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID });
	revealApiKey.mockResolvedValue("api-key");
	for (const list of [awsList, azureList, gceList, akamaiList, ociList]) {
		list.mockResolvedValue({ items: [] });
	}
});

describe("GET /api/infrastructure/infrastructures", () => {
	it("aggregates the families with a kind tag, SANITIZED to id/name/kind", async () => {
		awsList.mockResolvedValue({
			items: [
				{
					id: "aws-1",
					name: "prod-vpc",
					// Fields that must NOT leak: the allow-list is the rail.
					accessKeyId: "AKIA-SECRET",
					securityGroupId: "sg-123",
				},
			],
		});
		gceList.mockResolvedValue({
			items: [{ id: "gce-1", name: null }],
		});
		const res = await get();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Record<string, unknown>[];
			skipped: string[];
		};
		const aws = body.items.find((item) => item.id === "aws-1");
		expect(aws).toEqual({ id: "aws-1", name: "prod-vpc", kind: "AWS" });
		expect(JSON.stringify(body)).not.toContain("AKIA-SECRET");
		expect(JSON.stringify(body)).not.toContain("sg-123");
		expect(body.items.find((item) => item.id === "gce-1")).toEqual({
			id: "gce-1",
			name: null,
			kind: "GCE",
		});
		expect(body.skipped).toEqual([]);
		// The response SHAPE is the contract (review of PR #176, I4): a new
		// field is a new leak channel and must fail here by name.
		expect(Object.keys(body).sort()).toEqual(["items", "skipped"]);
	});

	it("a family that errors is SKIPPED by name, never fatal", async () => {
		ociList.mockRejectedValue(new Error("403 no entitlement"));
		akamaiList.mockRejectedValue(new Error("404"));
		awsList.mockResolvedValue({ items: [{ id: "aws-1", name: "x" }] });
		const res = await get();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: unknown[];
			skipped: string[];
		};
		expect(body.items).toHaveLength(1);
		expect([...body.skipped].sort()).toEqual(["AKAMAI", "OCI"]);
		// Error text must never ride ANY field (review I4's M6: a leak in a
		// NEW response field survived the items-only check).
		expect(JSON.stringify(body)).not.toContain("no entitlement");
		expect(Object.keys(body).sort()).toEqual(["items", "skipped"]);
	});

	it("drops id-less rows — an unpickable candidate is noise", async () => {
		awsList.mockResolvedValue({ items: [{ name: "no-id" }, { id: "ok" }] });
		const res = await get();
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.map((item) => item.id)).toEqual(["ok"]);
	});

	it("a LOCAL failure keeps the sibling taxonomy — 503 for key config, MASTER_KEY text for decrypt (review-176 R1)", async () => {
		// The outer catch is routeError, NOT bitmovinProxyError: replacing it
		// with a generic 500 passed all prior tests (their M13).
		const { MasterKeyConfigError, SecretDecryptError } = await import(
			"@bitovp/core"
		);
		getAccount.mockRejectedValue(new MasterKeyConfigError("bad key"));
		const res1 = await get();
		expect(res1.status).toBe(503);
		getAccount.mockRejectedValue(new SecretDecryptError());
		const res2 = await get();
		expect(res2.status).toBe(500);
		expect(JSON.stringify(await res2.json())).toContain("MASTER_KEY");
	});

	it("404s an unknown account and 400s a missing account id", async () => {
		getAccount.mockResolvedValue(null);
		expect((await get()).status).toBe(404);
		const res = await GET(
			new Request("http://test/api/infrastructure/infrastructures"),
		);
		expect(res.status).toBe(400);
	});
});
