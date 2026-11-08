import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { mediaTaskCreateSchema } from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { describe, expect, it, vi } from "vitest";
import {
	executeMediaTask,
	type MediaTaskExecutionDependencies,
	type VerifiedMediaTask,
} from "./media-task-execution";

function fixture(options: { localStory?: boolean; timeoutMs?: number } = {}) {
	const bytes = Buffer.from("Actual owned-source lifetime regression bytes"),
		sha256 = createHash("sha256").update(bytes).digest("hex"),
		organizationId = randomUUID(),
		mediaVersionId = randomUUID(),
		analysisRevisionId = randomUUID(),
		credentialId = randomUUID();
	const object = {
		credentialId,
		bucket: "fixture",
		key: "source.mp4",
		size: bytes.length,
		expect: { etag: "fixed" },
	};
	const input = mediaTaskCreateSchema.parse({
		kind: "GENERATE",
		mediaVersionId,
		analysisRevisionId,
		requestKey: randomUUID(),
		parameters: {
			contentId: randomUUID(),
			targetDurationFrames: 60,
			captions: "OFF",
			tracking: false,
			...(options.localStory
				? { policy: "LOCAL_STORY", renderMode: "DRAFT" }
				: {}),
		},
	});
	const verified = {
		envelope: { schemaVersion: 1, input, identity: { organizationId } },
		media: {
			id: mediaVersionId,
			organizationId,
			state: "READY",
			sha256,
			storage: {
				source: object,
				prepared: object,
				output: { credentialId, bucket: "fixture", prefix: "fixture/" },
			},
		},
	} as unknown as VerifiedMediaTask;
	const dispose = vi.fn();
	const browser = {
		headObject: async () => ({ size: bytes.length, etag: "fixed" }),
		getObject: async () => Readable.from([bytes]),
		dispose,
	} as unknown as ObjectStorageBrowser;
	const task = {
		id: randomUUID(),
		organizationId,
		mediaVersionId,
		analysisRevisionId,
		kind: "GENERATE",
		leaseToken: randomUUID(),
		createdBy: "fixture",
	} as LibraryMediaTask;
	return {
		bytes,
		dispose,
		run: (generate: NonNullable<MediaTaskExecutionDependencies["generate"]>) =>
			executeMediaTask({
				task,
				verified,
				dependencies: {
					prisma: {} as AppPrismaClient,
					browserFor: async () => browser,
					generate,
				},
				signal: new AbortController().signal,
				timeoutMs: options.timeoutMs ?? 10_000,
				onProgress: async () => {},
			}),
	};
}

describe("owned source remains valid throughout asynchronous generation", () => {
	it("allows the 90-minute local story task to acquire its source and reach generation", async () => {
		const f = fixture({ localStory: true, timeoutMs: 90 * 60_000 });
		let path = "";
		await expect(
			f.run(async ({ sourcePath }) => {
				path = sourcePath;
				expect(await readFile(sourcePath)).toEqual(f.bytes);
				return { planned: true };
			}),
		).resolves.toEqual({ planned: true });
		expect(f.dispose).toHaveBeenCalledTimes(1);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each([
		{ localStory: false, timeoutMs: 90 * 60_000 },
		{ localStory: true, timeoutMs: 121 * 60_000 },
	])("retains task timeout bounds for $localStory / $timeoutMs", async (options) => {
		const f = fixture(options);
		const generate = vi.fn();
		await expect(f.run(generate)).rejects.toThrow(RangeError);
		expect(generate).not.toHaveBeenCalled();
		expect(f.dispose).not.toHaveBeenCalled();
	});
	it("lets the callback read after yielding and cleans resources after success", async () => {
		const f = fixture();
		let path = "";
		const result = await f.run(async ({ sourcePath }) => {
			path = sourcePath;
			expect(await readFile(sourcePath)).toEqual(f.bytes);
			await delay(100);
			expect(f.dispose).not.toHaveBeenCalled();
			expect(await readFile(sourcePath)).toEqual(f.bytes);
			return { generated: true };
		});
		expect(result).toEqual({ generated: true });
		expect(f.dispose).toHaveBeenCalledTimes(1);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("keeps the source until rejection, preserves the original error and then cleans", async () => {
		const f = fixture(),
			failure = new Error("GENERATION_REJECTED");
		let path = "";
		await expect(
			f.run(async ({ sourcePath }) => {
				path = sourcePath;
				expect(await readFile(sourcePath)).toEqual(f.bytes);
				await delay(100);
				expect(f.dispose).not.toHaveBeenCalled();
				expect(await readFile(sourcePath)).toEqual(f.bytes);
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(f.dispose).toHaveBeenCalledTimes(1);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
