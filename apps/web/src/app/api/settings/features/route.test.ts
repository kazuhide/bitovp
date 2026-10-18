import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  / review-265 131-A6. The invariant worth pinning is the MERGE:
 * a PATCH that names one flag must not reset the others to their defaults.
 * Harmless with one flag; load-bearing the moment P11 adds a second, and by
 * then nobody will remember the upsert wrote a whole object.
 */
let stored: unknown = { qcVmaf: true, futureFlag: "kept-by-the-db" };
const upsert = vi.fn(
	async (args: { create: { value: unknown }; update: { value: unknown } }) => {
		stored = args.update.value ?? args.create.value;
		return { key: "featureFlags", value: stored };
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
	return new Request("http://test/api/settings/features", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	stored = { qcVmaf: true };
	upsert.mockClear();
	auditCreate.mockClear();
});

describe("/api/settings/features (ledger #131)", () => {
	it("GET reports the stored flags", async () => {
		const body = await (await GET()).json();
		expect(body.qcVmaf).toBe(true);
	});

	it("GET degrades a malformed row to defaults rather than 500ing the settings screen", async () => {
		stored = "not an object";
		const res = await GET();
		expect(res.status).toBe(200);
		expect((await res.json()).qcVmaf).toBe(false);
	});

	it("PATCH merges onto the CURRENT value, never onto the defaults", async () => {
		stored = { qcVmaf: true };
		// A patch that names NOTHING must leave the flag alone — this is the
		// case that fails if the route ever spreads DEFAULT_FEATURE_FLAGS.
		await PATCH(patchRequest({}));
		expect(
			(upsert.mock.calls[0]?.[0] as { update: { value: { qcVmaf: boolean } } })
				.update.value.qcVmaf,
		).toBe(true);
	});

	it("PATCH writes the change and audits it — an app-wide switch belongs in the trail", async () => {
		stored = { qcVmaf: false };
		const res = await PATCH(patchRequest({ qcVmaf: true }));
		expect(res.status).toBe(200);
		expect((await res.json()).qcVmaf).toBe(true);
		expect(auditCreate).toHaveBeenCalledTimes(1);
	});

	it("PATCH rejects a non-boolean rather than storing it", async () => {
		const res = await PATCH(patchRequest({ qcVmaf: "yes" }));
		expect(res.status).toBe(400);
		expect(upsert).not.toHaveBeenCalled();
	});
});
