import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Live heartbeat cadence. The invariants worth pinning: the
 * resolved view names its source (gui > env > default), a PUT stores exactly
 * the validated pair and leaves an audit row, an invalid body neither writes
 * nor audits, and DELETE is "back to the deployment default" with its own
 * audit row.
 */
let stored: unknown = null;
const upsert = vi.fn(async (args: { create: { value: unknown } }) => {
	stored = args.create.value;
	return { key: "live:heartbeat-webhook", value: stored };
});
const deleteMany = vi.fn(async () => {
	const count = stored === null ? 0 : 1;
	stored = null;
	return { count };
});
const auditCreate = vi.fn(async (_args: unknown) => ({ id: "a1" }));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: {
				findUnique: async () => (stored === null ? null : { value: stored }),
				upsert,
				deleteMany,
			},
			auditLog: { create: auditCreate },
		},
	}),
}));

import { DELETE, GET, PUT } from "./route";

function request(method: "PUT" | "DELETE", body?: unknown): Request {
	return new Request("http://test/api/settings/live-heartbeat", {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

beforeEach(() => {
	stored = null;
	upsert.mockClear();
	deleteMany.mockClear();
	auditCreate.mockClear();
	vi.unstubAllEnvs();
	vi.stubEnv("HEARTBEAT_WEBHOOK_INTERVAL_S", "");
	vi.stubEnv("HEARTBEAT_WEBHOOK_IDLE_MINUTES", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/settings/live-heartbeat", () => {
	it.each([
		undefined,
		"PER_ENCODING",
		"AUTO",
		"LEGACY_ACCOUNT",
	])("normalizes mode %s to per-encoding without losing cadence", async (mode) => {
		const response = await PUT(
			request("PUT", { intervalS: 20, idleMinutes: 60, mode }),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).effective).toEqual({
			intervalS: 20,
			idleMinutes: 60,
			mode: "PER_ENCODING",
		});
	});
	it("reads an old account-mode OFF setting as per-encoding without enabling it", async () => {
		stored = { mode: "LEGACY_ACCOUNT", intervalS: 0, idleMinutes: 120 };
		const body = await (await GET()).json();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 0,
			idleMinutes: 120,
		});
		expect(body.source).toBe("gui");
	});
	it("GET with no row and no env is the code default and says so, with the bounds the form needs", async () => {
		const body = await (await GET()).json();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 20,
			idleMinutes: 60,
		});
		expect(body.source).toBe("default");
		expect(body.stored).toBeNull();
		expect(body.bounds).toEqual({
			minIntervalS: 1,
			maxIntervalS: 3600,
			maxIdleMinutes: 10080,
		});
	});

	it("GET with no row reports the deployment env as the effective value and its source", async () => {
		vi.stubEnv("HEARTBEAT_WEBHOOK_INTERVAL_S", "off");
		vi.stubEnv("HEARTBEAT_WEBHOOK_IDLE_MINUTES", "30");
		const body = await (await GET()).json();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 0,
			idleMinutes: 30,
		});
		expect(body.source).toBe("env");
		expect(body.envDefault).toEqual({
			mode: "PER_ENCODING",
			intervalS: 0,
			idleMinutes: 30,
		});
	});

	it("PUT stores exactly the validated pair, audits it, and the response is the gui-sourced view over the env", async () => {
		vi.stubEnv("HEARTBEAT_WEBHOOK_INTERVAL_S", "5");
		const res = await PUT(request("PUT", { intervalS: 30, idleMinutes: 120 }));
		expect(res.status).toBe(200);
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert.mock.calls[0]?.[0]).toMatchObject({
			where: { key: "live:heartbeat-webhook" },
			create: {
				key: "live:heartbeat-webhook",
				value: { intervalS: 30, idleMinutes: 120 },
			},
			update: { value: { intervalS: 30, idleMinutes: 120 } },
		});
		expect(auditCreate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(auditCreate.mock.calls[0]?.[0])).toContain(
			"/api/settings/live-heartbeat",
		);
		const body = await res.json();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 30,
			idleMinutes: 120,
		});
		expect(body.source).toBe("gui");
		expect(body.envDefault).toEqual({
			mode: "PER_ENCODING",
			intervalS: 5,
			idleMinutes: 60,
		});
	});

	it("PUT accepts 0 as the OFF switch", async () => {
		const res = await PUT(request("PUT", { intervalS: 0, idleMinutes: 60 }));
		expect(res.status).toBe(200);
		expect((await res.json()).effective).toEqual({
			intervalS: 0,
			idleMinutes: 60,
			mode: "PER_ENCODING",
		});
	});

	it.each([
		["fractional interval", { intervalS: 2.5, idleMinutes: 60 }],
		["interval above the bound", { intervalS: 3601, idleMinutes: 60 }],
		["negative interval", { intervalS: -1, idleMinutes: 60 }],
		["idle below 1", { intervalS: 20, idleMinutes: 0 }],
		["idle above the bound", { intervalS: 20, idleMinutes: 10081 }],
		["a string", { intervalS: "20", idleMinutes: 60 }],
		["a missing field", { intervalS: 20 }],
		["an extra field", { intervalS: 20, idleMinutes: 60, extra: 1 }],
		["an unknown mode", { intervalS: 20, idleMinutes: 60, mode: "FORCE" }],
		["no body", undefined],
	])("PUT refuses %s with 400 and writes nothing — no row, no audit", async (_label, body) => {
		const res = await PUT(request("PUT", body));
		expect(res.status).toBe(400);
		expect(upsert).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("DELETE removes the row, audits, and the view falls back to the deployment default", async () => {
		stored = { intervalS: 30, idleMinutes: 120 };
		vi.stubEnv("HEARTBEAT_WEBHOOK_IDLE_MINUTES", "15");
		const res = await DELETE(request("DELETE"));
		expect(res.status).toBe(200);
		expect(deleteMany).toHaveBeenCalledTimes(1);
		expect(auditCreate).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(auditCreate.mock.calls[0]?.[0])).toContain(
			'"removed":1',
		);
		const body = await res.json();
		expect(body.stored).toBeNull();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 20,
			idleMinutes: 15,
		});
		expect(body.source).toBe("default");
	});

	it("a malformed row is the deployment default, not a 500 on the settings screen", async () => {
		stored = "garbage";
		const body = await (await GET()).json();
		expect(body.effective).toEqual({
			mode: "PER_ENCODING",
			intervalS: 20,
			idleMinutes: 60,
		});
		expect(body.source).toBe("default");
		expect(body.stored).toBeNull();
		// hb-sec 3: the row exists, so the screen can still offer DELETE
		expect(body.hasRow).toBe(true);
	});

	it("GET reports hasRow false with no row and true with a parseable one", async () => {
		expect((await (await GET()).json()).hasRow).toBe(false);
		stored = { intervalS: 30, idleMinutes: 120 };
		expect((await (await GET()).json()).hasRow).toBe(true);
	});
});
