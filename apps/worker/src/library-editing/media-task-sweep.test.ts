import { randomUUID } from "node:crypto";
import {
	DEFAULT_ASR_MODEL_SHA256,
	editingAnalysisBindingSchema,
	hashEditingEvidence,
	localStoryIdentityForConfiguration,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	sceneAnalysisDocumentSchema,
} from "@bitovp/core";
import { matchesWhere, orderRows } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";
import { MediaOperationError } from "./process";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./media-task-execution", async (original) => ({
	...(await original<object>()),
	executeMediaTask: execute,
}));
afterEach(() => {
	execute.mockReset();
	vi.useRealTimers();
});
type Row = Record<string, unknown>;
type DeadlineOptions = Pick<
	Parameters<typeof createLibraryMediaTaskSweep>[0],
	"timeoutMs" | "localStoryTimeoutMs"
>;
function setup(
	mode: "TRANSCRIBE" | "LOCAL_STORY" | "DURATION" = "TRANSCRIBE",
	deadlines: DeadlineOptions = {},
) {
	const organizationId = randomUUID(),
		mediaId = randomUUID();
	let instant = new Date("2026-11-02T00:00:00Z");
	const media = {
		id: mediaId,
		organizationId,
		sourceId: randomUUID(),
		state: "READY",
		sha256: "a".repeat(64),
		width: 1280,
		height: 720,
		timeMap: {
			id: mediaId,
			mediaVersionId: mediaId,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
	};
	const analysis = {
		id: randomUUID(),
		organizationId,
		sourceId: media.sourceId,
		locale: "ja",
		rawHash: "c".repeat(64),
		document: sceneAnalysisDocumentSchema.parse({
			providerVersion: "authored-sweep-regression",
			duration: 2,
			title: "対象と出来事",
			scenes: [
				{
					id: randomUUID(),
					startInSeconds: 0,
					endInSeconds: 2,
					type: "MAIN_CONTENT",
					title: "導入",
					summary: "対象が道具を見つける。",
					shots: [],
				},
			],
		}),
	};
	const binding = editingAnalysisBindingSchema.parse({
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId: media.sourceId,
		locale: analysis.locale,
		analysisRevisionId: analysis.id,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: media.id,
		mediaSha256: media.sha256,
		timeMapId: media.timeMap.id,
		timeMapHash: hashEditingEvidence(media.timeMap),
		sourceStartUs: media.timeMap.sourceStartUs,
		sourceEndUs: media.timeMap.sourceEndUs,
		width: media.width,
		height: media.height,
	});
	const input = mediaTaskCreateSchema.parse(
		mode === "TRANSCRIBE"
			? {
					kind: "TRANSCRIBE",
					mediaVersionId: mediaId,
					requestKey: randomUUID(),
					parameters: { language: "ja" },
				}
			: {
					kind: "GENERATE",
					mediaVersionId: mediaId,
					analysisRevisionId: analysis.id,
					requestKey: randomUUID(),
					parameters: {
						contentId: randomUUID(),
						targetDurationFrames: 30,
						policy: mode,
						renderMode: "DRAFT",
						captions: "OFF",
						tracking: false,
					},
				},
	);
	const identity = {
		organizationId,
		mediaSha256: media.sha256,
		modelSha256: DEFAULT_ASR_MODEL_SHA256,
		analysisDocumentHash:
			mode === "TRANSCRIBE" ? null : binding.analysisDocumentHash,
		analysisRawHash: mode === "TRANSCRIBE" ? null : analysis.rawHash,
		timeMapHash: hashEditingEvidence(media.timeMap),
		bindingHash: mode === "TRANSCRIBE" ? null : hashEditingEvidence(binding),
		...(mode === "TRANSCRIBE" ? {} : { bindingSnapshot: binding }),
		...(mode === "LOCAL_STORY"
			? {
					localStoryModel: localStoryIdentityForConfiguration({
						url: "https://127.0.0.1:11437",
						token: "x".repeat(48),
						caFile: "/fixed-test-ca.pem",
						profile: "nvidia",
						configId: randomUUID(),
					}),
				}
			: {}),
	};
	const row: Row = {
		id: randomUUID(),
		organizationId,
		mediaVersionId: mediaId,
		analysisRevisionId: mode === "TRANSCRIBE" ? null : analysis.id,
		parentTaskId: null,
		kind: input.kind,
		requestKey: input.requestKey,
		requestHash: mediaTaskIntentHash(input),
		cacheKey: mediaTaskCacheKey(input, identity),
		parameters: { schemaVersion: 1, input, identity },
		state: "PENDING",
		phase: "QUEUED",
		progress: null,
		result: null,
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		cancelRequestedAt: null,
		error: null,
		createdAt: instant,
		startedAt: null,
		finishedAt: null,
	};
	const rows = [row];
	const delegate = {
		findMany: vi.fn(
			async ({
				where,
				orderBy,
				take,
			}: {
				where: Row;
				orderBy?: Row[];
				take: number;
			}) =>
				orderRows(
					rows.filter((r) => matchesWhere(r, where)),
					orderBy,
				)
					.slice(0, take)
					.map((r) => ({ ...r })),
		),
		findUnique: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.find((r) => matchesWhere(r, where)) ?? null,
		),
		findFirst: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.find((r) => matchesWhere(r, where)) ?? null,
		),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			let count = 0;
			for (const r of rows)
				if (matchesWhere(r, where)) {
					for (const [key, value] of Object.entries(data))
						r[key] =
							value && typeof value === "object" && "increment" in value
								? Number(r[key]) + Number(value.increment)
								: value;
					count++;
				}
			return { count };
		}),
	};
	const tx = {
		libraryMediaTask: delegate,
		libraryMediaVersion: { findUnique: vi.fn(async () => media) },
		sceneAnalysisRevision: { findUnique: vi.fn(async () => analysis) },
		$queryRaw: vi.fn(async () => [{ proof: binding }]),
		$executeRaw: vi.fn(async () => 1),
	};
	let serial = Promise.resolve();
	const prisma = {
		...tx,
		$transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
			const result = serial.then(() => fn(tx));
			serial = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	} as unknown as AppPrismaClient;
	execute.mockResolvedValue({ segments: [{ text: "実際の結果" }] });
	const controller = new AbortController();
	const sweep = createLibraryMediaTaskSweep({
		prisma,
		browserFor: vi.fn(),
		now: () => instant,
		signal: controller.signal,
		...deadlines,
	});
	return {
		row,
		rows,
		media,
		analysis,
		binding,
		delegate,
		sweep,
		controller,
		setNow: (time: number) => {
			instant = new Date(time);
		},
	};
}
describe("durable production worker fences", () => {
	it("runs one actual execution and commits result against the owning lease", async () => {
		const f = setup();
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "SUCCEEDED",
			phase: "COMPLETE",
			attempts: 1,
			leaseToken: null,
			result: { segments: [{ text: "実際の結果" }] },
		});
		expect(execute).toHaveBeenCalledOnce();
	});
	it("waits for media without consuming attempts", async () => {
		const f = setup();
		f.media.state = "PENDING";
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "PENDING",
			phase: "WAITING_FOR_MEDIA",
			attempts: 0,
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("reuses an exact success without another execution", async () => {
		const f = setup();
		f.rows.push({
			...f.row,
			id: randomUUID(),
			state: "SUCCEEDED",
			result: { cached: "retained" },
			finishedAt: new Date(),
		});
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "SUCCEEDED",
			phase: "CACHED",
			result: { cached: "retained" },
			attempts: 0,
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("does not copy a result across organizations", async () => {
		const f = setup();
		f.rows.push({
			...f.row,
			id: randomUUID(),
			organizationId: randomUUID(),
			state: "SUCCEEDED",
			result: { secret: "foreign" },
		});
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(f.row.result).not.toEqual({ secret: "foreign" });
	});
	it("does not execute a second active task for the same cache identity", async () => {
		const f = setup();
		f.rows.push({
			...f.row,
			id: randomUUID(),
			state: "RUNNING",
			leaseToken: randomUUID(),
			leaseUntil: new Date("2026-11-02T00:01:00Z"),
		});
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "PENDING",
			phase: "WAITING_FOR_CACHE",
			attempts: 0,
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("does not publish a stale worker's result after lease replacement", async () => {
		const f = setup();
		execute.mockImplementation(async () => {
			f.row.leaseToken = randomUUID();
			return { stale: true };
		});
		await f.sweep();
		expect(f.row.state).toBe("RUNNING");
		expect(f.row.result).toBeNull();
	});
	it("recovers an expired crash lease and bounds repeated crashes", async () => {
		const f = setup();
		Object.assign(f.row, {
			state: "RUNNING",
			leaseToken: randomUUID(),
			leaseUntil: new Date("2026-11-01T23:59:00Z"),
			attempts: 2,
		});
		await f.sweep();
		expect(f.row).toMatchObject({ state: "SUCCEEDED", attempts: 3 });
		const exhausted = setup();
		Object.assign(exhausted.row, {
			state: "RUNNING",
			leaseToken: randomUUID(),
			leaseUntil: new Date("2026-11-01T23:59:00Z"),
			attempts: 3,
		});
		await exhausted.sweep();
		expect(exhausted.row).toMatchObject({
			state: "ERROR",
			error: "TASK_ATTEMPTS_EXHAUSTED",
		});
	});
	it("cancels a requested task before executing", async () => {
		const f = setup();
		f.row.cancelRequestedAt = new Date();
		await f.sweep();
		expect(f.row.state).toBe("CANCELED");
		expect(execute).not.toHaveBeenCalled();
	});
	it("rejects changed immutable input evidence before work", async () => {
		const f = setup();
		f.media.sha256 = "b".repeat(64);
		await f.sweep();
		expect(f.row).toMatchObject({ state: "ERROR", error: "SOURCE_CHANGED" });
		expect(execute).not.toHaveBeenCalled();
	});
	it("keeps queue waiting time separate from execution time", async () => {
		const f = setup(),
			created = new Date("2026-11-02T00:00:00Z").getTime();
		f.setNow(created + 5_000);
		execute.mockImplementation(async () => {
			f.setNow(created + 12_000);
			return { complete: true };
		});
		await f.sweep();
		expect(f.row.progress).toMatchObject({ queueWaitMs: 5_000 });
	});
	it("executes again after an explicitly non-cacheable partial success", async () => {
		const f = setup();
		f.rows.push({
			...f.row,
			id: randomUUID(),
			state: "SUCCEEDED",
			result: { cacheable: false, warnings: ["ASR_MODEL_NOT_CONFIGURED"] },
		});
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(f.row).toMatchObject({
			state: "SUCCEEDED",
			phase: "COMPLETE",
			attempts: 1,
		});
	});
	it("aborts active execution when a progress heartbeat observes cancellation", async () => {
		const f = setup();
		execute.mockImplementation(
			async ({
				signal,
				onProgress,
			}: {
				signal: AbortSignal;
				onProgress(phase: string): Promise<void>;
			}) => {
				f.row.cancelRequestedAt = new Date();
				await expect(onProgress("TRACKING")).rejects.toMatchObject({
					code: "CANCELED",
				});
				expect(signal.aborted).toBe(true);
				throw signal.reason;
			},
		);
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "CANCELED",
			result: null,
			leaseToken: null,
		});
	});
	it("leaves shutdown work recoverable without publishing a late result", async () => {
		const f = setup();
		execute.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
			f.controller.abort();
			expect(signal.aborted).toBe(true);
			throw signal.reason;
		});
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "RUNNING",
			result: null,
			attempts: 1,
		});
		expect((f.row.leaseUntil as Date).getTime()).toBeLessThan(
			new Date("2026-11-02T00:00:00Z").getTime(),
		);
	});
});

describe("local story execution deadlines and cancellation", () => {
	it.each([
		["TRANSCRIBE", 15 * 60_000],
		["DURATION", 15 * 60_000],
		["LOCAL_STORY", 90 * 60_000],
	] as const)("passes the default deadline for %s through the verified claim", async (mode, timeoutMs) => {
		const f = setup(mode);
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(execute.mock.calls[0]?.[0]).toMatchObject({ timeoutMs });
		expect(f.row).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
	});
	it.each([
		["TRANSCRIBE", 1234],
		["DURATION", 1234],
		["LOCAL_STORY", 4321],
	] as const)("uses the matching configured deadline for %s", async (mode, timeoutMs) => {
		const f = setup(mode, { timeoutMs: 1234, localStoryTimeoutMs: 4321 });
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(execute.mock.calls[0]?.[0]).toMatchObject({ timeoutMs });
	});
	it("keeps the existing 30 minute bound and enforces the separate 120 minute local bound", () => {
		expect(() => setup("TRANSCRIBE", { timeoutMs: 30 * 60_000 })).not.toThrow();
		expect(() => setup("TRANSCRIBE", { timeoutMs: 30 * 60_000 + 1 })).toThrow(
			RangeError,
		);
		expect(() =>
			setup("LOCAL_STORY", { localStoryTimeoutMs: 120 * 60_000 }),
		).not.toThrow();
		for (const localStoryTimeoutMs of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			120 * 60_000 + 1,
		]) {
			expect(() => setup("LOCAL_STORY", { localStoryTimeoutMs })).toThrow(
				RangeError,
			);
		}
		expect(execute).not.toHaveBeenCalled();
	});
	it("retains local cleanup failure after a heartbeat aborts the user-requested cancellation", async () => {
		const f = setup("LOCAL_STORY");
		execute.mockImplementation(
			async ({
				signal,
				onProgress,
			}: {
				signal: AbortSignal;
				onProgress(phase: string): Promise<void>;
			}) => {
				f.row.cancelRequestedAt = new Date();
				await expect(onProgress("ANALYZING_LOCAL_STORY")).rejects.toMatchObject(
					{ code: "CANCELED" },
				);
				expect(signal.aborted).toBe(true);
				throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
			},
		);
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(f.row).toMatchObject({
			state: "ERROR",
			phase: "CANCEL_UNCONFIRMED",
			error: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			result: null,
			leaseToken: null,
			leaseUntil: null,
		});
		expect(f.row.finishedAt).toBeInstanceOf(Date);
	});
	it("retains local cleanup failure after worker shutdown aborts the signal", async () => {
		const f = setup("LOCAL_STORY");
		execute.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
			f.controller.abort();
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toMatchObject({ code: "LEASE_LOST" });
			throw new MediaOperationError("LOCAL_SEMANTIC_CANCEL_UNCONFIRMED");
		});
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(f.row).toMatchObject({
			state: "ERROR",
			phase: "CANCEL_UNCONFIRMED",
			error: "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
			result: null,
			leaseToken: null,
			leaseUntil: null,
		});
	});
	it("continues to complete a confirmed local cancellation as CANCELED", async () => {
		const f = setup("LOCAL_STORY");
		execute.mockImplementation(
			async ({
				signal,
				onProgress,
			}: {
				signal: AbortSignal;
				onProgress(phase: string): Promise<void>;
			}) => {
				f.row.cancelRequestedAt = new Date();
				await expect(onProgress("ANALYZING_LOCAL_STORY")).rejects.toMatchObject(
					{ code: "CANCELED" },
				);
				throw signal.reason;
			},
		);
		await f.sweep();
		expect(execute).toHaveBeenCalledOnce();
		expect(f.row).toMatchObject({
			state: "CANCELED",
			phase: "CANCELED",
			error: null,
			result: null,
			leaseToken: null,
		});
	});
	it("aborts on the configured local deadline instead of the shorter ordinary deadline", async () => {
		vi.useFakeTimers();
		const f = setup("LOCAL_STORY", { timeoutMs: 5, localStoryTimeoutMs: 50 });
		let observed: AbortSignal | undefined;
		let begin = () => {};
		const began = new Promise<void>((resolve) => {
			begin = resolve;
		});
		execute.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
			observed = signal;
			begin();
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		});
		const running = f.sweep();
		try {
			await began;
			await vi.advanceTimersByTimeAsync(49);
			expect(observed?.aborted).toBe(false);
			expect(f.row.state).toBe("RUNNING");
			await vi.advanceTimersByTimeAsync(1);
			await running;
			expect(observed?.reason).toMatchObject({ code: "TIMED_OUT" });
			expect(f.row).toMatchObject({
				state: "ERROR",
				phase: "FAILED",
				error: "TIMED_OUT",
				result: null,
			});
		} finally {
			f.controller.abort();
			await running;
		}
	});
	it("still rejects changed analysis evidence before a local execution starts", async () => {
		const f = setup("LOCAL_STORY");
		f.analysis.rawHash = "d".repeat(64);
		await f.sweep();
		expect(f.row).toMatchObject({
			state: "ERROR",
			error: "ANALYSIS_BINDING_UNVERIFIED",
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
