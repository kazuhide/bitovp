import { randomUUID } from "node:crypto";
import {
	GENERATION_POLICY_FINGERPRINT,
	mediaTaskCreateSchema,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createLibraryGenerationHandler } from "./generation";
import {
	executeMediaTask,
	type VerifiedMediaTask,
} from "./media-task-execution";

function envelope(kind: "TRACK" | "GENERATE") {
	return {
		schemaVersion: 1,
		input: mediaTaskCreateSchema.parse({
			kind,
			mediaVersionId: randomUUID(),
			analysisRevisionId: randomUUID(),
			requestKey: randomUUID(),
			parameters:
				kind === "TRACK"
					? {}
					: {
							contentId: randomUUID(),
							targetDurationFrames: 31,
							tracking: true,
						},
		}),
		identity: {
			organizationId: randomUUID(),
			...(kind === "GENERATE"
				? { generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT }
				: {}),
			mediaSha256: "a".repeat(64),
			modelSha256: null,
			analysisDocumentHash: "b".repeat(64),
			analysisRawHash: "c".repeat(64),
			timeMapHash: "d".repeat(64),
			trackingAlgorithmVersion: "template-ncc-v2",
		},
	};
}
describe("unfinished old frame-clock work cannot be relabeled as corrected tracking", () => {
	it.each([
		"TRACK",
		"GENERATE",
	] as const)("rejects stale %s before source or analysis work", async (kind) => {
		const browserFor = vi.fn(),
			onProgress = vi.fn();
		await expect(
			executeMediaTask({
				task: {} as LibraryMediaTask,
				verified: { envelope: envelope(kind) } as unknown as VerifiedMediaTask,
				dependencies: { prisma: {} as AppPrismaClient, browserFor },
				signal: new AbortController().signal,
				timeoutMs: 1000,
				onProgress,
			}),
		).rejects.toMatchObject({ code: "TRACKING_FRAME_CLOCK_CHANGED" });
		expect(browserFor).not.toHaveBeenCalled();
		expect(onProgress).not.toHaveBeenCalled();
	});
	it("guards the direct generation callback as well as its sweep entry point", async () => {
		const stored = envelope("GENERATE"),
			taskId = randomUUID(),
			leaseToken = randomUUID();
		const task = {
			id: taskId,
			organizationId: stored.identity.organizationId,
			kind: "GENERATE",
			state: "RUNNING",
			mediaVersionId: stored.input.mediaVersionId,
			analysisRevisionId:
				stored.input.kind === "GENERATE"
					? stored.input.analysisRevisionId
					: null,
			parameters: stored,
			cancelRequestedAt: null,
			leaseToken,
			leaseUntil: new Date(Date.now() + 60_000),
		};
		const prisma = {
			libraryMediaTask: { findUnique: vi.fn(async () => task) },
			$transaction: vi.fn(),
		};
		if (stored.input.kind !== "GENERATE")
			throw new Error("Missing generation fixture");
		await expect(
			createLibraryGenerationHandler({
				prisma: prisma as unknown as AppPrismaClient,
			})({
				taskId,
				organizationId: task.organizationId,
				leaseToken,
				mediaVersionId: task.mediaVersionId,
				analysisRevisionId: task.analysisRevisionId ?? "",
				parameters: stored.input.parameters,
				sourcePath: "/unused/source.mp4",
				media: {} as never,
				createdBy: null,
				signal: new AbortController().signal,
				onProgress: vi.fn(),
			}),
		).rejects.toMatchObject({ code: "TRACKING_FRAME_CLOCK_CHANGED" });
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
});
