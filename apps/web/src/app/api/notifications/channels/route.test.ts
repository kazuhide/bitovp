import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 *  PR1: channel CRUD. The provider gate is the security-relevant
 * pin — a channel must reference a NOTIFICATION_WEBHOOK credential, because
 * the C22 URL validation hangs off that provider's secret schema.
 */

const findUnique = vi.fn();
const create = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			credential: { findUnique },
			notificationChannel: { findMany, create },
		},
	}),
}));

import { GET, POST } from "./route";

const CRED = "00000000-0000-4000-8000-0000000000d1";

function post(body: unknown) {
	return POST(
		new Request("http://test/api/notifications/channels", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	);
}

const VALID = {
	name: "ops hook",
	kind: "GENERIC_WEBHOOK",
	credentialId: CRED,
	rules: [{ events: ["JOB_ERROR", "CHANNEL_ERROR"] }],
};

beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue({ provider: "NOTIFICATION_WEBHOOK" });
	create.mockImplementation(async ({ data }) => ({
		id: "00000000-0000-4000-8000-0000000000c1",
		name: data.name,
		kind: data.kind,
		enabled: true,
		rules: [{ id: "r1", events: data.rules.create[0].events }],
	}));
});

describe("POST /api/notifications/channels", () => {
	it("creates a channel with rules against a NOTIFICATION_WEBHOOK credential", async () => {
		const res = await post(VALID);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { rules: { events: string[] }[] };
		expect(body.rules[0]?.events).toEqual(["JOB_ERROR", "CHANNEL_ERROR"]);
	});

	it("REFUSES a credential of any other provider (the C22 rails hang off it)", async () => {
		findUnique.mockResolvedValue({ provider: "AWS_S3" });
		const res = await post(VALID);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("refuses an event kind outside the union", async () => {
		const res = await post({
			...VALID,
			rules: [{ events: ["JOB_EXPLODED"] }],
		});
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("404s a missing credential", async () => {
		findUnique.mockResolvedValue(null);
		const res = await post(VALID);
		expect(res.status).toBe(404);
	});
});

describe("GET /api/notifications/channels", () => {
	it("lists channels secret-free (credential LABEL, never the URL)", async () => {
		findMany.mockResolvedValue([
			{
				id: "c1",
				name: "ops hook",
				kind: "GENERIC_WEBHOOK",
				credentialId: CRED,
				// SECRET MATERIAL in the fixture (review-183 I5/M6: without it,
				// the not-toContain assertion was unfalsifiable — a widened
				// select leaking the secret stayed green because the mock never
				// carried one).
				credential: {
					label: "slack-ops",
					encryptedSecret: "enc:https://hooks.example.com/services/T/B/XXX",
				},
				enabled: true,
				rules: [{ id: "r1", events: ["JOB_ERROR"], filter: {}, enabled: true }],
			},
		]);
		const res = await GET();
		const body = (await res.json()) as Record<string, unknown>[];
		expect(body[0]?.credentialLabel).toBe("slack-ops");
		expect(JSON.stringify(body)).not.toContain("hooks.example.com");
	});
});
