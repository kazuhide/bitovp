import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, Worker } from "bullmq";
import { expect, it } from "vitest";
import { createHandlers } from "./handlers";
import { ATTEMPT_LEASE_MS } from "./orchestrator/processor";

it.skipIf(!process.env.VOD_REDELIVERY_TEST_REDIS_URL)(
	"real BullMQ retains a lease-held delivery and completes it only after resume",
	async () => {
		const redisUrl = process.env.VOD_REDELIVERY_TEST_REDIS_URL;
		if (redisUrl !== "redis://127.0.0.1:16380")
			throw new Error(
				"Only the dedicated VOD redelivery test Redis is allowed",
			);
		const connection = { url: redisUrl };
		const name = `vod-redelivery-${randomUUID()}`;
		const queue = new Queue(name, { connection });
		const events = new QueueEvents(name, { connection });
		let leaseExpired = false;
		let processorDeliveries = 0;
		let resumeCount = 0;
		const errors: Error[] = [];
		const failed: unknown[] = [];
		const handlers = createHandlers({
			orchestrate: async () => {
				processorDeliveries++;
				if (!leaseExpired) return { status: "LEASE_HELD" };
				// Resuming a persisted provider encoding only reads its terminal
				// result. No CREATE/START or new encoding belongs in this delivery.
				resumeCount++;
				return { status: "FINISHED" };
			},
			usageStatistics: async () => {},
			liveChannel: async () => {
				throw new Error("unexpected live dispatch");
			},
			liveHeartbeatSweep: async () => {},
			feeder: async () => {},
			vmaf: async () => {},
			storageInspect: async () => {},
			notify: async () => {},
			startupProbe: async () => {},
			slateNormalize: async () => {},
		});
		const worker = new Worker(name, handlers.orchestrator, { connection });
		worker.on("error", (err) => errors.push(err));
		worker.on("failed", (_job, err) => failed.push(err));
		try {
			await events.waitUntilReady();
			await worker.waitUntilReady();
			const firstTransition = new Promise<string>((resolve) => {
				events.once("delayed", () => resolve("delayed"));
				events.once("completed", () => resolve("completed"));
				events.once("failed", () => resolve("failed"));
			});
			const before = Date.now();
			const job = await queue.add("encode", {
				encodingJobId: "persisted-encoding",
			});
			expect(await firstTransition).toBe("delayed");
			expect(await job.getState()).toBe("delayed");
			const held = await queue.getJob(job.id ?? "");
			expect(held?.timestamp).toBeGreaterThanOrEqual(before);
			expect((held?.timestamp ?? 0) + (held?.delay ?? 0)).toBeGreaterThan(
				before + ATTEMPT_LEASE_MS,
			);
			expect(held?.attemptsMade).toBe(0);
			expect(processorDeliveries).toBe(1);
			expect(resumeCount).toBe(0);
			// Promote after simulating DB lease expiry instead of waiting ten
			// minutes. The BullMQ move-to-delayed/completion boundary is real.
			leaseExpired = true;
			await held?.promote();
			await expect(job.waitUntilFinished(events, 5000)).resolves.toEqual({
				acknowledged: true,
				queue: "orchestrator",
			});
			expect(await job.getState()).toBe("completed");
			expect(processorDeliveries).toBe(2);
			expect(resumeCount).toBe(1);
			expect(failed).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			await worker.close();
			await events.close();
			await queue.obliterate({ force: true });
			await queue.close();
		}
	},
	10_000,
);
