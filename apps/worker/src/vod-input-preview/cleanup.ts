import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppPrismaClient } from "@bitovp/db";
import type { Queue } from "bullmq";
import {
	VOD_INPUT_PREVIEW_LEASE_MS,
	VOD_INPUT_PREVIEW_UUID,
	vodInputPreviewAttemptDirectory,
} from "./processor";

/** Scan only this tenant's generated UUID namespace. The grace covers old child drain. */
export function createVodInputPreviewFileCleanup(deps: {
	prisma: AppPrismaClient;
	workDir: string;
	organizationId: string;
	now?: () => Date;
}) {
	let cursor = "";
	return async () => {
		vodInputPreviewAttemptDirectory(
			deps.workDir,
			deps.organizationId,
			"00000000-0000-4000-8000-000000000000",
			"00000000-0000-4000-8000-000000000000",
		);
		const now = deps.now?.() ?? new Date();
		const root = join(deps.workDir, deps.organizationId);
		const entries = await readdir(root, { withFileTypes: true }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		const names = entries
			.filter(
				(entry) =>
					entry.isDirectory() && VOD_INPUT_PREVIEW_UUID.test(entry.name),
			)
			.map((entry) => entry.name)
			.sort();
		const page = [
			...names.filter((name) => name > cursor),
			...names.filter((name) => name <= cursor),
		].slice(0, 64);
		for (const id of page) {
			const row = await deps.prisma.vodInputPreviewTask.findUnique({
				where: { id },
			});
			const taskDir = join(root, id);
			const attempts = await readdir(taskDir, { withFileTypes: true }).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return [];
					throw error;
				},
			);
			for (const attempt of attempts.slice(0, 64)) {
				if (
					!attempt.isDirectory() ||
					!VOD_INPUT_PREVIEW_UUID.test(attempt.name)
				)
					continue;
				if (
					row?.leaseToken === attempt.name &&
					row.leaseUntil &&
					row.leaseUntil.getTime() + 1000 > now.getTime()
				)
					continue;
				if (
					row?.artifactToken === attempt.name &&
					row.status === "SUCCEEDED" &&
					!row.cancelRequestedAt &&
					row.expiresAt > now
				)
					continue;
				const path = vodInputPreviewAttemptDirectory(
					deps.workDir,
					deps.organizationId,
					id,
					attempt.name,
				);
				const metadata = await stat(path).catch(() => undefined);
				if (
					metadata &&
					metadata.mtimeMs < now.getTime() - VOD_INPUT_PREVIEW_LEASE_MS - 5000
				)
					await rm(path, { recursive: true, force: true });
			}
			await rmdir(taskDir).catch((error: NodeJS.ErrnoException) => {
				if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? ""))
					throw error;
			});
			cursor = id;
		}
	};
}

/** DB is the outbox. Recover a lost enqueue or expired owner without duplicating live work. */
export function createVodInputPreviewSweep(deps: {
	prisma: AppPrismaClient;
	queue: Queue;
	workDir: string;
	organizationId: string;
	now?: () => Date;
}) {
	const cleanup = createVodInputPreviewFileCleanup(deps);
	let pending: Promise<void> | undefined;
	return () =>
		(pending ??= (async () => {
			const now = deps.now?.() ?? new Date();
			await deps.prisma.vodInputPreviewTask.updateMany({
				where: {
					status: { in: ["PENDING", "RUNNING"] },
					expiresAt: { lte: now },
				},
				data: {
					status: "CANCELED",
					stage: "EXPIRED",
					cancelRequestedAt: now,
					finishedAt: now,
				},
			});
			await deps.prisma.vodInputPreviewTask.updateMany({
				where: {
					status: "RUNNING",
					leaseUntil: { lt: now },
					attempts: { gte: 3 },
				},
				data: {
					status: "FAILED",
					stage: "FAILED",
					leaseToken: null,
					leaseUntil: null,
					finishedAt: now,
					error: {
						code: "WORKER_INTERRUPTED",
						message:
							"CPU preview could not recover after repeated worker interruptions.",
					},
				},
			});
			const waiting = await deps.prisma.vodInputPreviewTask.findMany({
				where: {
					expiresAt: { gt: now },
					cancelRequestedAt: null,
					OR: [
						{ status: "PENDING" },
						{ status: "RUNNING", leaseUntil: { lt: now } },
					],
				},
				orderBy: { createdAt: "asc" },
				take: 32,
				select: { id: true },
			});
			for (const row of waiting) {
				const existing = await deps.queue.getJob(row.id);
				if (existing) {
					const state = await existing.getState();
					if (!["failed", "completed", "unknown"].includes(state)) continue;
					await existing.remove();
				}
				await deps.queue.add(
					"vod-input-preview",
					{ taskId: row.id },
					{
						jobId: row.id,
						attempts: 1,
						removeOnComplete: 100,
						removeOnFail: 100,
					},
				);
			}
			await cleanup();
			const expired = await deps.prisma.vodInputPreviewTask.findMany({
				where: {
					expiresAt: { lt: new Date(now.getTime() - 5 * 60_000) },
					previews: { none: {} },
					OR: [
						{ leaseUntil: null },
						{ leaseUntil: { lt: new Date(now.getTime() - 5000) } },
					],
				},
				take: 64,
				select: { id: true },
			});
			if (expired.length)
				await deps.prisma.vodInputPreviewTask.deleteMany({
					where: {
						id: { in: expired.map((row) => row.id) },
						previews: { none: {} },
					},
				});
		})().finally(() => {
			pending = undefined;
		}));
}
