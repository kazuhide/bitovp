import { describe, expect, it, vi } from "vitest";
import planFixture from "../../core/src/plan/__fixtures__/ai-scene-analysis-passthrough-test.plan.json";
import type { AppPrismaClient } from "./client";
import { LibrarySourceError, requestLibrarySource } from "./library-source";

function setup(overrides = {}) {
	const job = {
		id: "00000000-0000-4000-8000-000000000001",
		name: "Durable asset",
		status: "FINISHED",
		plan: planFixture,
		bitmovinEncodingId: "00000000-0000-4000-8000-000000000002",
		bitmovinAccountId: "00000000-0000-4000-8000-000000000003",
		qcVerdict: { pass: true },
		qcOverriddenAt: null,
		libraryCaptureSuppressed: false,
		...overrides,
	};
	let stored: unknown = null;
	let content: unknown = null;
	const tx = {
		$queryRaw: vi.fn(async () => [{ id: job.id }]),
		encodingJob: {
			findUnique: vi.fn(async () => job),
			update: vi.fn(async ({ data }) => Object.assign(job, data)),
		},
		credential: { findMany: vi.fn(async () => []) },
		vmafJob: {
			findMany: vi.fn(async () => [
				{
					id: "measurement",
					model: "vmaf_v0.6.1",
					results: [{ pooled: { mean: 90 } }],
				},
			]),
		},
		librarySource: {
			findUnique: vi.fn(async () => stored),
			update: vi.fn(async ({ data }) => {
				stored = { ...(stored as Record<string, unknown>), ...data };
				return stored;
			}),
			create: vi.fn(async ({ data }) => {
				stored = { id: "source", ...data };
				return stored;
			}),
		},
		content: {
			findUnique: vi.fn(async () => content),
			create: vi.fn(async ({ data }) => {
				content = { id: "content", ...data };
				return content;
			}),
		},
		contentRevision: { create: vi.fn(async ({ data }) => data) },
	};
	const prisma = {
		$transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
	} as unknown as AppPrismaClient;
	return { job, tx, prisma };
}

describe("requestLibrarySource", () => {
	it("upgrades file coordinates once even when the MP4 link is already captured", async () => {
		const { job, tx, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		delete (source.snapshot as Record<string, unknown>).fileOutputs;
		const upgraded = await requestLibrarySource(prisma, job.id);
		expect(upgraded.snapshot).toHaveProperty("fileOutputs", [
			expect.objectContaining({
				key: "mp4:v180",
				credentialId: planFixture.outputs[0]?.credentialId,
				bucket: "sample-output-bucket",
			}),
		]);
		await requestLibrarySource(prisma, job.id);
		expect(tx.librarySource.update).toHaveBeenCalledOnce();
	});
	it("persists MP4 playback independently of the original job", async () => {
		const { job, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		expect(source.snapshot).toHaveProperty("playbackLinks", [
			expect.objectContaining({
				key: "mp4:v180",
				kind: "MP4",
				path: expect.stringContaining("180p.mp4"),
			}),
		]);
	});
	it("appends missing MP4 links once while preserving historical links and analysis state", async () => {
		const { job, tx, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		const historical = {
			key: "hls",
			kind: "HLS",
			label: "Historical HLS",
			url: "https://old.example.test/index.m3u8",
			path: "index.m3u8",
			via: "derived",
		};
		(source.snapshot as Record<string, unknown>).playbackLinks = [historical];
		source.state = "ERROR";
		const upgraded = await requestLibrarySource(prisma, job.id);
		expect(upgraded).toMatchObject({
			state: "ERROR",
			snapshot: {
				playbackLinks: [historical, expect.objectContaining({ kind: "MP4" })],
			},
		});
		await requestLibrarySource(prisma, job.id);
		expect(tx.librarySource.update).toHaveBeenCalledOnce();
		expect(tx.content.create).toHaveBeenCalledOnce();
	});
	it("versions the locked job after automatic capture so a waiting Serializable reset cannot miss the new source", async () => {
		const { job, tx, prisma } = setup();
		await requestLibrarySource(prisma, job.id);
		expect(tx.encodingJob.update).toHaveBeenCalledWith({
			where: { id: job.id },
			data: { libraryCaptureSuppressed: false },
		});
		expect(tx.encodingJob.update.mock.invocationCallOrder[0]).toBeGreaterThan(
			tx.contentRevision.create.mock.invocationCallOrder[0] ?? 0,
		);
	});
	it.each([
		"RUNNING",
		"mismatched-plan",
	])("does not enrich an unsafe legacy capture: %s", async (condition) => {
		const { job, tx, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		const snapshot = source.snapshot as Record<string, unknown>;
		snapshot.playbackLinks = [];
		if (condition === "RUNNING") source.state = "RUNNING";
		else snapshot.planHash = "another-plan";
		await requestLibrarySource(prisma, job.id);
		expect(tx.librarySource.update).not.toHaveBeenCalled();
	});
	it("does not clear suppression when explicit registration fails after creating the source", async () => {
		const { job, tx, prisma } = setup({ libraryCaptureSuppressed: true });
		tx.contentRevision.create.mockRejectedValueOnce(
			new Error("registration failed"),
		);
		await expect(
			requestLibrarySource(prisma, job.id, { explicit: true }),
		).rejects.toThrow("registration failed");
		expect(tx.encodingJob.update).not.toHaveBeenCalled();
		expect(job.libraryCaptureSuppressed).toBe(true);
	});
	it("rejects a stale automatic capture after reset suppresses the locked job", async () => {
		const { job, tx, prisma } = setup();
		// The sweep selected an eligible job before reset; the locked read is newer.
		tx.$queryRaw.mockImplementationOnce(async () => {
			job.libraryCaptureSuppressed = true;
			return [{ id: job.id }];
		});
		await expect(requestLibrarySource(prisma, job.id)).rejects.toMatchObject({
			status: 409,
			publicMessage: expect.stringContaining("automatic library capture"),
		});
		expect(tx.librarySource.create).not.toHaveBeenCalled();
		expect(tx.content.create).not.toHaveBeenCalled();
		expect(tx.encodingJob.update).not.toHaveBeenCalled();
	});
	it("explicit recapture clears suppression in the same transaction and restores automatic capture", async () => {
		const { job, tx, prisma } = setup({ libraryCaptureSuppressed: true });
		const source = await requestLibrarySource(prisma, job.id, {
			explicit: true,
		});
		expect(tx.encodingJob.update).toHaveBeenCalledWith({
			where: { id: job.id },
			data: { libraryCaptureSuppressed: false },
		});
		expect(tx.encodingJob.update.mock.invocationCallOrder[0]).toBeGreaterThan(
			tx.contentRevision.create.mock.invocationCallOrder[0] ?? 0,
		);
		expect(await requestLibrarySource(prisma, job.id)).toEqual(source);
		expect(tx.librarySource.create).toHaveBeenCalledOnce();
	});
	it("invalid explicit recapture leaves suppression intact", async () => {
		const { job, tx, prisma } = setup({
			libraryCaptureSuppressed: true,
			status: "RUNNING",
		});
		await expect(
			requestLibrarySource(prisma, job.id, { explicit: true }),
		).rejects.toBeInstanceOf(LibrarySourceError);
		expect(tx.encodingJob.update).not.toHaveBeenCalled();
		expect(job.libraryCaptureSuppressed).toBe(true);
	});
	it("locks job before snapshot and persists independent QC/input/source identity without the plan", async () => {
		const { job, tx, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			tx.encodingJob.findUnique.mock.invocationCallOrder[0] ?? 0,
		);
		expect(source).toMatchObject({
			originalJobId: job.id,
			encodingId: job.bitmovinEncodingId,
			accountId: job.bitmovinAccountId,
			locales: ["ja", "ko"],
			snapshot: {
				identity: "UNVERIFIED",
				qcVerdict: { pass: true },
				inputs: [
					{ name: "Test S3 Input", path: "big_buck_bunny_1080p_h264.mov" },
				],
				qcEvidence: [
					{ id: "measurement", results: [{ pooled: { mean: 90 } }] },
				],
			},
		});
		expect(source.snapshot).not.toHaveProperty("plan");
		expect(source.snapshot).not.toHaveProperty("credentials");
		expect(tx.credential.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: { id: true, provider: true, config: true },
			}),
		);
	});
	it("same source capture is idempotent", async () => {
		const { job, tx, prisma } = setup();
		const first = await requestLibrarySource(prisma, job.id);
		expect(await requestLibrarySource(prisma, job.id)).toEqual(first);
		expect(tx.librarySource.create).toHaveBeenCalledOnce();
		expect(tx.content.create).toHaveBeenCalledOnce();
		expect(tx.contentRevision.create).toHaveBeenCalledOnce();
	});
	it("upgrades a failed legacy capture once without overwriting content", async () => {
		const { job, tx, prisma } = setup();
		const legacy = await requestLibrarySource(prisma, job.id);
		delete (legacy.snapshot as Record<string, unknown>).analysisOutput;
		legacy.state = "ERROR";
		legacy.attempts = 5;
		const upgraded = await requestLibrarySource(prisma, job.id);
		expect(upgraded).toMatchObject({ state: "PENDING", attempts: 0 });
		expect(upgraded.snapshot).toHaveProperty("analysisOutput");
		await requestLibrarySource(prisma, job.id);
		expect(tx.librarySource.update).toHaveBeenCalledOnce();
		expect(tx.content.create).toHaveBeenCalledOnce();
	});
	it("registers an asset before analysis arrives and records its configured output", async () => {
		const { job, tx, prisma } = setup();
		const source = await requestLibrarySource(prisma, job.id);
		expect(source.snapshot).toHaveProperty(
			"analysisOutput.filename",
			planFixture.aiSceneAnalysis.assetDescription.filename,
		);
		expect(tx.content.create).toHaveBeenCalledWith({
			data: {
				registrationKey: source.id,
				title: job.name,
				description: "",
				tags: [],
				locale: "ja",
			},
		});
	});
	it("registers finished non-AISA assets without fabricating analysis or QC pass", async () => {
		const { job, tx, prisma } = setup({
			plan: { ...planFixture, aiSceneAnalysis: undefined },
			qcVerdict: null,
		});
		const source = await requestLibrarySource(prisma, job.id);
		expect(source).toMatchObject({
			locales: [],
			state: "READY",
			snapshot: { qcVerdict: null },
		});
		expect(tx.content.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ locale: "und" }),
			}),
		);
	});
	it("never overwrites or unarchives already registered content", async () => {
		const { job, tx, prisma } = setup();
		tx.content.findUnique.mockResolvedValue({
			id: "existing",
			archived: true,
			title: "Edited title",
		});
		await requestLibrarySource(prisma, job.id);
		expect(tx.content.create).not.toHaveBeenCalled();
		expect(tx.contentRevision.create).not.toHaveBeenCalled();
	});
	it.each([
		{ status: "RUNNING" },
		{ status: "AWAITING_QC" },
		{ status: "QC_FAILED" },
		{ plan: {} },
		{ bitmovinEncodingId: null },
		{ bitmovinAccountId: null },
	])("rejects ineligible job %j without saving pending work", async (overrides) => {
		const { job, tx, prisma } = setup(overrides);
		await expect(requestLibrarySource(prisma, job.id)).rejects.toBeInstanceOf(
			LibrarySourceError,
		);
		expect(tx.librarySource.create).not.toHaveBeenCalled();
	});
});
