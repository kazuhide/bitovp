import type { Job, Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { context } = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/tenancy", () => ({
	resolveAuthenticatedContext: context,
	DEFAULT_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
	AuthContextError: class extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message);
		}
	},
}));

import { authenticatedQueue } from "./queue";

const A = "ef984a2c-1d65-4f48-8eae-0f4be5c80432",
	B = "aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed";
const actor = (
	organizationId = A,
	role = "OPERATOR",
	isImpersonating = false,
) => ({ organizationId, role, isImpersonating });
function job(org: string, id: string, payload: unknown = { secretLabel: id }) {
	return {
		id,
		name: "encode",
		data: { organizationId: org, payload },
		remove: vi.fn(async () => {}),
		getState: vi.fn(async () => "waiting"),
	} as unknown as Job;
}
beforeEach(() => {
	context.mockReset();
	context.mockResolvedValue(actor());
	delete process.env.TENANT_MIGRATE_LEGACY_QUEUES;
});
describe("authenticated queue façade", () => {
	it("stamps add and bulk per request while preserving job IDs and unwrapped caller data", async () => {
		const add = vi.fn(async (name, data, opts) => ({
			...job(data.organizationId, opts.jobId),
			name,
			data,
		}));
		const addBulk = vi.fn(async (rows) =>
			rows.map(
				(row: {
					name: string;
					data: { organizationId: string };
					opts: { jobId: string };
				}) => ({
					...job(row.data.organizationId, row.opts.jobId),
					data: row.data,
				}),
			),
		);
		const raw = {
			add,
			addBulk,
			getJob: vi.fn(async () => undefined),
		} as unknown as Queue;
		const queue = authenticatedQueue(raw);
		const payload = { encodingJobId: "source" };
		const opts = { jobId: "old-id" };
		const added = await queue.add("encode", payload, opts);
		expect(added.data).toEqual(payload);
		expect(add).toHaveBeenCalledWith(
			"encode",
			{ organizationId: A, payload },
			opts,
		);
		context.mockResolvedValue(actor(B));
		await queue.addBulk([{ name: "encode", data: payload, opts }]);
		expect(addBulk).toHaveBeenCalledWith([
			{ name: "encode", data: { organizationId: B, payload }, opts },
		]);
	});
	it("filters foreign jobs and paginates over own rows across remote pages", async () => {
		const foreign = Array.from({ length: 200 }, (_, i) =>
			job(B, `foreign-${i}`),
		);
		const own = [job(A, "own-1"), job(B, "foreign-last"), job(A, "own-2")];
		const getJobs = vi.fn(async (_types, start) =>
			start === 0 ? foreign : own,
		);
		const queue = authenticatedQueue({
			getJobs,
			getJob: async () => foreign[0],
		} as unknown as Queue);
		expect(await queue.getJob("foreign-1")).toBeUndefined();
		const rows = await queue.getJobs(["completed"], 1, 1);
		expect(rows.map((row) => row.id)).toEqual(["own-2"]);
		expect(rows.at(0)?.data).toEqual({ secretLabel: "own-2" });
		expect(getJobs).toHaveBeenCalledTimes(2);
		expect(await queue.getJobCountByTypes("completed")).toBe(2);
	});
	it("revalidates returned job mutations and rejects view-as, viewer and changed organization", async () => {
		const rawJob = job(A, "own");
		const raw = {
			getJob: async () => rawJob,
			add: vi.fn(),
		} as unknown as Queue;
		const queue = authenticatedQueue(raw);
		const own = await queue.getJob("own");
		expect(own).toBeDefined();
		await own?.remove();
		expect(rawJob.remove).toHaveBeenCalledOnce();
		context.mockResolvedValue(actor(B));
		await expect(own?.remove()).rejects.toThrow("unavailable");
		context.mockResolvedValue(actor(A, "ADMIN", true));
		await expect(own?.remove()).rejects.toThrow("not allowed");
		await expect(queue.add("x", {})).rejects.toThrow("not allowed");
		context.mockResolvedValue(actor(A, "VIEWER"));
		await expect(queue.addBulk([{ name: "x", data: {} }])).rejects.toThrow(
			"not allowed",
		);
		expect(raw.add).not.toHaveBeenCalled();
		expect(rawJob.remove).toHaveBeenCalledOnce();
	});
	it("rejects foreign envelope injection, duplicate foreign IDs, and global administration", async () => {
		const raw = {
			getJob: async () => job(B, "collision"),
			add: vi.fn(),
			pause: vi.fn(),
			getMetrics: vi.fn(),
		} as unknown as Queue;
		const queue = authenticatedQueue(raw);
		await expect(
			queue.add("encode", { organizationId: B, payload: {} }),
		).rejects.toThrow("already wrapped");
		await expect(
			queue.add("encode", {}, { jobId: "collision" }),
		).rejects.toThrow("unavailable");
		await expect(queue.pause()).rejects.toThrow("Global queue");
		await expect(queue.getMetrics("completed")).rejects.toThrow("Global queue");
		expect(raw.add).not.toHaveBeenCalled();
		expect(raw.pause).not.toHaveBeenCalled();
	});
	it("admits legacy read only during explicit default organization migration", async () => {
		const rawJob = { ...job(A, "legacy"), data: { old: "payload" } };
		const queue = authenticatedQueue({
			getJob: async () => rawJob,
		} as unknown as Queue);
		expect(await queue.getJob("legacy")).toBeUndefined();
		process.env.TENANT_MIGRATE_LEGACY_QUEUES = "1";
		expect(await queue.getJob("legacy")).toBeUndefined();
		context.mockResolvedValue(actor("00000000-0000-4000-8000-000000000001"));
		expect((await queue.getJob("legacy"))?.data).toEqual({ old: "payload" });
	});
	it("fails closed when bounded scan cannot establish totals", async () => {
		const page = Array.from({ length: 200 }, (_, i) => job(B, `f-${i}`));
		const queue = authenticatedQueue({
			getJobs: async () => page,
		} as unknown as Queue);
		await expect(queue.getJobCountByTypes("completed")).rejects.toThrow(
			"scan exceeded",
		);
	});
});
it("concurrent requests use captured identities rather than cached Queue context", async () => {
	const add = vi.fn(async (name, data) => {
		await new Promise((resolve) =>
			setTimeout(resolve, data.organizationId === A ? 4 : 1),
		);
		return { ...job(data.organizationId, data.organizationId), data, name };
	});
	const queue = authenticatedQueue({ add } as unknown as Queue);
	context.mockResolvedValueOnce(actor(A)).mockResolvedValueOnce(actor(B));
	const jobs = await Promise.all([
		queue.add("a", { source: "A" }),
		queue.add("b", { source: "B" }),
	]);
	expect(jobs.map((item) => item.data)).toEqual([
		{ source: "A" },
		{ source: "B" },
	]);
	expect(add.mock.calls.map((call) => call[1].organizationId)).toEqual([A, B]);
});
it("job façade never exposes raw Queue/Redis handles", async () => {
	const raw = {
		...job(A, "own"),
		queue: { remove: vi.fn() },
		client: { password: "private" },
		scripts: {},
	};
	const queue = authenticatedQueue({
		getJob: async () => raw,
	} as unknown as Queue);
	const own = await queue.getJob("own");
	expect(Reflect.get(own ?? {}, "queue")).toBeUndefined();
	expect(Reflect.get(own ?? {}, "client")).toBeUndefined();
	expect(Reflect.get(own ?? {}, "scripts")).toBeUndefined();
	expect(authenticatedQueue(queue)).toBe(queue);
});
