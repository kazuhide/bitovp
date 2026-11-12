import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VodInputPreviewRequest } from "@bitovp/core/vod-input-timeline";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVodInputPreviewProcessor } from "./processor";

const org = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const probeId = "00000000-0000-4000-8000-000000000003";
const source = {
	key: "a",
	credentialId: "00000000-0000-4000-8000-000000000004",
	bucket: "media",
	objectKey: "a.mp4",
};
const facts = {
	key: "a",
	durationMs: 1000,
	video: { streamIndex: 0, width: 320, height: 180 },
	audio: null,
	identity: { size: 100, etag: '"original"' },
};
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bitovp-vod-processor-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function row(request: VodInputPreviewRequest, taskId = id) {
	return {
		id: taskId,
		organizationId: org,
		kind: request.kind,
		status: "PENDING",
		stage: "QUEUED",
		request,
		requestHash: createHash("sha256")
			.update(JSON.stringify(request))
			.digest("hex"),
		result: null,
		error: null,
		probeId: request.kind === "PREVIEW" ? request.probeId : null,
		artifactPath: null,
		artifactToken: null,
		artifactSize: null,
		artifactSha256: null,
		leaseToken: null,
		leaseUntil: null,
		cancelRequestedAt: null,
		attempts: 0,
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		startedAt: null,
		finishedAt: null,
	};
}
function matches(
	value: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR")
			return (condition as Record<string, unknown>[]).some((entry) =>
				matches(value, entry),
			);
		if (key === "AND")
			return (condition as Record<string, unknown>[]).every((entry) =>
				matches(value, entry),
			);
		const actual = value[key];
		if (
			condition &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		)
			return Object.entries(condition).every(([op, target]) =>
				op === "gt"
					? actual !== null && Number(actual) > Number(target)
					: op === "lt"
						? actual !== null && Number(actual) < Number(target)
						: op === "lte"
							? actual !== null && Number(actual) <= Number(target)
							: op === "in"
								? (target as unknown[]).includes(actual)
								: op === "not"
									? actual !== target
									: false,
			);
		return actual === condition;
	});
}
function setup() {
	const task = row({ kind: "PROBE", sources: [source] });
	const rows = new Map<string, Record<string, unknown>>([[id, task]]);
	const prisma = {
		vodInputPreviewTask: {
			findUnique: vi.fn(async ({ where }) => rows.get(where.id) ?? null),
			updateMany: vi.fn(async ({ where, data }) => {
				let count = 0;
				for (const value of rows.values())
					if (matches(value, where)) {
						for (const [key, change] of Object.entries(data))
							value[key] =
								change && typeof change === "object" && "increment" in change
									? Number(value[key]) + Number(change.increment)
									: change;
						count++;
					}
				return { count };
			}),
		},
		credential: { count: vi.fn(async () => 1) },
	};
	const probe = vi.fn(async () => [facts]);
	const render = vi.fn(async (input) => {
		const path = join(input.directory, "preview.mp4");
		await writeFile(path, "preview");
		return {
			path,
			size: 7,
			sha256: "a".repeat(64),
			durationMs: 1000,
			bytesRead: 80,
		};
	});
	const browserFor = vi.fn();
	return {
		task,
		rows,
		prisma,
		probe,
		render,
		browserFor,
		process: createVodInputPreviewProcessor({
			prisma: prisma as unknown as AppPrismaClient,
			browserFor,
			workDir: directory,
			probe,
			render,
			heartbeatMs: 10,
		}),
	};
}

describe("durable CPU input preview ownership", () => {
	it("probes once, persists narrow facts, and dedupes redelivery without GPU/LLM configuration", async () => {
		const f = setup();
		await f.process({ taskId: id });
		await f.process({ taskId: id });
		expect(f.task.status).toBe("SUCCEEDED");
		expect(f.task.result).toEqual({ sources: [facts] });
		expect(f.task.leaseToken).toBeNull();
		expect(f.probe).toHaveBeenCalledOnce();
		expect(f.render).not.toHaveBeenCalled();
	});
	it("does not create work or consume credentials while another lease is alive", async () => {
		const f = setup();
		Object.assign(f.task, {
			status: "RUNNING",
			leaseToken: randomUUID(),
			leaseUntil: new Date(Date.now() + 10_000),
		});
		expect(await f.process({ taskId: id })).toMatchObject({
			status: "LEASE_HELD",
		});
		expect(f.probe).not.toHaveBeenCalled();
		expect(f.browserFor).not.toHaveBeenCalled();
	});
	it("cancel and credential deletion prevent a result from being adopted", async () => {
		for (const mode of ["cancel", "credential"] as const) {
			const f = setup();
			f.probe.mockImplementation(async () => {
				if (mode === "cancel") f.task.cancelRequestedAt = new Date() as never;
				else f.prisma.credential.count.mockResolvedValue(0);
				return [facts];
			});
			await f.process({ taskId: id });
			expect(f.task.status).toBe(mode === "cancel" ? "CANCELED" : "FAILED");
			expect(f.task.result).toBeNull();
		}
	});
	it("an attempt that loses its lease cannot adopt output or remove a newer attempt directory", async () => {
		const f = setup();
		const probe = row({ kind: "PROBE", sources: [source] }, probeId);
		Object.assign(probe, { status: "SUCCEEDED", result: { sources: [facts] } });
		f.rows.set(probeId, probe);
		Object.assign(
			f.task,
			row({
				kind: "PREVIEW",
				probeId,
				document: {
					schemaVersion: 1,
					id: randomUUID(),
					audioEnabled: false,
					clips: [{ id: randomUUID(), sourceKey: "a", inMs: 0, outMs: 1000 }],
				},
				range: { startMs: 0, durationMs: 1000 },
			}),
		);
		const winnerToken = randomUUID();
		f.render.mockImplementation(async (input) => {
			await writeFile(join(input.directory, "preview.mp4"), "stale");
			Object.assign(f.task, {
				leaseToken: winnerToken,
				leaseUntil: new Date(Date.now() + 60_000),
			});
			const winnerDir = join(directory, org, id, winnerToken);
			await mkdir(winnerDir, { recursive: true });
			await writeFile(join(winnerDir, "preview.mp4"), "winner");
			return {
				path: join(input.directory, "preview.mp4"),
				size: 5,
				sha256: "a".repeat(64),
				durationMs: 1000,
				bytesRead: 80,
			};
		});
		await f.process({ taskId: id });
		expect(f.task.result).toBeNull();
		expect(f.task.leaseToken).toBe(winnerToken);
		expect(await readdir(join(directory, org, id))).toEqual([winnerToken]);
	});
	it("a preview cannot use expired or cross-organization probe facts", async () => {
		const f = setup();
		const probe = row({ kind: "PROBE", sources: [source] }, probeId);
		Object.assign(probe, {
			status: "SUCCEEDED",
			result: { sources: [facts] },
			organizationId: randomUUID(),
		});
		f.rows.set(probeId, probe);
		Object.assign(
			f.task,
			row({
				kind: "PREVIEW",
				probeId,
				document: {
					schemaVersion: 1,
					id: randomUUID(),
					audioEnabled: false,
					clips: [{ id: randomUUID(), sourceKey: "a", inMs: 0, outMs: 1000 }],
				},
				range: { startMs: 0, durationMs: 1000 },
			}),
		);
		await f.process({ taskId: id });
		expect(f.task.status).toBe("FAILED");
		expect(f.task.error).toMatchObject({ code: "PROBE_UNAVAILABLE" });
		expect(f.render).not.toHaveBeenCalled();
	});
});
