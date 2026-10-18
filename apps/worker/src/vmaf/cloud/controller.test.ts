import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VMAF_FRAME_INDEX_CROP_POLICY,
	type VmafCloudManifest,
	type VmafComputeAdapter,
	type VmafStagingStore,
	vmafCloudProfileSchema,
} from "@bitovp/core";
import type { AppPrismaClient, VmafComputeTask } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createVmafCloudController,
	receiptMatchesMeasurement,
	reserveCost,
} from "./controller";

import { StagingNotFoundError } from "./staging";

const profile = vmafCloudProfileSchema.parse({
	id: "gcp",
	label: "GCP",
	provider: "GCP_BATCH",
	region: "europe-west1",
	project: "test",
	machineType: "c3-standard-4",
	serviceAccount: "worker@example.com",
	image: `worker@sha256:${"a".repeat(64)}`,
	cpu: 4,
	memoryMiB: 8192,
	diskGiB: 100,
	maxParallel: 8,
	timeoutSeconds: 3600,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 2,
	transferUsdPerGiB: 0.1,
	overheadUsd: 0.5,
	maxStagingGiB: 80,
	staging: { provider: "GCS", bucket: "private" },
});
const when = new Date("2026-09-24T00:00:00Z");
function row(id: string, state = "SUBMIT_UNKNOWN"): VmafComputeTask {
	return {
		id,
		organizationId: "ef984a2c-1d65-4f48-8eae-0f4be5c80432",
		vmafJobId: "parent",
		targetKey: id,
		profileId: profile.id,
		profile,
		providerId: null,
		state,
		reservedUsd: 1,
		stagingKeys: [id],
		receipt: null,
		attempt: 0,
		progress: null,
		expiresAt: new Date(0),
		queueExpiresAt: new Date(0),
		heartbeatAt: new Date(0),
		createdAt: new Date(0),
		cleanedAt: null,
		error: null,
	};
}
function setup(
	rows: VmafComputeTask[] = [],
	overrides: Partial<Parameters<typeof createVmafCloudController>[0]> = {},
) {
	const tasks = new Map(rows.map((r) => [r.id, r]));
	const table = {
		findUnique: vi.fn(async ({ where }) => tasks.get(where.id) ?? null),
		findMany: vi.fn(async ({ cursor, take }) =>
			[...tasks.values()]
				.filter((r) => !r.cleanedAt && (!cursor || r.id > cursor.id))
				.sort((a, b) => a.id.localeCompare(b.id))
				.slice(0, take),
		),
		update: vi.fn(async ({ where, data }) => {
			const r = tasks.get(where.id);
			if (!r) throw Error("missing");
			Object.assign(r, data);
			return r;
		}),
		updateMany: vi.fn(async ({ where, data }) => {
			const r = tasks.get(where.id);
			if (!r || r.state !== where.state || r.cleanedAt) return { count: 0 };
			Object.assign(r, data);
			return { count: 1 };
		}),
		count: vi.fn(async () => 0),
		aggregate: vi.fn(async () => ({ _sum: { reservedUsd: 0 } })),
		create: vi.fn(async ({ data }) => {
			const r = { ...row(data.id, "PREPARING"), ...data };
			tasks.set(r.id, r);
			return r;
		}),
	};
	const db = {
		vmafComputeTask: table,
		vmafJob: { findUnique: vi.fn(async () => null) },
		$executeRaw: vi.fn(),
		$transaction: vi.fn(),
	};
	db.$transaction.mockImplementation(async (cb) => cb(db));
	const adapter: VmafComputeAdapter = {
		find: vi.fn(async () => undefined),
		submit: vi.fn(async () => "provider"),
		status: vi.fn(async () => "FAILED" as const),
		cancel: vi.fn(),
		cleanup: vi.fn(),
	};
	const store: VmafStagingStore = {
		upload: vi.fn(),
		download: vi.fn(),
		signedRead: vi.fn(async () => "https://private.invalid/signed"),
		signedWrite: vi.fn(async () => ({ url: "https://private.invalid/signed" })),
		remove: vi.fn(),
	};
	const controller = createVmafCloudController({
		prisma: db as unknown as AppPrismaClient,
		profiles: [profile],
		workDir: tmpdir(),
		adapter: () => adapter,
		store: () => store,
		now: () => when,
		pollMs: 1,
		...overrides,
	});
	return { controller, tasks, table, db, adapter, store };
}
describe("peer controller reconciliation", () => {
	function runningTask(
		id: string,
		heartbeatAt = when,
		expiresAt = new Date(when.getTime() + 3600000),
	) {
		return {
			...row(id, "RUNNING"),
			vmafJobId: "peer-parent",
			providerId: id,
			heartbeatAt,
			expiresAt,
		};
	}
	function ownedParents(t: ReturnType<typeof setup>) {
		const updates = vi.fn(async () => ({ count: 1 }));
		t.table.findUnique.mockImplementation(async ({ where }) =>
			structuredClone(t.tasks.get(where.id) ?? null),
		);
		t.table.findMany.mockImplementation(async ({ cursor, take }) =>
			structuredClone(
				[...t.tasks.values()]
					.filter((r) => !r.cleanedAt && (!cursor || r.id > cursor.id))
					.sort((a, b) => a.id.localeCompare(b.id))
					.slice(0, take),
			),
		);
		t.table.updateMany.mockImplementation(async ({ where, data }) => {
			const task = t.tasks.get(where.id);
			if (
				!task ||
				task.cleanedAt ||
				task.state !== where.state ||
				(where.heartbeatAt &&
					task.heartbeatAt.getTime() !== where.heartbeatAt.getTime()) ||
				(where.expiresAt &&
					task.expiresAt.getTime() !== where.expiresAt.getTime()) ||
				(where.receipt && task.receipt !== null) ||
				("error" in where && task.error !== where.error)
			)
				return { count: 0 };
			Object.assign(task, data);
			return { count: 1 };
		});
		Object.assign(t.db.vmafJob, { updateMany: updates });
		t.db.vmafJob.findUnique.mockImplementation(
			async (...args: unknown[]) =>
				({
					status:
						(args[0] as { where: { id: string } }).where.id === "peer-parent"
							? "RUNNING"
							: "ERROR",
				}) as never,
		);
		return updates;
	}
	it("refreshes a peer heartbeat after preceding cleanup held the batch snapshot for two minutes", async () => {
		let current = when;
		const abandoned = {
			...row("a-old"),
			vmafJobId: "old-parent",
			providerId: "old-provider",
		};
		const peer = runningTask("z-peer");
		const t = setup([abandoned, peer], { now: () => current });
		const updates = ownedParents(t);
		vi.mocked(t.adapter.status).mockImplementation(async (id) =>
			id === "old-provider" ? "FAILED" : "RUNNING",
		);
		t.table.findMany.mockImplementationOnce(async () =>
			structuredClone([abandoned, peer]),
		);
		vi.mocked(t.adapter.cleanup).mockImplementationOnce(async () => {
			current = new Date(when.getTime() + 130000);
			peer.heartbeatAt = current;
		});
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cancel).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).toHaveBeenCalledTimes(1);
		expect(peer.cleanedAt).toBeNull();
	});
	it("fences retirement when a peer refreshes its heartbeat while the parent read awaits", async () => {
		const peer = runningTask("peer", new Date(when.getTime() - 121000));
		const t = setup([peer]);
		const updates = ownedParents(t);
		t.db.vmafJob.findUnique.mockImplementationOnce(async () => {
			peer.heartbeatAt = when;
			return { status: "RUNNING" } as never;
		});
		t.table.updateMany.mockImplementation(async ({ where, data }) => {
			if (where.heartbeatAt?.getTime() !== peer.heartbeatAt.getTime())
				return { count: 0 };
			Object.assign(peer, data);
			return { count: 1 };
		});
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cancel).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).not.toHaveBeenCalled();
		expect(peer.cleanedAt).toBeNull();
	});
	for (const expired of [false, true])
		it(
			"retires and cleans a genuinely " +
				(expired ? "expired" : "stale") +
				" peer task",
			async () => {
				const peer = runningTask(
					"peer",
					expired ? when : new Date(when.getTime() - 121000),
					expired ? when : new Date(when.getTime() + 3600000),
				);
				const t = setup([peer]);
				const updates = ownedParents(t);
				await t.controller.reconcile();
				expect(updates).toHaveBeenCalledWith({
					where: { id: "peer-parent", status: "RUNNING" },
					data: {
						status: "ERROR",
						error: expect.stringContaining("worker was lost"),
					},
				});
				expect(t.adapter.cleanup).toHaveBeenCalledWith("peer");
				expect(peer.cleanedAt).toEqual(when);
			},
		);
	it("does not retire a peer whose result committed before the atomic heartbeat guard", async () => {
		const peer = runningTask("peer", new Date(when.getTime() - 121000));
		const t = setup([peer]);
		const updates = ownedParents(t);
		t.db.vmafJob.findUnique.mockImplementationOnce(async () => {
			peer.state = "SUCCEEDED";
			peer.receipt = { complete: true };
			return { status: "RUNNING" } as never;
		});
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cancel).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).not.toHaveBeenCalled();
	});
	it("does not retire when a peer extends its task deadline before the atomic guard", async () => {
		const peer = runningTask("peer", when, when),
			t = setup([peer]),
			updates = ownedParents(t);
		t.db.vmafJob.findUnique.mockImplementationOnce(async () => {
			peer.expiresAt = new Date(when.getTime() + 3600000);
			return { status: "RUNNING" } as never;
		});
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).not.toHaveBeenCalled();
	});
	it("does not retire when receipt alone commits while the parent read awaits", async () => {
		const peer = runningTask("peer", new Date(when.getTime() - 121000)),
			t = setup([peer]),
			updates = ownedParents(t);
		t.db.vmafJob.findUnique.mockImplementationOnce(async () => {
			peer.receipt = { complete: true };
			return { status: "RUNNING" } as never;
		});
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).not.toHaveBeenCalled();
	});
	for (const recoveryError of ["PREEMPTED", "CAPACITY", "SPOT_DEADLINE"])
		it(
			"does not retire when a peer records " +
				recoveryError +
				" before the atomic guard",
			async () => {
				const peer = runningTask("peer", when, when),
					t = setup([peer]),
					updates = ownedParents(t);
				t.db.vmafJob.findUnique.mockImplementationOnce(async () => {
					peer.error = recoveryError;
					return { status: "RUNNING" } as never;
				});
				await t.controller.reconcile();
				expect(updates).not.toHaveBeenCalled();
				expect(t.adapter.cancel).not.toHaveBeenCalled();
				expect(t.adapter.cleanup).not.toHaveBeenCalled();
				expect(peer.cleanedAt).toBeNull();
			},
		);
	it("keeps the preparation fence and settlement grace for a stale uploading peer", async () => {
		const peer = {
			...runningTask("peer", new Date(when.getTime() - 121000)),
			state: "PREPARING",
			providerId: null,
		};
		const t = setup([peer]);
		const updates = ownedParents(t);
		await t.controller.reconcile();
		expect(updates).toHaveBeenCalledTimes(1);
		expect(peer.state).toBe("CANCEL_PREPARING");
		expect(peer.cleanedAt).toBeNull();
		expect(t.store.remove).not.toHaveBeenCalled();
		expect(t.adapter.cancel).not.toHaveBeenCalled();
	});
	it("ignores an inventory entry removed before its fresh read", async () => {
		const peer = runningTask("peer"),
			t = setup([peer]),
			updates = ownedParents(t);
		t.table.findUnique.mockResolvedValue(null);
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.db.vmafJob.findUnique).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).not.toHaveBeenCalled();
	});
	for (const terminal of ["FINISHED", "ERROR"])
		it(
			"defers cleanup when the parent became " +
				terminal +
				" before its atomic RUNNING fence",
			async () => {
				const peer = runningTask("peer", new Date(when.getTime() - 121000)),
					t = setup([peer]),
					updates = ownedParents(t);
				updates.mockResolvedValueOnce({ count: 0 });
				await t.controller.reconcile();
				expect(t.adapter.cancel).not.toHaveBeenCalled();
				expect(t.adapter.cleanup).not.toHaveBeenCalled();
				expect(peer.cleanedAt).toBeNull();
				// The next sweep reads the terminal state afresh and performs normal teardown.
				t.db.vmafJob.findUnique.mockResolvedValue({
					status: terminal,
				} as never);
				await t.controller.reconcile();
				expect(t.adapter.cleanup).toHaveBeenCalledWith("peer");
				expect(peer.cleanedAt).toEqual(when);
			},
		);
	it("still cleans a fresh task belonging to a terminal parent", async () => {
		const peer = runningTask("peer");
		const t = setup([peer]);
		const updates = ownedParents(t);
		t.db.vmafJob.findUnique.mockResolvedValue({ status: "ERROR" } as never);
		await t.controller.reconcile();
		expect(updates).not.toHaveBeenCalled();
		expect(t.adapter.cleanup).toHaveBeenCalledWith("peer");
		expect(peer.cleanedAt).toEqual(when);
	});
});
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("cloud cost and resource ownership", () => {
	it("reserves queue+run time and transfer overhead, rejecting storage overflow", () => {
		expect(reserveCost(profile, 10 * 1024 ** 3)).toBe(3.84);
		expect(() => reserveCost(profile, 90 * 1024 ** 3)).toThrow(
			"storage capacity",
		);
	});
	it("does not starve newer resources behind 100 unknown submissions", async () => {
		const rows = Array.from({ length: 101 }, (_, i) =>
			row(String(i).padStart(4, "0")),
		);
		const last = rows[100];
		if (!last) throw new Error("Missing fixture");
		last.providerId = "owned";
		const t = setup(rows);
		await t.controller.reconcile();
		expect(t.adapter.cleanup).toHaveBeenCalledWith("owned");
		expect(t.tasks.get("0100")?.cleanedAt).toEqual(when);
		expect(t.tasks.get("0000")?.cleanedAt).toBeNull();
	});
	it("does not clean a stale PREPARING read after submission won the CAS", async () => {
		const task = row("id", "PREPARING");
		const t = setup([task]);
		t.table.updateMany.mockImplementationOnce(async () => {
			task.state = "SUBMITTING";
			return { count: 0 };
		});
		await t.controller.reconcile();
		expect(t.store.remove).not.toHaveBeenCalled();
		expect(task.cleanedAt).toBeNull();
	});
	it("fences new submission before reclaiming a crashed preparation", async () => {
		const task = row("id", "PREPARING");
		const t = setup([task]);
		await t.controller.reconcile();
		expect(task.cleanedAt).toEqual(when);
		expect(t.adapter.find).not.toHaveBeenCalled();
		expect(t.store.remove).toHaveBeenCalledWith(["id"]);
	});
	it("retains ownership when provider teardown fails", async () => {
		const task = row("id");
		task.providerId = "owned";
		const t = setup([task]);
		vi.mocked(t.adapter.cleanup).mockRejectedValueOnce(Error("offline"));
		await t.controller.reconcile();
		expect(task.cleanedAt).toBeNull();
		expect(t.store.remove).not.toHaveBeenCalled();
	});
	it("does not start or stage a task beyond the explicitly selected budget", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cloud-budget-"));
		dirs.push(dir);
		const path = join(dir, "input");
		await writeFile(path, "video");
		const t = setup();
		t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
		await expect(
			t.controller.score({
				vmafJobId: "job",
				targetKey: "rung",
				profileId: profile.id,
				pairCount: 1,
				budgetUsd: 0.01,
				signal: new AbortController().signal,
				options: {
					referencePath: path,
					distortedPath: path,
					modelPath: path,
					model: "vmaf_v0.6.1",
					logPath: join(dir, "out"),
				},
			}),
		).rejects.toThrow("budget");
		expect(t.adapter.submit).not.toHaveBeenCalled();
		expect(t.store.upload).not.toHaveBeenCalled();
	});
	it("refuses floating built-in models before starting a cloud task", async () => {
		const t = setup();
		await expect(
			t.controller.score({
				vmafJobId: "job",
				targetKey: "rung",
				profileId: profile.id,
				pairCount: 1,
				budgetUsd: 100,
				signal: new AbortController().signal,
				options: {
					referencePath: "missing",
					distortedPath: "missing",
					model: "vmaf_v0.6.1",
					logPath: "missing",
				},
			}),
		).rejects.toThrow("model file");
		expect(t.adapter.submit).not.toHaveBeenCalled();
	});
});

it.each([
	[false, false],
	[true, false],
	[false, true],
	[true, true],
])("accepts only verified cloud receipt (tampered=%s, direct=%s)", async (tampered, direct) => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-result-"));
	dirs.push(dir);
	const path = join(dir, "input");
	await writeFile(path, "video");
	const t = setup();
	t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
	const files = new Map<string, string>();
	vi.mocked(t.store.upload).mockImplementation(async (key, file) => {
		files.set(key, await readFile(file, "utf8"));
	});
	vi.mocked(t.store.download).mockImplementation(async (key, file) => {
		const content = files.get(key);
		if (!content) throw Error("missing test file");
		await writeFile(file, content);
	});
	vi.mocked(t.adapter.submit).mockImplementation(async () => {
		const entry = [...files].find(([key]) => key.endsWith("manifest.json"));
		if (!entry) throw Error("missing manifest");
		const manifest = JSON.parse(entry[1]);
		expect(manifest.scoring.threads).toBe(8);
		const prefix = entry[0].replace("manifest.json", "");
		const result = JSON.stringify({
			frames: [{ frameNum: 0, metrics: { vmaf: 95 } }],
		});
		files.set(`${prefix}result.json`, result);
		files.set(
			`${prefix}receipt.json`,
			JSON.stringify({
				version: 1,
				taskId: tampered ? "another-task" : manifest.taskId,
				image: profile.image,
				referenceSha256: manifest.reference.sha256,
				distortedSha256: manifest.distorted.sha256,
				modelSha256: manifest.modelFile.sha256,
				resultSha256: createHash("sha256").update(result).digest("hex"),
				frames: 1,
				referenceFrames: 1,
				ffmpegVersion: "test",
				completedAt: when.toISOString(),
			}),
		);
		return "provider";
	});
	const call = t.controller.score({
		vmafJobId: "job",
		targetKey: "rung",
		profileId: profile.id,
		pairCount: 1,
		budgetUsd: 100,
		...(direct
			? {
					remoteInputs: {
						reference: {
							url: "https://storage.googleapis.com/source/video?X-Amz-Signature=test",
							sha256: createHash("sha256").update("video").digest("hex"),
							bytes: 5,
						},
						distorted: {
							url: "https://storage.googleapis.com/output/video?X-Amz-Signature=test",
							sha256: createHash("sha256").update("video").digest("hex"),
							bytes: 5,
						},
					},
				}
			: {}),
		signal: new AbortController().signal,
		options: {
			threads: 1,
			scaleToReference: { width: 1920, height: 1080 },
			referencePath: path,
			distortedPath: path,
			modelPath: path,
			model: "vmaf_v0.6.1",
			logPath: join(dir, "out"),
		},
	});
	if (tampered) await expect(call).rejects.toThrow("did not finish");
	else {
		await call;
		expect([...t.tasks.values()][0]?.receipt).toMatchObject({
			frames: 1,
			referenceFrames: 1,
		});
	}
	expect([...t.tasks.values()][0]?.profile).toMatchObject({
		cpu: 8,
		memoryMiB: 32768,
		diskGiB: 50,
	});
	expect([...t.tasks.values()][0]?.cleanedAt).toEqual(when);
	if (direct) {
		expect(
			[...files.keys()].some(
				(key) => key.endsWith("/reference") || key.endsWith("/distorted"),
			),
		).toBe(false);
		const owned = [...t.tasks.values()][0]?.stagingKeys as string[];
		expect(
			owned.some(
				(key) => key.endsWith("/reference") || key.endsWith("/distorted"),
			),
		).toBe(false);
	}
	expect(t.adapter.cleanup).toHaveBeenCalledWith("provider");
});

it("does not treat a stale preparation heartbeat as an upload settlement receipt", async () => {
	const task = row("id", "PREPARING");
	task.expiresAt = new Date(when.getTime() + 3600000);
	const t = setup([task]);
	await t.controller.reconcile();
	expect(task.state).toBe("CANCEL_PREPARING");
	expect(task.cleanedAt).toBeNull();
	expect(t.store.remove).not.toHaveBeenCalled();
});

it("a settled owner re-sweeps late uploads even after a reaper marked preparation cleaned", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-late-upload-"));
	dirs.push(dir);
	const path = join(dir, "input");
	await writeFile(path, "video");
	const t = setup();
	t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
	vi.mocked(t.store.upload).mockImplementationOnce(async () => {
		const task = [...t.tasks.values()][0];
		if (!task) throw Error("missing task");
		task.state = "CLEANED";
		task.cleanedAt = when;
	});
	await expect(
		t.controller.score({
			vmafJobId: "job",
			targetKey: "rung",
			profileId: profile.id,
			pairCount: 1,
			budgetUsd: 100,
			signal: new AbortController().signal,
			options: {
				referencePath: path,
				distortedPath: path,
				modelPath: path,
				model: "vmaf_v0.6.1",
				logPath: join(dir, "out"),
			},
		}),
	).rejects.toThrow("did not finish");
	expect(t.adapter.submit).not.toHaveBeenCalled();
	expect(t.store.remove).toHaveBeenCalledTimes(1);
	expect([...t.tasks.values()][0]?.cleanedAt).toEqual(when);
});

it("cleans with the original profile and credential references after profile edit or disable", async () => {
	const original = {
		...profile,
		profileVersion: 1,
		computeCredentialId: "11111111-1111-4111-8111-111111111111",
		stagingCredentialId: "22222222-2222-4222-8222-222222222222",
	};
	const task = { ...row("old"), profile: original, providerId: "owned" };
	const resolveProfile = vi.fn(async () => undefined);
	const adapter = {
		find: vi.fn(),
		submit: vi.fn(),
		status: vi.fn(async () => "FAILED" as const),
		cancel: vi.fn(),
		cleanup: vi.fn(),
	};
	const adapterFor = vi.fn(() => adapter);
	const t = setup([task], {
		profiles: [],
		resolveProfile,
		adapter: adapterFor,
	});
	await t.controller.reconcile();
	expect(resolveProfile).not.toHaveBeenCalled();
	expect(adapterFor).toHaveBeenCalledWith(original);
	expect(t.tasks.get("old")?.cleanedAt).toEqual(when);
});
it("resolves newly added named profiles without a worker restart", async () => {
	const resolveProfile = vi.fn(async () => profile);
	const t = setup([], { profiles: [], resolveProfile });
	expect(await t.controller.resolveProfile("gcp")).toEqual(profile);
	expect(resolveProfile).toHaveBeenCalledWith("gcp");
});

it("admits all report pairs despite a legacy profile limit and another report's resources", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-fanout-"));
	dirs.push(dir);
	const path = join(dir, "input");
	await writeFile(path, "video");
	const t = setup([row("other-report")], {
		profiles: [{ ...profile, maxParallel: 1 }],
	});
	t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
	t.table.count.mockImplementation(async (args?: unknown) => {
		const { where } = args as {
			where: { profileId?: string; vmafJobId?: string };
		};
		return [...t.tasks.values()].filter(
			(task) =>
				!task.cleanedAt &&
				(where.profileId === undefined || task.profileId === where.profileId) &&
				(where.vmafJobId === undefined || task.vmafJobId === where.vmafJobId),
		).length;
	});
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.mocked(t.adapter.submit).mockImplementation(async () => {
		await barrier;
		return "provider";
	});
	const abort = new AbortController();
	const calls = Array.from({ length: 6 }, (_, index) =>
		t.controller.score({
			vmafJobId: "job",
			targetKey: `pair${index}`,
			pairCount: 6,
			profileId: profile.id,
			budgetUsd: 100,
			signal: abort.signal,
			options: {
				referencePath: path,
				distortedPath: path,
				modelPath: path,
				model: "vmaf_v0.6.1",
				logPath: join(dir, `out${index}`),
			},
		}),
	);
	const settled = Promise.allSettled(calls);
	try {
		await vi.waitFor(() => expect(t.adapter.submit).toHaveBeenCalledTimes(6), {
			timeout: 1000,
		});
	} finally {
		abort.abort();
		release();
		await settled;
	}
	expect(t.table.count).toHaveBeenCalledWith({
		where: { vmafJobId: "job", cleanedAt: null },
	});
	expect(t.tasks.get("other-report")?.cleanedAt).toBeNull();
	expect(
		[...t.tasks.values()]
			.filter((task) => task.vmafJobId === "job")
			.every((task) => task.cleanedAt),
	).toBe(true);
});

it("reserves the report budget atomically when all pairs arrive together", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-budget-race-"));
	dirs.push(dir);
	const path = join(dir, "input");
	await writeFile(path, "video");
	const t = setup();
	t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
	// Model the database advisory lock: each transaction sees prior committed reservations.
	let previous: Promise<unknown> = Promise.resolve();
	t.db.$transaction.mockImplementation((callback) => {
		const current = previous.then(() => callback(t.db));
		previous = current.catch(() => undefined);
		return current;
	});
	t.table.aggregate.mockImplementation(async () => ({
		_sum: {
			reservedUsd: [...t.tasks.values()]
				.filter((task) => task.vmafJobId === "job")
				.reduce((sum, task) => sum + task.reservedUsd, 0),
		},
	}));
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.mocked(t.adapter.submit).mockImplementation(async () => {
		await barrier;
		return "provider";
	});
	const pending = Promise.allSettled(
		Array.from({ length: 4 }, (_, index) =>
			t.controller.score({
				vmafJobId: "job",
				targetKey: `pair${index}`,
				pairCount: 4,
				profileId: profile.id,
				budgetUsd: 3,
				signal: new AbortController().signal,
				options: {
					referencePath: path,
					distortedPath: path,
					modelPath: path,
					model: "vmaf_v0.6.1",
					logPath: join(dir, `out${index}`),
				},
			}),
		),
	);
	try {
		await vi.waitFor(() => expect(t.table.aggregate).toHaveBeenCalledTimes(4));
		expect(t.table.create).toHaveBeenCalledTimes(1);
		expect(t.db.$executeRaw).toHaveBeenCalledTimes(4);
	} finally {
		release();
	}
	const outcomes = await pending;
	expect(
		outcomes.filter(
			(outcome) =>
				outcome.status === "rejected" && /budget/.test(outcome.reason.message),
		),
	).toHaveLength(3);
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
});

it.each([
	0,
	-1,
	1.5,
	Number.NaN,
])("rejects invalid pair count %s before staging", async (pairCount) => {
	const t = setup();
	await expect(
		t.controller.score({
			vmafJobId: "job",
			targetKey: "pair",
			pairCount,
			profileId: profile.id,
			budgetUsd: 10,
			signal: new AbortController().signal,
			options: {
				referencePath: "missing",
				distortedPath: "missing",
				modelPath: "missing",
				model: "vmaf_v0.6.1",
				logPath: "missing",
			},
		}),
	).rejects.toThrow("pair count");
	expect(t.store.upload).not.toHaveBeenCalled();
	expect(t.table.create).not.toHaveBeenCalled();
});

it("rejects remote identity mismatch before recording or submitting resources", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-remote-"));
	dirs.push(dir);
	const path = join(dir, "video");
	await writeFile(path, "video");
	const t = setup();
	await expect(
		t.controller.score({
			vmafJobId: "job",
			targetKey: "rung",
			profileId: profile.id,
			pairCount: 1,
			budgetUsd: 100,
			signal: new AbortController().signal,
			remoteInputs: {
				reference: {
					url: "https://storage.googleapis.com/b/k?X-Amz-Signature=test",
					sha256: "a".repeat(64),
					bytes: 5,
				},
			},
			options: {
				referencePath: path,
				distortedPath: path,
				modelPath: path,
				model: "vmaf_v0.6.1",
				logPath: join(dir, "out"),
			},
		}),
	).rejects.toThrow("does not match");
	expect(t.table.create).not.toHaveBeenCalled();
	expect(t.store.upload).not.toHaveBeenCalled();
	expect(t.adapter.submit).not.toHaveBeenCalled();
});

describe("frame-index receipt generation and crop policy", () => {
	const method = "FRAME_INDEX_BT709_10BIT" as const;
	const receipt = {
		measurementMethod: method,
		scoringVersion: 5,
	} as Parameters<typeof receiptMatchesMeasurement>[0];
	it("collects historical generation-5 receipts only for generation-5 jobs", () => {
		expect(receiptMatchesMeasurement(receipt, method, 5)).toBe(true);
		expect(receiptMatchesMeasurement(receipt, method, 6)).toBe(false);
	});
	it("requires the explicit decode policy and matching generation for new jobs", () => {
		expect(
			receiptMatchesMeasurement({ ...receipt, scoringVersion: 6 }, method, 6),
		).toBe(false);
		const current = {
			...receipt,
			scoringVersion: 6 as const,
			cropPolicy: "codec-only-ignore-container-aperture-v1" as const,
		};
		expect(receiptMatchesMeasurement(current, method, 6)).toBe(true);
		expect(receiptMatchesMeasurement(current, method, 5)).toBe(false);
		expect(
			receiptMatchesMeasurement(
				{ ...current, measurementMethod: undefined },
				method,
				6,
			),
		).toBe(false);
		expect(receiptMatchesMeasurement(current, method, undefined)).toBe(false);
	});
});

async function recoveryFixture(maxRetries = 1) {
	const dir = await mkdtemp(join(tmpdir(), "cloud-recovery-"));
	dirs.push(dir);
	const path = join(dir, "input");
	await writeFile(path, "video");
	const recoveryProfile = vmafCloudProfileSchema.parse({
		...profile,
		spotPolicy: { maxRetries, deadlineSeconds: 21600 },
	});
	const t = setup([], { profiles: [recoveryProfile] });
	t.db.vmafJob.findUnique.mockResolvedValue({ status: "RUNNING" } as never);
	const files = new Map<string, string>();
	const manifests: VmafCloudManifest[] = [];
	vi.mocked(t.store.upload).mockImplementation(async (key, file) => {
		files.set(key, await readFile(file, "utf8"));
	});
	vi.mocked(t.store.download).mockImplementation(async (key, file) => {
		const value = files.get(key);
		if (value === undefined) throw new StagingNotFoundError();
		await writeFile(file, value);
	});
	vi.mocked(t.store.remove).mockImplementation(async (keys) => {
		for (const key of keys) files.delete(key);
	});
	t.table.aggregate.mockImplementation(async () => ({
		_sum: {
			reservedUsd: [...t.tasks.values()].reduce((n, r) => n + r.reservedUsd, 0),
		},
	}));
	t.adapter.failureReason = vi.fn(async () => "PREEMPTED" as const);
	vi.mocked(t.adapter.submit).mockImplementation(async () => {
		const task = [...t.tasks.values()].at(-1);
		if (!task) throw Error("missing task");
		const entry = [...files.entries()].find(
			([key]) => key === `bitovp-vmaf/${task.id}/manifest.json`,
		);
		if (!entry) throw Error("missing manifest");
		const manifest = JSON.parse(entry[1]);
		manifests.push(manifest);
		// Every replacement must wait for the preceding provider deletion.
		expect(
			[...t.tasks.values()]
				.filter((r) => r.id !== task.id)
				.every((r) => r.cleanedAt),
		).toBe(true);
		return `provider-${task.id}`;
	});
	const request = {
		vmafJobId: "job",
		targetKey: "rung",
		profileId: profile.id,
		pairCount: 1,
		budgetUsd: 100,
		signal: new AbortController().signal,
		options: {
			referencePath: path,
			distortedPath: path,
			modelPath: path,
			model: "vmaf_v0.6.1",
			logPath: join(dir, "result"),
		},
	};
	return { ...t, files, manifests, request };
}
it("keeps Spot until retry ceiling, then submits one Standard attempt", async () => {
	const t = await recoveryFixture(1);
	await expect(t.controller.score(t.request)).rejects.toThrow("did not finish");
	expect(
		[...t.tasks.values()].map((r) => ({
			attempt: r.attempt,
			spot:
				vmafCloudProfileSchema.parse(r.profile).provider === "GCP_BATCH" &&
				(r.profile as { spot: boolean }).spot,
		})),
	).toEqual([
		{ attempt: 0, spot: true },
		{ attempt: 1, spot: true },
		{ attempt: 2, spot: false },
	]);
	expect(t.adapter.submit).toHaveBeenCalledTimes(3);
});
it("never upgrades application failures or ambiguous CREATE to paid replacements", async () => {
	for (const ambiguous of [false, true]) {
		const t = await recoveryFixture();
		t.adapter.failureReason = vi.fn(async () => "OTHER" as const);
		if (ambiguous)
			vi.mocked(t.adapter.submit).mockRejectedValueOnce(new Error("uncertain"));
		await expect(t.controller.score(t.request)).rejects.toThrow(
			"did not finish",
		);
		expect(t.adapter.submit).toHaveBeenCalledTimes(1);
	}
});
it("checks cumulative budget again before retry staging or submit", async () => {
	const t = await recoveryFixture();
	await expect(
		t.controller.score({ ...t.request, budgetUsd: 3 }),
	).rejects.toThrow("budget");
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
	expect(t.tasks.size).toBe(1);
});
it("does not submit a replacement if prior deletion fails", async () => {
	const t = await recoveryFixture();
	vi.mocked(t.adapter.cleanup).mockRejectedValue(
		new Error("delete not confirmed"),
	);
	await expect(t.controller.score(t.request)).rejects.toThrow(
		"delete not confirmed",
	);
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
	expect([...t.tasks.values()][0]?.cleanedAt).toBeNull();
});
it("preserves checkpoint before cleanup and pins it for the replacement", async () => {
	const t = await recoveryFixture(0);
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		const m = t.manifests.at(-1);
		if (!m) throw Error("missing manifest");
		const payload = { checkpoint: "test", taskId: m.taskId };
		const authentication = createHmac(
			"sha256",
			Buffer.from(m.checkpoint?.authenticationKey ?? "", "hex"),
		)
			.update(JSON.stringify(payload))
			.digest("hex");
		t.files.set(
			`bitovp-vmaf/${m.taskId}/checkpoint.json`,
			JSON.stringify({ ...payload, authentication }),
		);
		return "FAILED";
	});
	await expect(t.controller.score(t.request)).rejects.toThrow("did not finish");
	expect(t.manifests[1]?.checkpoint).toMatchObject({
		sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		readUrl: expect.any(String),
	});
});
it("cancellation during cleanup prevents a paid replacement", async () => {
	const t = await recoveryFixture();
	const abort = new AbortController();
	vi.mocked(t.adapter.cleanup).mockImplementation(async () => {
		abort.abort();
	});
	await expect(
		t.controller.score({ ...t.request, signal: abort.signal }),
	).rejects.toThrow();
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
});

it("fallback waits for Spot window even when it interrupts a running task", async () => {
	let clock = when;
	const t = await recoveryFixture(5);
	// Date via the controller dependency is replaced by setup fixture override below.
	const controller = createVmafCloudController({
		prisma: t.db as unknown as AppPrismaClient,
		profiles: [
			vmafCloudProfileSchema.parse({
				...profile,
				spotPolicy: { maxRetries: 5, deadlineSeconds: 60 },
			}),
		],
		workDir: tmpdir(),
		adapter: () => t.adapter,
		store: () => t.store,
		now: () => clock,
		pollMs: 1,
	});
	let first = true;
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		if (first) {
			first = false;
			clock = new Date(when.getTime() + 61000);
			return "RUNNING";
		}
		return "FAILED";
	});
	await expect(controller.score(t.request)).rejects.toThrow("did not finish");
	expect(
		[...t.tasks.values()].map((r) => (r.profile as { spot: boolean }).spot),
	).toEqual([true, false]);
	expect([...t.tasks.values()][1]?.progress).toMatchObject({
		transitionReason: "SPOT_DEADLINE",
	});
});
it("reset during teardown cannot create a replacement", async () => {
	const t = await recoveryFixture();
	vi.mocked(t.adapter.cleanup).mockImplementation(async () => {
		t.db.vmafJob.findUnique.mockResolvedValue(null);
	});
	await expect(t.controller.score(t.request)).rejects.toThrow(
		"no longer active",
	);
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
});
it("stores only identity-matched bounded progress without signed data", async () => {
	const t = await recoveryFixture();
	t.adapter.failureReason = vi.fn(async () => "OTHER" as const);
	const submit = t.adapter.submit;
	const impl = vi.mocked(submit).getMockImplementation();
	if (!impl) throw Error("missing implementation");
	vi.mocked(submit).mockImplementation(async (launch) => {
		const id = await impl(launch);
		const m = t.manifests.at(-1);
		if (!m) throw Error("missing manifest");
		t.files.set(
			`bitovp-vmaf/${m.taskId}/progress.json`,
			JSON.stringify({
				version: 1,
				taskId: m.taskId,
				image: m.image,
				phase: "SCORING",
				updatedAt: when.toISOString(),
				framesProcessed: 12,
				totalFrames: 100,
				url: "https://secret.invalid",
			}),
		);
		return id;
	});
	await expect(t.controller.score(t.request)).rejects.toThrow("did not finish");
	const progress = [...t.tasks.values()][0]?.progress;
	expect(progress).toMatchObject({
		phase: "SCORING",
		framesProcessed: 12,
		totalFrames: 100,
		attempt: 1,
		provisioningModel: "SPOT",
	});
	expect(JSON.stringify(progress)).not.toContain("secret");
});

it("does not treat an unexplained queue timeout as infrastructure capacity", async () => {
	let clock = when;
	const t = await recoveryFixture();
	const controller = createVmafCloudController({
		prisma: t.db as unknown as AppPrismaClient,
		profiles: [
			vmafCloudProfileSchema.parse({
				...profile,
				spotPolicy: { maxRetries: 2, deadlineSeconds: 21600 },
			}),
		],
		workDir: tmpdir(),
		adapter: () => t.adapter,
		store: () => t.store,
		now: () => clock,
		pollMs: 1,
	});
	t.adapter.failureReason = vi.fn(async () => "OTHER" as const);
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		clock = new Date(when.getTime() + 601000);
		return "QUEUED";
	});
	await expect(controller.score(t.request)).rejects.toThrow("did not finish");
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
});
it("reaches Standard after a Spot deadline abort during staging", async () => {
	let clock = when;
	const t = await recoveryFixture();
	const controller = createVmafCloudController({
		prisma: t.db as unknown as AppPrismaClient,
		profiles: [
			vmafCloudProfileSchema.parse({
				...profile,
				spotPolicy: { maxRetries: 2, deadlineSeconds: 60 },
			}),
		],
		workDir: tmpdir(),
		adapter: () => t.adapter,
		store: () => t.store,
		now: () => clock,
		pollMs: 1,
	});
	vi.mocked(t.store.upload).mockImplementationOnce(async () => {
		clock = new Date(when.getTime() + 61000);
		throw new DOMException("expired", "AbortError");
	});
	await expect(controller.score(t.request)).rejects.toThrow("did not finish");
	expect(
		[...t.tasks.values()].map((r) => (r.profile as { spot: boolean }).spot),
	).toEqual([true, false]);
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
});
it("waits out an unlaunchable sub-minute Spot window before Standard", async () => {
	const t = await recoveryFixture();
	let clock = when;
	const wait = vi.fn(async (ms: number) => {
		expect(t.adapter.submit).toHaveBeenCalledTimes(1);
		clock = new Date(clock.getTime() + ms);
	});
	const controller = createVmafCloudController({
		prisma: t.db as unknown as AppPrismaClient,
		profiles: [
			vmafCloudProfileSchema.parse({
				...profile,
				spotPolicy: { maxRetries: 2, deadlineSeconds: 60 },
			}),
		],
		workDir: tmpdir(),
		adapter: () => t.adapter,
		store: () => t.store,
		now: () => clock,
		pollMs: 1,
		wait,
	});
	let first = true;
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		if (first) {
			first = false;
			clock = new Date(when.getTime() + 30000);
		}
		return "FAILED";
	});
	await expect(controller.score(t.request)).rejects.toThrow("did not finish");
	expect(wait).toHaveBeenCalledWith(30000, t.request.signal);
	expect(
		[...t.tasks.values()].map((r) => (r.profile as { spot: boolean }).spot),
	).toEqual([true, false]);
});
it("rejects checkpoints whose payload was changed after the worker authenticated it", async () => {
	const t = await recoveryFixture(0);
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		const m = t.manifests.at(-1);
		if (!m) throw Error("manifest");
		const payload = { checkpoint: "good", taskId: m.taskId };
		const authentication = createHmac(
			"sha256",
			Buffer.from(m.checkpoint?.authenticationKey ?? "", "hex"),
		)
			.update(JSON.stringify(payload))
			.digest("hex");
		t.files.set(
			`bitovp-vmaf/${m.taskId}/checkpoint.json`,
			JSON.stringify({ ...payload, checkpoint: "tampered", authentication }),
		);
		return "FAILED";
	});
	await expect(t.controller.score(t.request)).rejects.toThrow("did not finish");
	expect(t.manifests[1]?.checkpoint?.readUrl).toBeUndefined();
});

it.each([
	["already_uploaded", false],
	["already_uploaded", true],
	["uploaded_during_status", false],
	["uploaded_during_status", true],
	["never_uploaded", false],
	["cancel_after_status", false],
	["deadline_after_status", false],
	["spot_deadline_after_status", false],
	["spot_timeout_after_success", false],
])("receipt/status ordering: %s tampered=%s", async (ordering, tampered) => {
	const dir = await mkdtemp(join(tmpdir(), "cloud-receipt-race-"));
	dirs.push(dir);
	const input = join(dir, "input");
	await writeFile(input, "video");
	let clock = when;
	const aborter = new AbortController();
	const t = setup([], {
		now: () => clock,
		profiles: [
			ordering.startsWith("spot_")
				? vmafCloudProfileSchema.parse({
						...profile,
						spot: true,
						spotPolicy: { maxRetries: 1, deadlineSeconds: 60 },
					})
				: profile,
		],
	});
	t.db.vmafJob.findUnique.mockResolvedValue({
		status: "RUNNING",
		scoringVersion: 6,
	} as never);
	const files = new Map<string, string>();
	const trace: string[] = [];
	let pending: {
		receiptKey: string;
		receipt: string;
		resultKey: string;
		result: string;
	};
	const publish = () => {
		files.set(pending.resultKey, pending.result);
		files.set(pending.receiptKey, pending.receipt);
		trace.push("worker:result+receipt-uploaded");
	};
	vi.mocked(t.store.upload).mockImplementation(async (key, file) => {
		files.set(key, await readFile(file, "utf8"));
	});
	vi.mocked(t.store.download).mockImplementation(async (key, file) => {
		const content = files.get(key);
		if (!content) {
			trace.push(
				key.endsWith("receipt.json")
					? "controller:receipt-GET404"
					: "controller:missing-other",
			);
			throw new StagingNotFoundError();
		}
		if (key.endsWith("receipt.json")) trace.push("controller:receipt-GET200");
		if (
			ordering === "spot_timeout_after_success" &&
			key.endsWith("receipt.json")
		) {
			clock = new Date(when.getTime() + 61_000);
			const timeout = new Error("receipt download deadline");
			timeout.name = "TimeoutError";
			throw timeout;
		}
		if (key.endsWith("result.json")) trace.push("controller:result-GET200");
		await writeFile(file, content);
	});
	vi.mocked(t.adapter.submit).mockImplementation(async () => {
		const entry = [...files].find(([k]) => k.endsWith("manifest.json"));
		if (!entry) throw new Error("Missing race fixture manifest");
		const [key, raw] = entry;
		const manifest = JSON.parse(raw);
		const prefix = key.replace("manifest.json", "");
		const result = JSON.stringify({
			frames: Array.from({ length: 14315 }, (_, frameNum) => ({
				frameNum,
				metrics: { vmaf: 95, psnr_y: 40 },
			})),
		});
		pending = {
			resultKey: `${prefix}result.json`,
			result,
			receiptKey: `${prefix}receipt.json`,
			receipt: JSON.stringify({
				version: 1,
				taskId: tampered ? "foreign-task" : manifest.taskId,
				image: profile.image,
				referenceSha256: manifest.reference.sha256,
				distortedSha256: manifest.distorted.sha256,
				modelSha256: manifest.modelFile.sha256,
				resultSha256: createHash("sha256").update(result).digest("hex"),
				frames: 14315,
				referenceFrames: 14315,
				ffmpegVersion: "offline-fixture",
				completedAt: when.toISOString(),
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				scoringVersion: 6,
				cropPolicy: VMAF_FRAME_INDEX_CROP_POLICY,
			}),
		};
		if (ordering === "already_uploaded") publish();
		return "owned-provider";
	});
	vi.mocked(t.adapter.status).mockImplementation(async () => {
		if (
			[
				"uploaded_during_status",
				"cancel_after_status",
				"deadline_after_status",
				"spot_deadline_after_status",
				"spot_timeout_after_success",
			].includes(ordering) &&
			!files.has(pending.receiptKey)
		)
			publish();
		if (ordering === "cancel_after_status") aborter.abort();
		if (ordering === "deadline_after_status")
			clock = new Date(when.getTime() + 7_200_000);
		if (ordering === "spot_deadline_after_status")
			clock = new Date(when.getTime() + 61_000);
		if (ordering === "spot_timeout_after_success")
			clock = new Date(Math.max(clock.getTime(), when.getTime() + 59_000));
		trace.push("adapter:SUCCEEDED");
		return "SUCCEEDED";
	});
	vi.mocked(t.store.remove).mockImplementation(async (keys) => {
		trace.push("cleanup:remove-staging");
		for (const key of keys) files.delete(key);
	});
	const call = t.controller.score({
		vmafJobId: "parent",
		targetKey: "1080/0",
		profileId: profile.id,
		pairCount: 1,
		budgetUsd: 100,
		signal: aborter.signal,
		options: {
			referencePath: input,
			distortedPath: input,
			modelPath: input,
			model: "vmaf_v1.0.16_3d0h",
			logPath: join(dir, "result.json"),
			subsample: 1,
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			scaleToReference: { width: 1920, height: 1080 },
		},
	});
	let caught: unknown;
	try {
		await call;
	} catch (error) {
		caught = error;
	}
	const task = [...t.tasks.values()][0];
	if (!task) throw new Error("Missing race fixture task");
	if (
		tampered ||
		[
			"never_uploaded",
			"cancel_after_status",
			"deadline_after_status",
			"spot_deadline_after_status",
			"spot_timeout_after_success",
		].includes(ordering)
	) {
		expect(caught).toBeInstanceOf(Error);
		expect(task.receipt).toBeNull();
		if (ordering === "uploaded_during_status")
			expect(trace).toContain("controller:receipt-GET200");
	} else {
		// Regression: a fully valid generation-6 receipt uploaded before the status
		// response must be collected and verified, never discarded by cleanup.
		expect(caught).toBeUndefined();
		expect(task.receipt).toMatchObject({
			frames: 14315,
			referenceFrames: 14315,
			scoringVersion: 6,
		});
	}
	expect(t.adapter.submit).toHaveBeenCalledTimes(1);
	if (ordering.startsWith("spot_")) {
		expect(t.tasks.size).toBe(1);
		expect([...t.tasks.values()].every((value) => !value.receipt)).toBe(true);
	}
	expect(
		trace.filter((value) => value.startsWith("controller:receipt-GET")),
	).toHaveLength(
		[
			"already_uploaded",
			"cancel_after_status",
			"deadline_after_status",
			"spot_deadline_after_status",
		].includes(ordering)
			? 1
			: 2,
	);
});
