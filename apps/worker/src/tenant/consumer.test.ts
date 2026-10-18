import type { AppPrismaClient } from "@bitovp/db";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createTenantConsumer } from "./consumer";
import { currentOrganizationId } from "./scope";

const A = "ef984a2c-1d65-4f48-8eae-0f4be5c80432";
const B = "aa14e5f0-e526-4af1-886c-a9a1f2f9e1ed";
const ID = "7fb72f93-a388-46b1-a5b0-e50b1b27e751";

function setup() {
	const findFirst = vi.fn(async () =>
		currentOrganizationId() === A ? { id: ID } : null,
	);
	const prisma = { encodingJob: { findFirst } } as unknown as AppPrismaClient;
	const handler = vi.fn(async (job: Job) => {
		await Promise.resolve();
		return {
			data: job.data,
			organizationId: currentOrganizationId(),
			id: job.id,
		};
	});
	const forEachOrganization = vi.fn(async (run: () => unknown) => {
		await run();
	});
	return {
		findFirst,
		handler,
		forEachOrganization,
		consumer: createTenantConsumer({ prisma, forEachOrganization }),
	};
}

describe("tenant consumer admission", () => {
	it("unwraps only after checking the owning row and retains BullMQ identity", async () => {
		const { consumer, handler, findFirst } = setup();
		const result = await consumer(
			"orchestrator",
			handler,
		)({
			id: "original-dedup",
			name: "orchestrate",
			data: { organizationId: A, payload: { encodingJobId: ID } },
		} as Job);
		expect(result).toEqual({
			id: "original-dedup",
			data: { encodingJobId: ID },
			organizationId: A,
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: { id: ID },
			select: { id: true },
		});
		expect(currentOrganizationId()).toBeUndefined();
	});
	it("a forged org/resource pair never reaches the processor or provider", async () => {
		const { consumer, handler } = setup();
		await expect(
			consumer(
				"orchestrator",
				handler,
			)({
				name: "orchestrate",
				data: { organizationId: B, payload: { encodingJobId: ID } },
			} as Job),
		).rejects.toThrow("Tenant resource unavailable");
		expect(handler).not.toHaveBeenCalled();
	});
	it("missing context fails closed; an explicit legacy admission is default-org only", async () => {
		const { consumer, handler, findFirst, forEachOrganization } = setup();
		const job = { name: "orchestrate", data: { encodingJobId: ID } } as Job;
		await expect(consumer("orchestrator", handler)(job)).rejects.toThrow();
		expect(handler).not.toHaveBeenCalled();
		const legacy = createTenantConsumer({
			prisma: { encodingJob: { findFirst } } as unknown as AppPrismaClient,
			forEachOrganization,
			legacyOrganizationId: A,
		});
		await legacy("orchestrator", handler)(job);
		expect(handler).toHaveBeenCalledOnce();
		await expect(
			legacy(
				"orchestrator",
				handler,
			)({
				...job,
				data: { organizationId: "invalid", payload: job.data },
			} as Job),
		).rejects.toThrow();
	});
	it("a manually named sweep cannot invoke the system dispatcher", async () => {
		const { consumer, handler, forEachOrganization } = setup();
		await expect(
			consumer(
				"liveChannel",
				handler,
			)({ name: "heartbeat-sweep", data: { systemSweep: "heartbeat" } } as Job),
		).rejects.toThrow();
		expect(forEachOrganization).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});
});

it.each([
	["liveChannel", { liveChannelId: ID }, "liveChannel"],
	["vmafRunner", { vmafJobId: ID }, "vmafJob"],
	["feederManager", { feederSessionId: ID, action: "stop" }, "feederSession"],
	["storageInspect", { storageInspectionId: ID }, "storageInspection"],
	["slateNormalize", { slateNormalizationId: ID }, "slateNormalization"],
	[
		"usageStatistics",
		{ accountId: ID, from: "2026-10-01", to: "2026-10-02", generation: ID },
		"bitmovinAccount",
	],
	[
		"notify",
		{
			kind: "JOB_FINISHED",
			eventVersion: 1,
			occurredAt: "2026-10-04T00:00:00.000Z",
			link: "https://example.invalid/vod",
			jobId: ID,
			name: "test",
			labels: [],
		},
		"encodingJob",
	],
] as const)("%s rejects foreign primary identity before processor", async (key, payload, model) => {
	const handler = vi.fn();
	const findFirst = vi.fn(async () => null);
	const consumer = createTenantConsumer({
		prisma: { [model]: { findFirst } } as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
	});
	await expect(
		consumer(key, handler)({ data: { organizationId: B, payload } } as Job),
	).rejects.toThrow();
	expect(findFirst).toHaveBeenCalledOnce();
	expect(handler).not.toHaveBeenCalled();
});
it("startup batch cannot use another tenant's saved configuration", async () => {
	const handler = vi.fn();
	const consumer = createTenantConsumer({
		prisma: {
			appSetting: { findUnique: async () => null },
		} as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
	});
	await expect(
		consumer(
			"startupProbe",
			handler,
		)({
			data: {
				organizationId: B,
				payload: { requestId: ID, regions: ["AWS_EU_WEST_1"], perRegion: 1 },
			},
		} as Job),
	).rejects.toThrow("Tenant resource unavailable");
	expect(handler).not.toHaveBeenCalled();
});
it("trusted repeatables visit each organization without sharing mutable scope", async () => {
	const { runInOrganization } = await import("./scope");
	const handler = vi.fn(async () => currentOrganizationId());
	const seen: string[] = [];
	const consumer = createTenantConsumer({
		prisma: {} as AppPrismaClient,
		forEachOrganization: async (run) => {
			for (const org of [A, B])
				await runInOrganization(org, async () => {
					await run();
					seen.push(currentOrganizationId() ?? "");
				});
		},
	});
	await consumer(
		"liveChannel",
		handler,
	)({
		name: "heartbeat-sweep",
		repeatJobKey: "live-heartbeat-sweep",
		data: { systemSweep: "heartbeat" },
	} as Job);
	expect(handler).toHaveBeenCalledTimes(2);
	expect(seen).toEqual([A, B]);
	expect(currentOrganizationId()).toBeUndefined();
});
it("reserves one feeder STOP slot globally, delays excess starts and releases capacity", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const handler = vi.fn(async (job: Job) => {
		if (job.data.action === "start") await held;
		return job.data.action;
	});
	const consumer = createTenantConsumer({
		prisma: {
			feederSession: { findFirst: async () => ({ id: ID }) },
		} as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
	});
	const wrap = (action: string, org = A) =>
		({
			data: { organizationId: org, payload: { feederSessionId: ID, action } },
			token: "active-lock",
			moveToDelayed: vi.fn(async () => {}),
		}) as unknown as Job;
	const starts = Array.from({ length: 7 }, (_, i) =>
		consumer("feederManager", handler)(wrap("start", i % 2 ? A : B)),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const excess = wrap("start", B);
	await expect(consumer("feederManager", handler)(excess)).rejects.toThrow(
		"bullmq:movedToDelayed",
	);
	expect(excess.moveToDelayed).toHaveBeenCalledOnce();
	expect(await consumer("feederManager", handler)(wrap("stop", B))).toBe(
		"stop",
	);
	release();
	await Promise.all(starts);
	expect(
		await consumer("feederManager", async () => "new-start")(wrap("start")),
	).toBe("new-start");
});
it("fresh inactive metadata suppresses pending VOD before SDK execution and persists ERROR", async () => {
	const findFirst = vi.fn(async () => ({ id: ID }));
	const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
	const active = vi.fn(async () => false);
	const handler = vi.fn();
	const consumer = createTenantConsumer({
		prisma: {
			encodingJob: {
				findFirst,
				findUnique: async () => ({
					status: "QUEUED",
					cancelRequested: false,
					bitmovinEncodingId: null,
					stepLog: [],
				}),
				updateMany,
			},
		} as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
		isOrganizationActive: active,
	});
	await expect(
		consumer(
			"orchestrator",
			handler,
		)({ data: { organizationId: A, payload: { encodingJobId: ID } } } as Job),
	).rejects.toThrow("Organization is inactive");
	expect(active).toHaveBeenCalledWith(A);
	expect(handler).not.toHaveBeenCalled();
	expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
		where: { id: ID },
		data: { status: "ERROR" },
	});
});
it("inactive organization still accepts STOP and in-flight provider continuation", async () => {
	const handler = vi.fn(async () => "continued");
	const findFirst = async () => ({ id: ID });
	const consumer = createTenantConsumer({
		prisma: {
			liveChannel: { findFirst },
			encodingJob: {
				findFirst,
				findUnique: async () => ({
					status: "RUNNING",
					cancelRequested: false,
					bitmovinEncodingId: "already-started",
					stepLog: [{ kind: "START_ENCODING", status: "DONE" }],
				}),
			},
		} as unknown as AppPrismaClient,
		forEachOrganization: async () => {},
		isOrganizationActive: async () => false,
	});
	expect(
		await consumer(
			"liveChannel",
			handler,
		)({
			data: {
				organizationId: B,
				payload: { liveChannelId: ID, action: "stop" },
			},
		} as Job),
	).toBe("continued");
	expect(
		await consumer(
			"orchestrator",
			handler,
		)({ data: { organizationId: B, payload: { encodingJobId: ID } } } as Job),
	).toBe("continued");
	expect(handler).toHaveBeenCalledTimes(2);
});
