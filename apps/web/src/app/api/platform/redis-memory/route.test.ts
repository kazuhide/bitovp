import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	issueSession,
	sessionCookieName,
	signSession,
} from "@/lib/auth/session";
import { GET } from "./route";

const fake = vi.hoisted(() => ({
	user: vi.fn(),
	connect: vi.fn(),
	info: vi.fn(),
	disconnect: vi.fn(),
	options: vi.fn(),
}));
vi.mock("@/lib/auth/users", () => ({ resolveUserByIdFresh: fake.user }));
vi.mock("ioredis", () => ({
	Redis: class {
		constructor(url: string, options: object) {
			fake.options(url, options);
		}
		on() {}
		connect = fake.connect;
		info = fake.info;
		disconnect = fake.disconnect;
	},
}));

const SECRET = "synthetic-platform-memory-owner-session-key";
const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const actor = {
	active: true,
	role: "ADMIN",
	platformOwner: true,
	mustChangePassword: false,
	sessionGeneration: 1,
	sessionsValidFromMs: 0,
};
function cookie(impersonating = false) {
	const now = Date.now();
	const payload = issueSession({
		mode: "users",
		sub: ACTOR,
		now,
		idleMs: 60_000,
		maxMs: 60_000,
		sessionGeneration: 1,
		organizationId: ORG,
		...(impersonating
			? {
					targetUserId: TARGET,
					impersonationExpiresAt: now + 20_000,
					returnOrganizationId: ORG,
				}
			: {}),
	});
	return `${sessionCookieName(false)}=${signSession(payload, SECRET)}`;
}
function read(headers: Record<string, string> = { cookie: cookie() }) {
	return GET(
		new Request("http://localhost/api/platform/redis-memory", { headers }),
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	fake.user.mockResolvedValue(actor);
	fake.connect.mockResolvedValue(undefined);
	fake.info.mockResolvedValue(
		"# Memory\r\nused_memory:1024\r\nmaxmemory:2048\r\nprivate_host:example\r\n",
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
describe("installation Redis memory", () => {
	it("reads only memory under a human owner's session and returns only the two counters", async () => {
		const res = await read();
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(await res.json()).toEqual({ usedBytes: 1024, limitBytes: 2048 });
		expect(fake.info).toHaveBeenCalledExactlyOnceWith("memory");
		expect(fake.disconnect).toHaveBeenCalledOnce();
		expect(fake.options.mock.calls[0]?.[1]).toMatchObject({
			enableReadyCheck: false,
			enableOfflineQueue: false,
			maxRetriesPerRequest: 0,
		});
	});
	it("accepts zero as explicit absence of a Redis limit", async () => {
		fake.info.mockResolvedValue("used_memory:1234\r\nmaxmemory:0\r\n");
		expect(await (await read()).json()).toEqual({
			usedBytes: 1234,
			limitBytes: null,
		});
	});
	it.each([
		"maxmemory:0",
		"used_memory:2\nmaxmemory:-1",
		"used_memory:NaN\nmaxmemory:0",
		"used_memory:9007199254740992\nmaxmemory:0",
	])("reports incomplete or invalid INFO as unavailable", async (info) => {
		fake.info.mockResolvedValue(info);
		expect((await read()).status).toBe(503);
		expect(fake.disconnect).toHaveBeenCalledOnce();
	});
	it("returns a bounded unavailable response when the connection never settles", async () => {
		vi.useFakeTimers();
		fake.connect.mockImplementation(() => new Promise(() => {}));
		const pending = read();
		await vi.advanceTimersByTimeAsync(3_000);
		expect((await pending).status).toBe(503);
		expect(fake.disconnect).toHaveBeenCalledOnce();
		expect(fake.info).not.toHaveBeenCalled();
	});
	it("does not disclose raw Redis errors", async () => {
		fake.info.mockRejectedValue(new Error("sensitive host details"));
		const response = await read();
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("sensitive");
		expect(fake.disconnect).toHaveBeenCalledOnce();
	});
	it("refuses a missing login, API tokens, and single-user modes before Redis", async () => {
		expect((await read({})).status).toBe(401);
		for (const token of ["bo_synthetic", "boe_synthetic"]) {
			expect(
				(await read({ authorization: `Bearer ${token}`, cookie: cookie() }))
					.status,
			).toBe(403);
		}
		vi.stubEnv("AUTH_MODE", "none");
		expect((await read()).status).toBe(403);
		expect(fake.options).not.toHaveBeenCalled();
	});
	it("refuses a tenant admin, forced rotation, and owner view-as before Redis", async () => {
		fake.user.mockResolvedValueOnce({ ...actor, platformOwner: false });
		expect((await read()).status).toBe(403);
		fake.user.mockResolvedValueOnce({ ...actor, mustChangePassword: true });
		expect((await read()).status).toBe(403);
		expect((await read({ cookie: cookie(true) })).status).toBe(403);
		expect(fake.options).not.toHaveBeenCalled();
	});
});
