import { beforeEach, describe, expect, it, vi } from "vitest";

let current: Record<string, unknown> | null = null;
const audit = vi.fn(async () => ({}));
const prisma = {
	vmafExecutionProfile: {
		findMany: async (args?: { where?: { resetAt?: unknown } }) =>
			current && (!args?.where || !current.resetAt) ? [current] : [],
		findUnique: async () => current,
		create: async ({ data }: { data: Record<string, unknown> }) => {
			current = data;
			return data;
		},
		update: async ({ data }: { data: Record<string, unknown> }) => {
			current = { ...current, ...data };
			return current;
		},
	},
	$transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
	auditLog: { create: audit },
};
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma }),
}));

import { GET, POST } from "./route";

const profile = {
	id: "aws",
	label: "AWS",
	provider: "AWS_BATCH",
	image: `registry/worker@sha256:${"a".repeat(64)}`,
	region: "eu-west-1",
	cpu: 4,
	memoryMiB: 8192,
	diskGiB: 100,
	maxParallel: 8,
	timeoutSeconds: 3600,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 1,
	overheadUsd: 0,
	transferUsdPerGiB: 0,
	maxStagingGiB: 80,
	staging: { provider: "S3", bucket: "private", region: "eu-west-1" },
	jobQueue: "queue",
	jobDefinition: "definition:1",
};
const request = (body: unknown) =>
	new Request("http://test/api/settings/vmaf-profiles", {
		method: "POST",
		body: JSON.stringify(body),
	});
beforeEach(() => {
	current = null;
	audit.mockClear();
});
describe("named cloud profile HTTP contract", () => {
	it("hides reset tombstones from the API and recreates them without reviving stale edits", async () => {
		current = {
			id: "aws",
			label: "old",
			config: profile,
			version: 4,
			enabled: false,
			resetAt: new Date(),
		};
		expect(await (await GET()).json()).toEqual({ items: [] });
		expect((await POST(request({ profile, expectedVersion: 4 }))).status).toBe(
			409,
		);
		expect((await POST(request({ profile }))).status).toBe(200);
		expect(await (await GET()).json()).toMatchObject({
			items: [{ id: "aws", version: 5, resetAt: null }],
		});
	});
	it("lists metadata and returns 409 for stale edits instead of overwriting newer config", async () => {
		expect((await POST(request({ profile }))).status).toBe(200);
		expect(await (await GET()).json()).toMatchObject({
			items: [{ id: "aws", version: 1, config: { profileVersion: 1 } }],
		});
		expect(
			(
				await POST(
					request({
						profile: { ...profile, label: "New" },
						expectedVersion: 1,
					}),
				)
			).status,
		).toBe(200);
		expect((await POST(request({ profile, expectedVersion: 1 }))).status).toBe(
			409,
		);
		expect(current).toMatchObject({ label: "New", version: 2 });
		expect(audit).toHaveBeenCalledTimes(2);
	});
	it("rejects embedded secret values without echoing them", async () => {
		const response = await POST(
			request({ profile: { ...profile, secretAccessKey: "secret" } }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("secretAccessKey");
		expect(current).toBeNull();
	});
});
