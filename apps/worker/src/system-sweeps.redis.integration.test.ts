import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { expect, it } from "vitest";
import {
	pruneSystemSweepHistory,
	scheduleSystemSweep,
	systemSweeps,
} from "./system-sweeps";

it.skipIf(!process.env.SWEEP_HISTORY_TEST_REDIS_URL)(
	"bounds old and new system sweep history without consuming tenant jobs or the next tick",
	async () => {
		const url = process.env.SWEEP_HISTORY_TEST_REDIS_URL;
		if (url !== "redis://127.0.0.1:16384")
			throw new Error("Only the dedicated sweep history test Redis is allowed");
		const redis = new Redis(url);
		const connection = { url };
		try {
			for (const sweep of Object.values(systemSweeps)) {
				const name = `sweep-history-${randomUUID()}`;
				const queue = new Queue(name, { connection });
				const worker = new Worker(name, undefined, {
					connection,
					autorun: false,
				});
				const token = randomUUID();
				const next = async () => {
					let job = await worker.getNextJob(token, { block: false });
					if (!job) {
						const [delayed] = await queue.getDelayed(0, 0);
						if (!delayed) throw new Error("Expected a scheduled tick");
						await delayed.promote();
						job = await worker.getNextJob(token, { block: false });
					}
					if (!job?.id) throw new Error("Expected an active job");
					return job as typeof job & { id: string };
				};
				const data = { systemSweep: sweep.marker };
				try {
					const lookalikeId = `repeat:${sweep.id}:42`;
					const lookalike = await queue.add(sweep.name, data, {
						jobId: lookalikeId,
					});
					await (await next()).moveToCompleted("tenant result", token, false);
					const tenantFailure = await queue.add(sweep.name, {
						organizationId: randomUUID(),
						payload: {},
					});
					await (await next()).moveToFailed(
						new Error("tenant failed"),
						token,
						false,
					);
					// Old workers upserted the same named scheduler with no retention.
					await queue.upsertJobScheduler(
						sweep.id,
						{ every: 60_000 },
						{
							name: sweep.name,
							data,
						},
					);
					const oldSuccess = await next();
					await oldSuccess.log("legacy tick");
					await oldSuccess.moveToCompleted(null, token, false);
					const oldFailure = await next();
					await oldFailure.moveToFailed(
						new Error("old tick failed"),
						token,
						false,
					);
					const inFlight = await next();
					await scheduleSystemSweep(queue, sweep, 60_000);
					const [pending] = await queue.getDelayed(0, 0);
					expect(pending?.id).toMatch(/^repeat:/);

					const completed = queue.toKey("completed");
					const seed = redis.multi();
					seed.zadd(completed, "XX", 100, oldSuccess.id);
					seed.zadd(completed, "XX", 101, lookalikeId);
					for (let i = 0; i < 100; i++) {
						const id = `tenant-${i}`;
						seed.zadd(completed, i, id);
						seed.hset(queue.toKey(id), "name", sweep.name, "data", "{}");
					}
					await seed.exec();
					await pruneSystemSweepHistory(redis, queue, sweep);
					expect(await oldSuccess.getState()).toBe("completed");
					expect(await oldFailure.getState()).toBe("unknown");
					expect(await redis.exists(queue.toKey(oldFailure.id))).toBe(0);
					// A concurrent retry shifts the old tick one rank to the left.
					// Fresh history fills a whole new page at the far end of the set.
					const churn = redis.multi();
					churn.zrem(completed, "tenant-0");
					churn.del(queue.toKey("tenant-0"));
					for (let i = 100; i < 200; i++) {
						const id = `tenant-${i}`;
						churn.zadd(completed, 1_000 + i, id);
						churn.hset(queue.toKey(id), "name", sweep.name, "data", "{}");
					}
					await churn.exec();
					await pruneSystemSweepHistory(redis, queue, sweep);
					expect(await oldSuccess.getState()).toBe("completed");
					await pruneSystemSweepHistory(redis, queue, sweep);
					expect(await oldSuccess.getState()).toBe("unknown");
					expect(await redis.exists(queue.toKey(oldSuccess.id))).toBe(0);
					expect(await redis.exists(queue.toKey(`${oldSuccess.id}:logs`))).toBe(
						0,
					);
					expect(await lookalike.getState()).toBe("completed");
					expect(await tenantFailure.getState()).toBe("failed");
					expect(await inFlight.getState()).toBe("active");
					expect(await pending?.getState()).toBe("delayed");
					expect(await queue.getCompletedCount()).toBe(200);
					await inFlight.moveToCompleted(null, token, false);
					// Set its real terminal record later than every seeded score, as
					// on a slow runner. The in-progress pass excludes that new rank.
					await redis.zadd(completed, "XX", 2_000, inFlight.id);
					expect(await redis.zrank(completed, inFlight.id)).toBe(200);
					await pruneSystemSweepHistory(redis, queue, sweep);
					await pruneSystemSweepHistory(redis, queue, sweep);
					expect(await inFlight.getState()).toBe("completed");
					// A fresh pass sees all 201 entries in three bounded pages.
					for (let page = 0; page < 3; page++) {
						await pruneSystemSweepHistory(redis, queue, sweep);
					}
					expect(await inFlight.getState()).toBe("unknown");
					expect(await redis.exists(queue.toKey(inFlight.id))).toBe(0);

					const success = await next();
					await success.moveToCompleted(null, token, false);
					expect(await success.getState()).toBe("unknown");
					const failure = await next();
					await failure.moveToFailed(new Error("tick failed"), token, false);
					expect(await failure.getState()).toBe("unknown");
					expect(
						await redis.exists(
							queue.toKey(success.id),
							queue.toKey(failure.id),
						),
					).toBe(0);
					expect(await queue.getJobScheduler(sweep.id)).toBeDefined();
					expect(await queue.getDelayedCount()).toBe(1);
					expect(await queue.getCompletedCount()).toBe(200);
					expect(await queue.getFailedCount()).toBe(1);
				} finally {
					await worker.close();
					await queue.obliterate({ force: true });
					await queue.close();
				}
			}
		} finally {
			await redis.quit();
		}
	},
	20_000,
);
