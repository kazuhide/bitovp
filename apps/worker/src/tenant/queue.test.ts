import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { tenantQueue } from "./queue";
import { runInOrganization } from "./scope";

const A = "ef984a2c-1d65-4f48-8eae-0f4be5c80432",
	B = "aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed";
describe("worker queue producers", () => {
	it("stamps each concurrent producer without changing IDs, names or options", async () => {
		const add = vi.fn(async (...args: unknown[]) => args);
		const addBulk = vi.fn(async (jobs) => jobs);
		const queue = tenantQueue({ add, addBulk } as unknown as Queue);
		const payload = { encodingJobId: "same-old-payload" };
		const opts = { jobId: "same-old-dedup" };
		await Promise.all(
			[A, B].map((id) =>
				runInOrganization(id, () => queue.add("encode", payload, opts)),
			),
		);
		expect(add.mock.calls).toEqual([
			["encode", { organizationId: A, payload }, opts],
			["encode", { organizationId: B, payload }, opts],
		]);
		await runInOrganization(B, () =>
			queue.addBulk([{ name: "encode", data: payload, opts }]),
		);
		expect(addBulk).toHaveBeenCalledWith([
			{ name: "encode", data: { organizationId: B, payload }, opts },
		]);
		expect(() => queue.add("encode", payload)).toThrow("Organization context");
	});
	it("cannot supply a foreign envelope through single or bulk producers", () => {
		const add = vi.fn(),
			addBulk = vi.fn();
		const queue = tenantQueue({ add, addBulk } as unknown as Queue);
		const data = { organizationId: B, payload: {} };
		expect(() => runInOrganization(A, () => queue.add("encode", data))).toThrow(
			"already wrapped",
		);
		expect(() =>
			runInOrganization(A, () => queue.addBulk([{ name: "encode", data }])),
		).toThrow("already wrapped");
		expect(add).not.toHaveBeenCalled();
		expect(addBulk).not.toHaveBeenCalled();
	});
});
it("cannot inspect or remove a foreign queue job during scoped recovery", async () => {
	const rawJob = {
		id: "owned-id",
		data: { organizationId: A, payload: { encodingJobId: "owned-id" } },
		getState: vi.fn(async () => "completed"),
		remove: vi.fn(async () => {}),
	};
	const queue = tenantQueue({ getJob: async () => rawJob } as unknown as Queue);
	expect(
		await runInOrganization(B, () => queue.getJob("owned-id")),
	).toBeUndefined();
	const owned = await runInOrganization(A, () => queue.getJob("owned-id"));
	expect(owned?.data).toEqual({ encodingJobId: "owned-id" });
	expect(() => runInOrganization(B, () => owned?.remove())).toThrow(
		"Tenant queue job unavailable",
	);
	await runInOrganization(A, () => owned?.remove());
	expect(rawJob.remove).toHaveBeenCalledOnce();
});
