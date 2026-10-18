import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  — the features route's invariants, on the player row: the
 * MERGE (a PATCH naming one field must not reset the others), degradation
 * to defaults, and the audit write. Plus this route's own property: the
 * licence keys are PUBLIC CLIENT keys (C26), so GET returns them readable
 * — asserting that here keeps someone from "fixing" it into redaction.
 */
let stored: unknown = {};
const upsert = vi.fn(
	async (args: { create: { value: unknown }; update: { value: unknown } }) => {
		stored = args.update.value ?? args.create.value;
		return { key: "playerSettings", value: stored };
	},
);
const auditCreate = vi.fn(async () => ({ id: "a1" }));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: {
				findUnique: async () => ({ value: stored }),
				upsert,
			},
			auditLog: { create: auditCreate },
		},
	}),
}));

import { GET, PATCH } from "./route";

function patchRequest(body: unknown): Request {
	return new Request("http://test/api/settings/player", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	stored = {
		provider: "bitmovin",
		playerLicenseKey: "pk-1",
		analyticsLicenseKey: "ak-1",
	};
	upsert.mockClear();
	auditCreate.mockClear();
});

describe("/api/settings/player (ledger #59)", () => {
	it("GET returns the keys READABLE — public client class, never redacted (C26)", async () => {
		const body = await (await GET()).json();
		expect(body).toEqual({
			provider: "bitmovin",
			playerLicenseKey: "pk-1",
			analyticsLicenseKey: "ak-1",
		});
	});

	it("GET degrades a malformed row to the native defaults", async () => {
		stored = 42;
		const res = await GET();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			provider: "native",
			playerLicenseKey: "",
			analyticsLicenseKey: "",
		});
	});

	it("PATCH merges onto the CURRENT value — naming one field keeps the others", async () => {
		const res = await PATCH(patchRequest({ provider: "native" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			provider: "native",
			playerLicenseKey: "pk-1",
			analyticsLicenseKey: "ak-1",
		});
	});

	it("an empty PATCH changes nothing (absent means absent — 131-A6's rule)", async () => {
		const res = await PATCH(patchRequest({}));
		expect(await res.json()).toEqual({
			provider: "bitmovin",
			playerLicenseKey: "pk-1",
			analyticsLicenseKey: "ak-1",
		});
	});

	it("PATCH refuses an unknown provider at the schema", async () => {
		const res = await PATCH(patchRequest({ provider: "flash" }));
		expect(res.status).toBe(400);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("PATCH writes the audit trail — a player switch changes what every preview does", async () => {
		await PATCH(patchRequest({ playerLicenseKey: "pk-2" }));
		expect(auditCreate).toHaveBeenCalled();
	});
});
