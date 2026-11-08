import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	normalizationCaptureReceiptSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { authoredNormalizationReceipt } from "@bitovp/core/testing";
import type { AppTransactionClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";

const sharedCuts = [0, 0.041667, 0.083333, 0.125, 0.166667, 6];
function fixture(
	options: {
		policy?: "DURATION" | "COHESION" | "AUTO";
		captions?: "OFF" | "AUTO";
		cuts?: readonly number[];
		targetFrames?: number;
	} = {},
) {
	const f = generationDependencyFixture("TRANSCRIBE");
	const raw = {
		metadata: { version: "authored-CFR24-prepared-clock-regression" },
		duration: 6,
		scenes: [
			{
				id: f.sceneIds[0],
				type: "MAIN_CONTENT",
				title: "Shared source cuts",
				startInSeconds: 0,
				endInSeconds: 6,
				shots: (options.cuts ?? sharedCuts).slice(0, -1).map((from, index) => ({
					startInSeconds: from,
					endInSeconds: (options.cuts ?? sharedCuts)[index + 1],
					mainSubjects: [
						{
							classification: "Person",
							description: "Authored test subject",
							appearanceTimeInSeconds: 0,
							centerX: 50,
							centerY: 50,
							box2d: [300, 450, 700, 550],
						},
					],
				})),
			},
		],
	};
	f.analysis.document = normalizeSceneAnalysis(raw);
	f.analysis.rawHash = hashEditingEvidence(raw);
	Object.assign(f.binding, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(f.analysis.document),
	});
	Object.assign(f.task.parameters.input.parameters, {
		policy: options.policy ?? "DURATION",
		...(options.policy === "AUTO" ? { renderMode: "DRAFT" } : {}),
		captions: options.captions ?? "OFF",
		targetDurationFrames: options.targetFrames ?? 180,
	});
	if (options.captions !== "AUTO")
		delete f.task.parameters.input.parameters.transcriptionTaskId;
	const proof = authoredNormalizationReceipt({
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		sourceFrameCount: 144,
		width: f.media.width,
		height: f.media.height,
		preparedSha256: f.media.sha256,
		hasAudio: true,
	});
	const row = {
		id: randomUUID(),
		organizationId: f.task.organizationId,
		sourceId: f.media.sourceId,
		mediaVersionId: f.media.id,
		analysisRevisionId: null,
		kind: "NORMALIZATION_CAPTURE",
		proof,
		proofHash: hashEditingEvidence(proof),
	};
	const rows = [row],
		findMany = vi.fn(async () => rows);
	const transaction = f.prisma.$transaction.bind(f.prisma);
	Object.assign(f.prisma, {
		libraryEvidenceReceipt: { findMany },
		$transaction: async <T>(
			callback: (tx: AppTransactionClient) => Promise<T>,
		) =>
			transaction(async (tx) => {
				Object.assign(tx, { libraryEvidenceReceipt: { findMany } });
				return callback(tx);
			}),
	});
	Object.assign(f.task.parameters.identity, {
		analysisRawHash: f.analysis.rawHash,
		analysisDocumentHash: f.binding.analysisDocumentHash,
		bindingHash: hashEditingEvidence(f.binding),
		bindingSnapshot: f.binding,
		preparedShotClock: {
			version: "aisa-prepared-clock-v3",
			normalizationReceiptHash: row.proofHash,
		},
	});
	const refreshCurrent = () => {
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
	};
	refreshCurrent();
	return {
		...f,
		proof,
		row,
		normalizationRows: rows,
		findMany,
		refreshCurrent,
	};
}
function draft(f: ReturnType<typeof fixture>) {
	return compositionDocumentSchema.parse(f.projects[0]?.draft);
}
function expectNoPublication(f: ReturnType<typeof fixture>) {
	expect(f.projects).toHaveLength(0);
	expect(f.revisions).toHaveLength(0);
	expect(f.runs).toHaveLength(0);
	expect(f.task.state).not.toBe("SUCCEEDED");
}

describe("generation uses its immutable prepared CFR24-to-CFR30 clock", () => {
	it("publishes AUTO as a reviewable draft with evidence for the exact prepared source partition", async () => {
		const f = fixture({ policy: "AUTO" }),
			result = await f.run(),
			document = draft(f);
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			policyVersion: "aisa-prepared-content-highlight-v4",
			actualFrames: 180,
			semanticEvidence: {
				version: "aisa-content-evidence-v1",
				method: "METADATA_HEURISTIC",
			},
		});
		expect(document.autoGeneration).toMatchObject({
			renderMode: "DRAFT",
			normalizationReceiptHash: f.row.proofHash,
			semanticEvidence: result.semanticEvidence,
		});
		expect(
			document.clips.map((clip) => [clip.sourceInUs, clip.durationFrames]),
		).toEqual([
			[0, 2],
			[66_667, 1],
			[100_000, 1],
			[133_334, 1],
			[166_667, 175],
		]);
		expect(f.task.parameters.identity.preparedShotClock?.version).toBe(
			"aisa-prepared-clock-v3",
		);
		expect(f.runs).toHaveLength(0);
		expect(f.projects).toHaveLength(1);
		await expect(f.run()).resolves.toEqual(result);
	});
	it("authors bounded canonical test evidence without sharing mutable proof arrays", () => {
		const f = fixture();
		expect(normalizationCaptureReceiptSchema.parse(f.proof)).toEqual(f.proof);
		expect(f.proof.source.fps).toEqual({ num: 24, den: 1 });
		expect(f.proof.sourceFrameIndex.slice(0, 7)).toEqual([0, 0, 1, 2, 3, 4, 4]);
		expect(f.proof.output).toMatchObject({
			frameCount: 180,
			durationUs: 6_000_000,
			hasAudio: true,
		});
		const another = authoredNormalizationReceipt({
			organizationId: f.task.organizationId,
			sourceId: f.media.sourceId,
			mediaVersionId: f.media.id,
			hasAudio: true,
		});
		expect(another).toEqual(f.proof);
		another.sourceFrameIndex[0] = 1;
		expect(f.proof.sourceFrameIndex[0]).toBe(0);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("publishes every contiguous prepared frame with %s and preserves uncertain cut bands as FIT", async (policy) => {
		const f = fixture({ policy }),
			result = await f.run();
		expect(result).toMatchObject({ requestedFrames: 180, actualFrames: 180 });
		const document = draft(f);
		expect(document.autoGeneration).toMatchObject({
			normalizationReceiptHash: f.row.proofHash,
		});
		expect(
			document.clips.map((clip) => ({
				from: Math.floor((clip.sourceInUs * 30) / 1_000_000),
				duration: clip.durationFrames,
			})),
		).toEqual([
			{ from: 0, duration: 2 },
			{ from: 2, duration: 1 },
			{ from: 3, duration: 1 },
			{ from: 4, duration: 1 },
			{ from: 5, duration: 175 },
		]);
		const last = document.clips[4];
		expect(last?.framing).toEqual([
			{ fromFrame: 0, toFrame: 1, origin: "AUTO_POLICY", mode: "FIT" },
			expect.objectContaining({
				fromFrame: 1,
				toFrame: 175,
				origin: "AUTO_POLICY",
				mode: "CROP",
			}),
		]);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.revisions[0]?.document).toEqual(document);
		expect(f.runs).toHaveLength(1);
		expect(f.runs[0]).toHaveProperty("profile.kind", "EXPORT");
		expect(f.task.state).toBe("SUCCEEDED");
	});
	it("keeps the conservative legacy policy when the task identity has no prepared clock", async () => {
		const f = fixture();
		delete f.task.parameters.identity.preparedShotClock;
		f.refreshCurrent();
		const result = await f.run();
		expect(result).toMatchObject({
			actualFrames: 174,
			policyVersion: "aisa-shot-window-v1",
		});
		expect(draft(f).autoGeneration).not.toHaveProperty(
			"normalizationReceiptHash",
		);
		expect(draft(f).clips).toHaveLength(1);
		expect(draft(f).clips[0]).toMatchObject({
			sourceInUs: 200_000,
			durationFrames: 174,
		});
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it.each([
		"missing",
		"duplicate",
		"altered-proof",
		"different-recipe",
		"changed-identity-hash",
	] as const)("rejects %s normalization evidence before publishing any project or EXPORT", async (mode) => {
		const f = fixture();
		if (mode === "missing") f.normalizationRows.length = 0;
		if (mode === "duplicate")
			f.normalizationRows.push({ ...f.row, id: randomUUID() });
		if (mode === "altered-proof") f.proof.sourceFrameIndex[1] = 7;
		if (mode === "different-recipe") {
			f.proof.recipeHash = "e".repeat(64);
			f.row.proofHash = hashEditingEvidence(f.proof);
			if (f.task.parameters.identity.preparedShotClock)
				f.task.parameters.identity.preparedShotClock.normalizationReceiptHash =
					f.row.proofHash;
			f.refreshCurrent();
		}
		if (mode === "changed-identity-hash") {
			f.proof.originalBytes += 1;
			f.row.proofHash = hashEditingEvidence(f.proof);
		}
		await expect(f.run()).rejects.toMatchObject({
			code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
		});
		expectNoPublication(f);
	});
	it("revalidates a removed receipt after the publication fence and before project writes", async () => {
		const f = fixture();
		f.context.onProgress.mockImplementation(async (phase?: string) => {
			if (phase === "PUBLISHING") f.normalizationRows.length = 0;
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
		});
		expect(f.findMany).toHaveBeenCalledTimes(2);
		expectNoPublication(f);
	});
	it("rejects a different valid receipt hash at the publication fence", async () => {
		const f = fixture();
		f.context.onProgress.mockImplementation(async (phase?: string) => {
			if (phase === "PUBLISHING") {
				f.proof.originalBytes += 1;
				f.row.proofHash = hashEditingEvidence(f.proof);
			}
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "NORMALIZATION_EVIDENCE_UNVERIFIED",
		});
		expectNoPublication(f);
	});
	it.each([
		"DURATION",
		"COHESION",
	] as const)("carries the same partition into AUTO %s reselection across a continuous internal speech boundary", async (policy) => {
		const f = fixture({
			policy,
			captions: "AUTO",
			cuts: [0, 1.041667, 3.041667, 4.041667, 6],
			targetFrames: 120,
		});
		f.dependency.result.segments = [
			{ startUs: 0, endUs: 500_000, text: "outside" },
			{
				startUs: 1_500_000,
				endUs: 2_000_000,
				text: "inside first selected shot",
				words: [
					{
						text: "inside",
						startUs: 1_500_000,
						endUs: 1_600_000,
						startChar: 0,
						endChar: 6,
						confidence: 0.9,
					},
					{
						text: "first",
						startUs: 1_600_000,
						endUs: 1_700_000,
						startChar: 7,
						endChar: 12,
						confidence: 0.9,
					},
					{
						text: "selected",
						startUs: 1_700_000,
						endUs: 1_850_000,
						startChar: 13,
						endChar: 21,
						confidence: 0.9,
					},
					{
						text: "shot",
						startUs: 1_850_000,
						endUs: 2_000_000,
						startChar: 22,
						endChar: 26,
						confidence: 0.9,
					},
				],
			},
			{
				startUs: 3_000_000,
				endUs: 3_500_000,
				text: "across the continuous source cut",
				words: [
					{
						text: "across",
						startUs: 3_000_000,
						endUs: 3_100_000,
						startChar: 0,
						endChar: 6,
						confidence: 0.9,
					},
					{
						text: "the",
						startUs: 3_100_000,
						endUs: 3_150_000,
						startChar: 7,
						endChar: 10,
						confidence: 0.9,
					},
					{
						text: "continuous",
						startUs: 3_150_000,
						endUs: 3_300_000,
						startChar: 11,
						endChar: 21,
						confidence: 0.9,
					},
					{
						text: "source",
						startUs: 3_300_000,
						endUs: 3_400_000,
						startChar: 22,
						endChar: 28,
						confidence: 0.9,
					},
					{
						text: "cut",
						startUs: 3_400_000,
						endUs: 3_500_000,
						startChar: 29,
						endChar: 32,
						confidence: 0.9,
					},
				],
			},
		];
		const result = await f.run(),
			document = draft(f);
		expect(result).toMatchObject({
			actualFrames: 90,
			selectionEvidence: { status: "APPLIED" },
		});
		expect(
			document.clips.map((clip) => ({
				sourceInUs: clip.sourceInUs,
				durationFrames: clip.durationFrames,
			})),
		).toEqual([
			{ sourceInUs: 1_066_667, durationFrames: 60 },
			{ sourceInUs: 3_066_667, durationFrames: 30 },
		]);
		expect(document.captions?.map((caption) => caption.text)).toContain(
			"inside first selected shot",
		);
		expect(
			document.captions?.some((caption) =>
				caption.text.includes("across the continuous"),
			),
		).toBe(true);
		expect(result.selectionEvidence?.rejectedBoundaryCount).toBeGreaterThan(0);
		expect(result.metrics.speechSearchExpansions).toBeLessThanOrEqual(200_000);
		expect(document.autoGeneration?.normalizationReceiptHash).toBe(
			f.row.proofHash,
		);
	});
	it("replays an already completed legacy result without rewriting it to the prepared policy", async () => {
		const f = fixture();
		delete f.task.parameters.identity.preparedShotClock;
		f.refreshCurrent();
		const first = await f.run(),
			saved = JSON.stringify(f.task.result);
		f.normalizationRows.length = 0;
		await expect(f.run()).resolves.toEqual(first);
		expect(JSON.stringify(f.task.result)).toBe(saved);
		expect(f.projects).toHaveLength(1);
		expect(f.runs).toHaveLength(1);
	});
});
