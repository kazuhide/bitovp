import { randomUUID } from "node:crypto";
import {
	mediaTaskCacheKey,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";
import {
	executeMediaTask,
	speechSelectionIntentFailureCode,
	type VerifiedMediaTask,
} from "./media-task-execution";
import { createLibraryMediaTaskSweep } from "./media-task-sweep";

function unfinished(state: "PENDING" | "RUNNING" = "PENDING") {
	const f = generationDependencyFixture("TRANSCRIBE"),
		now = new Date();
	delete f.task.parameters.identity.speechSelectionPolicyVersion;
	f.task.cacheKey = mediaTaskCacheKey(
		f.task.parameters.input,
		f.task.parameters.identity,
	);
	Object.assign(f.task, {
		state,
		phase: "QUEUED",
		availableAt: now,
		createdAt: now,
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		error: null,
		leaseToken: state === "RUNNING" ? randomUUID() : null,
		leaseUntil: state === "RUNNING" ? new Date(now.getTime() - 1) : null,
	});
	return { ...f, now };
}

describe("speech selection intent is fenced before unfinished work", () => {
	it.each([
		false,
		true,
	])("checks an unsupported policy before preparation waiting (current=%s)", async (current) => {
		const f = unfinished(),
			browserFor = vi.fn();
		Object.assign(f.media, {
			state: "PENDING",
			sha256: null,
			timeMap: null,
			durationUs: null,
			width: null,
			height: null,
		});
		const identity = f.task.parameters.identity;
		identity.mediaSha256 = null;
		identity.timeMapHash = null;
		identity.bindingHash = null;
		delete identity.bindingSnapshot;
		if (current) identity.speechSelectionPolicyVersion = "asr-boundary-v1";
		delete f.task.parameters.input.parameters.transcriptionTaskId;
		f.rows.splice(f.rows.indexOf(f.dependency), 1);
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(f.task.parameters.input, identity);
		await createLibraryMediaTaskSweep({
			prisma: f.prisma,
			browserFor,
			now: () => f.now,
		})();
		if (current)
			expect(f.task).toMatchObject({
				state: "PENDING",
				phase: "WAITING_FOR_MEDIA",
				attempts: 0,
			});
		else
			expect(f.task).toMatchObject({
				state: "ERROR",
				phase: "FAILED",
				error: "SPEECH_SELECTION_POLICY_CHANGED",
				finishedAt: f.now,
				leaseToken: null,
				leaseUntil: null,
			});
		expect(browserFor).not.toHaveBeenCalled();
	});
	it("rejects an old AUTO before source download or progress side effects", async () => {
		const f = unfinished(),
			browserFor = vi.fn(),
			onProgress = vi.fn();
		await expect(
			executeMediaTask({
				task: f.task as unknown as LibraryMediaTask,
				verified: {
					envelope: f.task.parameters,
				} as unknown as VerifiedMediaTask,
				dependencies: { prisma: {} as AppPrismaClient, browserFor },
				signal: new AbortController().signal,
				timeoutMs: 1000,
				onProgress,
			}),
		).rejects.toMatchObject({ code: "SPEECH_SELECTION_POLICY_CHANGED" });
		expect(browserFor).not.toHaveBeenCalled();
		expect(onProgress).not.toHaveBeenCalled();
	});
	it("also rejects an old direct generation callback before publication", async () => {
		const f = generationDependencyFixture("TRANSCRIBE");
		delete f.task.parameters.identity.speechSelectionPolicyVersion;
		await expect(f.run()).rejects.toMatchObject({
			code: "SPEECH_SELECTION_POLICY_CHANGED",
		});
		expect(f.projects).toHaveLength(0);
		expect(f.runs).toHaveLength(0);
	});
	it.each([
		"PENDING",
		"RUNNING",
	] as const)("commits terminal ERROR for old %s under the existing claim fence", async (state) => {
		const f = unfinished(state),
			previous = structuredClone(f.dependency);
		const browserFor = vi.fn(() => {
			throw new Error("source must remain untouched");
		});
		await createLibraryMediaTaskSweep({
			prisma: f.prisma,
			browserFor,
			now: () => f.now,
		})();
		expect(f.task).toMatchObject({
			state: "ERROR",
			phase: "FAILED",
			error: "SPEECH_SELECTION_POLICY_CHANGED",
			finishedAt: f.now,
			result: null,
			leaseToken: null,
			leaseUntil: null,
		});
		expect(f.dependency).toEqual(previous);
		expect(browserFor).not.toHaveBeenCalled();
	});
	it("keeps a current AUTO and a legacy OFF outside the version failure", () => {
		const f = generationDependencyFixture("TRANSCRIBE");
		f.task.parameters.identity.speechSelectionPolicyVersion = "asr-boundary-v1";
		expect(
			speechSelectionIntentFailureCode(
				mediaTaskEnvelopeSchema.parse(f.task.parameters),
			),
		).toBeUndefined();
		f.task.parameters.input.parameters.captions = "OFF";
		delete f.task.parameters.identity.speechSelectionPolicyVersion;
		expect(
			speechSelectionIntentFailureCode(
				mediaTaskEnvelopeSchema.parse(f.task.parameters),
			),
		).toBeUndefined();
	});
	it("never rewrites a previously completed old AUTO", async () => {
		const f = unfinished(),
			browserFor = vi.fn();
		Object.assign(f.task, {
			state: "SUCCEEDED",
			phase: "COMPLETE",
			result: { preserved: true },
			finishedAt: f.now,
			leaseToken: null,
			leaseUntil: null,
		});
		const before = structuredClone(f.task);
		await createLibraryMediaTaskSweep({
			prisma: f.prisma,
			browserFor,
			now: () => f.now,
		})();
		expect(f.task).toEqual(before);
		expect(browserFor).not.toHaveBeenCalled();
	});
	it("gives a current AUTO a different cache identity while leaving request intent stable", () => {
		const f = generationDependencyFixture("TRANSCRIBE"),
			input = f.task.parameters.input;
		const legacyIdentity = { ...f.task.parameters.identity };
		delete legacyIdentity.speechSelectionPolicyVersion;
		const originalIntent = mediaTaskIntentHash(input),
			originalCache = mediaTaskCacheKey(input, legacyIdentity);
		const identity = {
			...f.task.parameters.identity,
			speechSelectionPolicyVersion: "asr-boundary-v1" as const,
		};
		expect(mediaTaskIntentHash(input)).toBe(originalIntent);
		expect(mediaTaskCacheKey(input, identity)).not.toBe(originalCache);
	});
});
