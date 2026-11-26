import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createVodInputPreviewFileCleanup } from "./cleanup";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "bitovp-vod-cleanup-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("reaps reset/expired/old-attempt bytes and preserves current output and another tenant", async () => {
	const org = randomUUID(),
		foreignOrg = randomUUID(),
		taskId = randomUUID();
	const current = randomUUID(),
		stale = randomUUID(),
		other = randomUUID();
	const ago = new Date(Date.now() - 120_000);
	for (const [tenant, task, token] of [
		[org, taskId, current],
		[org, taskId, stale],
		[foreignOrg, taskId, other],
	] as const) {
		const path = join(root, tenant, task, token);
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "preview.mp4"), "bytes");
		await utimes(path, ago, ago);
	}
	let row: object | null = {
		status: "SUCCEEDED",
		artifactToken: current,
		expiresAt: new Date(Date.now() + 60_000),
		cancelRequestedAt: null,
		leaseToken: null,
		leaseUntil: null,
	};
	const prisma = {
		vodInputPreviewTask: { findUnique: async () => row },
	} as unknown as AppPrismaClient;
	const cleanup = createVodInputPreviewFileCleanup({
		prisma,
		workDir: root,
		organizationId: org,
	});
	await cleanup();
	expect(await readdir(join(root, org, taskId))).toEqual([current]);
	expect(await readdir(join(root, foreignOrg, taskId))).toEqual([other]);
	row = null;
	await cleanup();
	expect(await readdir(join(root, org))).toEqual([]);
});

it("never removes a currently leased attempt even before its output is adopted", async () => {
	const org = randomUUID(),
		taskId = randomUUID(),
		token = randomUUID();
	const path = join(root, org, taskId, token);
	await mkdir(path, { recursive: true });
	const ago = new Date(Date.now() - 120_000);
	await utimes(path, ago, ago);
	const prisma = {
		vodInputPreviewTask: {
			findUnique: async () => ({
				status: "RUNNING",
				leaseToken: token,
				leaseUntil: new Date(Date.now() + 30_000),
				expiresAt: new Date(Date.now() + 60_000),
				cancelRequestedAt: null,
			}),
		},
	} as unknown as AppPrismaClient;
	await createVodInputPreviewFileCleanup({
		prisma,
		workDir: root,
		organizationId: org,
	})();
	expect(await readdir(join(root, org, taskId))).toEqual([token]);
});
