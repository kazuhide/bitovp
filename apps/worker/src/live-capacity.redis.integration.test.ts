import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "@bitovp/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { expect, it } from "vitest";
import { reserveLiveStopCapacity } from "./live-capacity";
import { createTenantConsumer } from "./tenant/consumer";
import { currentOrganizationId } from "./tenant/scope";

function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label}`)),
					5000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

it.skipIf(!process.env.LIVE_CAPACITY_TEST_REDIS_URL)(
	"real BullMQ reserves STOP and cancellation capacity across tenants, then resumes delayed work without spending a retry",
	async () => {
		const redisUrl = process.env.LIVE_CAPACITY_TEST_REDIS_URL;
		if (redisUrl !== "redis://127.0.0.1:16381")
			throw new Error("Only the dedicated Live capacity test Redis is allowed");
		const connection = { url: redisUrl },
			name = `live-capacity-${randomUUID()}`;
		const queue = new Queue(name, { connection }),
			events = new QueueEvents(name, { connection });
		const hold = barrier(),
			sevenStarted = barrier(),
			overflowDelayed = barrier();
		const orgA = randomUUID(),
			orgB = randomUUID(),
			runId = randomUUID();
		const owners = new Map<string, string>();
		const channelFor = (organizationId: string) => {
			const id = randomUUID();
			owners.set(id, organizationId);
			return id;
		};
		const stopChannel = channelFor(orgB);
		owners.set(runId, orgB);
		const payload = (
			organizationId: string,
			action: string,
			liveChannelId = channelFor(organizationId),
			params?: object,
		) => ({
			organizationId,
			payload: { liveChannelId, action, ...(params ? { params } : {}) },
		});
		const resource = {
			findFirst: async ({ where }: { where: { id: string } }) =>
				owners.get(where.id) === currentOrganizationId()
					? { id: where.id }
					: null,
		};
		const consume = createTenantConsumer({
			prisma: {
				liveChannel: resource,
				liveChannelRun: resource,
			} as unknown as AppPrismaClient,
			forEachOrganization: async () => {},
			isOrganizationActive: async () => true,
		});
		const calls: { action: string; organizationId: string | undefined }[] = [];
		const errors: Error[] = [],
			failed: string[] = [];
		let normalStarted = 0;
		const worker = new Worker(
			name,
			reserveLiveStopCapacity(
				8,
				consume("liveChannel", async (job) => {
					const data = job.data as {
						action: string;
						params?: { cancelRunId?: string };
					};
					calls.push({
						action: data.action,
						organizationId: currentOrganizationId(),
					});
					if (data.action === "stop") return "STOPPED";
					if (data.params?.cancelRunId) return "CANCELED_START";
					normalStarted++;
					if (normalStarted === 7) sevenStarted.release();
					await hold.promise;
					return "RUNNING";
				}),
			),
			{ connection, concurrency: 8 },
		);
		worker.on("error", (error) => errors.push(error));
		worker.on("failed", (job) => failed.push(job?.id ?? "missing"));
		events.on("delayed", ({ jobId }) => {
			if (jobId === "overflow") overflowDelayed.release();
		});
		try {
			await events.waitUntilReady();
			await worker.waitUntilReady();
			const normal = await Promise.all(
				Array.from({ length: 7 }, (_, index) =>
					queue.add(
						"live-channel",
						payload(index % 2 === 0 ? orgA : orgB, "provision"),
						{ jobId: `start-${index}` },
					),
				),
			);
			await within(sevenStarted.promise, "seven normal jobs");
			const overflow = await queue.add(
				"live-channel",
				payload(orgA, "provision"),
				{ jobId: "overflow", attempts: 1 },
			);
			const stop = await queue.add(
				"live-channel",
				payload(orgB, "stop", stopChannel),
				{ jobId: "stop" },
			);
			const cancel = await queue.add(
				"live-channel",
				payload(orgB, "provision", stopChannel, { cancelRunId: runId }),
				{ jobId: "cancel" },
			);
			await expect(stop.waitUntilFinished(events, 2000)).resolves.toBe(
				"STOPPED",
			);
			await expect(cancel.waitUntilFinished(events, 2000)).resolves.toBe(
				"CANCELED_START",
			);
			await within(overflowDelayed.promise, "overflow deferral");
			expect(normalStarted).toBe(7);
			expect(calls).toContainEqual({ action: "stop", organizationId: orgB });
			expect(
				calls.filter(
					(call) => call.action === "provision" && call.organizationId === orgA,
				),
			).toHaveLength(4);
			const waiting = await queue.getJob("overflow");
			expect(waiting?.attemptsMade).toBe(0);
			expect(waiting?.id).toBe(overflow.id);
			expect(waiting?.data).toEqual(overflow.data);

			// Even a control job that bypasses the capacity counter still passes the
			// original tenant ownership checks before reaching the provider stub.
			const forged = await queue.add(
				"live-channel",
				payload(orgA, "stop", stopChannel),
				{ jobId: "forged-stop" },
			);
			await expect(forged.waitUntilFinished(events, 2000)).rejects.toThrow(
				"Tenant resource unavailable",
			);
			expect(calls.filter((call) => call.action === "stop")).toHaveLength(1);
			await expect.poll(() => failed).toEqual(["forged-stop"]);

			hold.release();
			await expect(
				Promise.all(
					[...normal, overflow].map((job) =>
						job.waitUntilFinished(events, 5000),
					),
				),
			).resolves.toEqual(Array(8).fill("RUNNING"));
			const completed = await queue.getJob("overflow");
			expect(completed?.attemptsMade).toBe(1);
			expect(normalStarted).toBe(8);
			expect(errors).toEqual([]);
		} finally {
			hold.release();
			await worker.close();
			await events.close();
			await queue.obliterate({ force: true });
			await queue.close();
		}
	},
	15_000,
);
