import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";

/**
 *  / rev425. The route maps the provider's answers onto the
 * reconcile contract through core's classifier (TERMINAL = stopped;
 * RUNNING/QUEUED = running, i.e. not proven stopped; CREATED = stopped (never
 * started, nothing to stop — rev431); an unclassified
 * or missing status and a 404 = unverified with a curated message; other
 * failures = unverified with the SDK's message), audits once, and refuses
 * API tokens like the reset itself.
 */
const auditCreate = vi.fn(async (_args?: unknown) => ({ id: "audit-1" }));
const account = {
	id: "acct",
	updatedAt: new Date("2026-08-01T00:00:00Z"),
	tenantOrgId: null,
	encryptedApiKey: "never-output-ciphertext",
};
const accountRead = vi.fn();
const entityGet = vi.fn();
const encodingList = vi.fn();
let status: (id: string) => Promise<{ status?: string }>;
vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: async (_ctx: unknown, accountId: string) =>
		accountId === "acct"
			? {
					encoding: {
						encodings: {
							status: (id: string) => status(id),
							get: entityGet,
							list: encodingList,
						},
					},
				}
			: null,
	bitmovinErrorMessage: (err: unknown) =>
		`Bitmovin API error (${(err as { httpStatusCode?: number }).httpStatusCode})`,
}));
const reconcile = vi.fn();
vi.mock("@/lib/server/reset", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	reconcileEncoderPointers: (...args: unknown[]) => reconcile(...args),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			auditLog: { create: auditCreate },
			bitmovinAccount: { findUnique: accountRead },
		},
	}),
}));

import { POST } from "./route";

function request(actor = "session"): Request {
	return new Request("http://test/api/admin/reset/reconcile", {
		method: "POST",
		headers: { [ACTOR_HEADER]: actor },
	});
}
const pointer = (
	id: string,
	kind = "encodingJob",
	account: string | null = "acct",
) => ({
	kind,
	id,
	name: `n-${id}`,
	status: "CANCELED",
	bitmovinEncodingId: `enc-${id}`,
	bitmovinAccountId: account,
});

beforeEach(() => {
	auditCreate.mockClear();
	reconcile.mockReset();
	status = async () => ({ status: "FINISHED" });
	accountRead
		.mockReset()
		.mockImplementation(async ({ where }) =>
			where.id === "acct" ? { ...account } : null,
		);
	entityGet
		.mockReset()
		.mockRejectedValue({ httpStatusCode: 404, errorCode: 1001 });
	encodingList.mockReset().mockResolvedValue({ items: [] });
});

describe("POST /api/admin/reset/reconcile (row #313)", () => {
	it("hands exact missing evidence to the reconciler but exposes neither account nor ciphertext", async () => {
		status = async () => {
			throw { httpStatusCode: 404, errorCode: 1001 };
		};
		reconcile.mockImplementation(async (_prisma, read) => {
			expect(await read("acct", "enc-missing")).toEqual({
				kind: "missing",
				account,
			});
			return { confirmed: [pointer("missing")], running: [], unverified: [] };
		});
		const response = await POST(request());
		expect(response.status).toBe(200);
		const text = JSON.stringify(await response.json());
		expect(text).not.toMatch(
			/ciphertext|encryptedApiKey|tenantOrgId|bitmovinAccountId/,
		);
		expect(entityGet).toHaveBeenCalledWith("enc-missing");
		expect(encodingList).toHaveBeenCalledWith({ limit: 1 });
	});
	it("reads the provider status per pointer through the reader it hands to the reconcile, and answers the customer shape", async () => {
		reconcile.mockImplementation(
			async (_prisma, read: (a: string, e: string) => Promise<unknown>) => {
				status = async (id) => {
					if (id === "enc-run") return { status: "RUNNING" };
					if (id === "enc-queued") return { status: "QUEUED" };
					if (id === "enc-created") return { status: "CREATED" };
					if (id === "enc-error") return { status: "ERROR" };
					if (id === "enc-blank") return {};
					if (id === "enc-odd") return { status: "PAUSED" };
					if (id === "enc-404")
						throw Object.assign(new Error("not found"), {
							httpStatusCode: 404,
						});
					if (id === "enc-500")
						throw Object.assign(new Error("boom"), { httpStatusCode: 500 });
					return { status: "CANCELED" };
				};
				const states = await Promise.all([
					read("acct", "enc-ok"),
					read("acct", "enc-error"),
					read("acct", "enc-run"),
					read("acct", "enc-queued"),
					read("acct", "enc-created"),
					read("acct", "enc-blank"),
					read("acct", "enc-odd"),
					read("acct", "enc-404"),
					read("acct", "enc-500"),
					read("missing-account", "enc-x"),
				]);
				expect(states).toEqual([
					{ kind: "stopped", providerStatus: "CANCELED" },
					{ kind: "stopped", providerStatus: "ERROR" },
					{ kind: "running", providerStatus: "RUNNING" },
					// rev425 R4: QUEUED is not stopped
					{ kind: "running", providerStatus: "QUEUED" },
					// rev431 (owner 2026-09-07): CREATED was never started — nothing to
					// stop, so it is confirmed; a retry that resumes it clears the stamp
					{ kind: "stopped", providerStatus: "CREATED" },
					// rev425 R3: no status / an unclassified word / a 404 stay closed
					{
						kind: "unverified",
						message: "Bitmovin did not report a status for this encoding",
					},
					{
						kind: "unverified",
						message:
							"Bitmovin reported a status this app does not classify (PAUSED)",
					},
					{
						kind: "unverified",
						message: "Bitmovin encoding status could not be verified",
					},
					{
						kind: "unverified",
						message: "Bitmovin encoding status could not be verified",
					},
					{
						kind: "unverified",
						message:
							"The Bitmovin account is missing or changed while preparing the lookup",
					},
				]);
				return {
					confirmed: [pointer("ok"), pointer("ch", "liveChannel")],
					running: [{ ...pointer("run"), providerStatus: "RUNNING" }],
					unverified: [
						{ ...pointer("x", "liveChannelRun", null), message: "no account" },
					],
				};
			},
		);
		const res = await POST(request());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(
			body.confirmed.map((p: { resourceType: string; id: string }) => [
				p.resourceType,
				p.id,
			]),
		).toEqual([
			["vodJob", "ok"],
			["liveChannel", "ch"],
		]);
		expect(body.running[0]).toMatchObject({
			id: "run",
			providerStatus: "RUNNING",
		});
		expect(body.unverified[0]).toMatchObject({
			id: "x",
			resourceType: "liveChannel",
			message: "no account",
		});
		expect(JSON.stringify(body)).not.toContain("bitmovinAccountId");
		expect(auditCreate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(auditCreate.mock.calls[0]?.[0])).toContain(
			"/api/admin/reset/reconcile",
		);
		expect(JSON.stringify(auditCreate.mock.calls[0]?.[0])).toContain(
			'"confirmed":2',
		);
	});

	it.each([
		"encryptedApiKey",
		"tenantOrgId",
		"updatedAt",
	])("refuses account %s drift while the ordinary client is built", async (field) => {
		accountRead.mockResolvedValueOnce({ ...account }).mockResolvedValueOnce({
			...account,
			[field]: field === "updatedAt" ? new Date("2026-08-02") : "changed",
		});
		const statusRead = vi.fn(async () => ({ status: "FINISHED" }));
		status = statusRead;
		reconcile.mockImplementation(async (_prisma, read) => {
			const state = await read("acct", "enc-id");
			expect(state.kind).toBe("unverified");
			expect(JSON.stringify(state)).not.toContain(account.encryptedApiKey);
			return { confirmed: [], running: [], unverified: [] };
		});
		expect((await POST(request())).status).toBe(200);
		expect(statusRead).not.toHaveBeenCalled();
	});

	it("refuses an API token, exactly like the reset", async () => {
		const res = await POST(request("token:abc"));
		expect(res.status).toBe(403);
		expect(reconcile).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
