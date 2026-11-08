import { randomUUID } from "node:crypto";
import { hashEditingEvidence } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { AppTransactionClient } from "./client";
import {
	getPreparedNormalizationReceipt,
	LibraryNormalizationClockError,
	prepareLibraryNormalizationClockRead,
	verifyLibraryNormalizationClockRows,
} from "./library-normalization-clock";

function fixture() {
	const organizationId = randomUUID(),
		sourceId = randomUUID(),
		id = randomUUID();
	const timeMap = {
		id,
		mediaVersionId: id,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const media = {
		id,
		organizationId,
		sourceId,
		sha256: "a".repeat(64),
		width: 640,
		height: 360,
		timeMap,
	};
	const source = {
		width: 640,
		height: 360,
		codec: "h264",
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 12288 },
		frameCount: 48,
		durationUs: 2_000_000,
		videoPtsHash: "b".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED",
		audio: null,
	};
	const sourceFrameIndex = Array.from({ length: 60 }, (_, j) =>
		Math.floor((j * 24) / 30),
	);
	const proof = {
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: "c".repeat(64),
		preparedSha256: media.sha256,
		originalBytes: 100,
		preparedBytes: 120,
		source,
		output: {
			width: 640,
			height: 360,
			frameCount: 60,
			durationUs: 2_000_000,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		sourceFrameIndex,
		indexMapHash: hashEditingEvidence(sourceFrameIndex),
		recipeHash: hashEditingEvidence({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter:
				"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=60,setpts=N/(30*TB),setsar=1/1",
			audioFilter: null,
		}),
		organizationId,
		sourceId,
		mediaVersionId: id,
		timeMapId: id,
	};
	const row = {
		id: randomUUID(),
		organizationId,
		sourceId,
		mediaVersionId: id,
		analysisRevisionId: null,
		kind: "NORMALIZATION_CAPTURE",
		proof,
		proofHash: hashEditingEvidence(proof),
	};
	const findMany = vi.fn(async () => [row]);
	const prisma = {
		libraryEvidenceReceipt: { findMany },
	} as unknown as AppTransactionClient;
	return { organizationId, media, proof, row, findMany, prisma };
}

describe("prepared normalization clock database witness", () => {
	it("keeps an older READY material without a receipt on the conservative clock", async () => {
		const f = fixture();
		f.findMany.mockResolvedValue([]);
		await expect(getPreparedNormalizationReceipt(f)).resolves.toBeUndefined();
		expect(f.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: f.organizationId,
				mediaVersionId: f.media.id,
				kind: "NORMALIZATION_CAPTURE",
			},
			take: 2,
		});
	});
	it("returns the verified immutable tuple, clock and proof hash", async () => {
		const f = fixture();
		await expect(getPreparedNormalizationReceipt(f)).resolves.toEqual({
			proof: f.proof,
			proofHash: f.row.proofHash,
		});
	});
	it("rejects multiple witnesses rather than silently choosing a clock", async () => {
		const f = fixture();
		f.findMany.mockResolvedValue([f.row, { ...f.row, id: randomUUID() }]);
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
	});
	it.each([
		"organizationId",
		"sourceId",
		"mediaVersionId",
		"kind",
		"analysisRevisionId",
	] as const)("rejects a present receipt with a mismatched %s", async (field) => {
		const f = fixture();
		Object.assign(f.row, {
			[field]: field === "kind" ? "EDITOR_ATTESTATION" : randomUUID(),
		});
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
	});
	it("rejects a foreign material before reading its receipts", async () => {
		const f = fixture();
		f.media.organizationId = randomUUID();
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("rejects altered proof bytes even when the stored prepared hash still matches", async () => {
		const f = fixture();
		f.proof.sourceFrameIndex[1] = 7;
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
	});
	it("rejects a self-consistent receipt for a different normalization recipe", async () => {
		const f = fixture();
		f.proof.recipeHash = "e".repeat(64);
		f.row.proofHash = hashEditingEvidence(f.proof);
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			"NORMALIZATION_EVIDENCE_UNVERIFIED",
		);
	});
});

describe("normalization row validation shared by single and batched reads", () => {
	it("verifies collected rows without IO and keeps the original return shape", () => {
		const f = fixture();
		const prepared = prepareLibraryNormalizationClockRead(f);
		const result = verifyLibraryNormalizationClockRows(prepared, [f.row]);
		expect(result).toEqual({ proof: f.proof, proofHash: f.row.proofHash });
		expect(Object.keys(result ?? {}).sort()).toEqual(["proof", "proofHash"]);
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("keeps queried absence distinct from malformed collected evidence", () => {
		const f = fixture();
		const prepared = prepareLibraryNormalizationClockRead(f);
		expect(verifyLibraryNormalizationClockRows(prepared, [])).toBeUndefined();
		expect(() =>
			verifyLibraryNormalizationClockRows(prepared, [f.row, f.row]),
		).toThrow(LibraryNormalizationClockError);
		f.proof.sourceFrameIndex[1] = 7;
		expect(() =>
			verifyLibraryNormalizationClockRows(prepared, [f.row]),
		).toThrow(LibraryNormalizationClockError);
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("rejects foreign media before collected rows can be used", () => {
		const f = fixture();
		f.media.organizationId = randomUUID();
		expect(() => prepareLibraryNormalizationClockRead(f)).toThrow(
			LibraryNormalizationClockError,
		);
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("does not replace a driver error with an evidence error", async () => {
		const f = fixture();
		const driverError = new Error("fixture driver failure");
		f.findMany.mockRejectedValueOnce(driverError);
		await expect(getPreparedNormalizationReceipt(f)).rejects.toBe(driverError);
	});
	it("captures the original media and organization before the SELECT await", async () => {
		const f = fixture();
		const originalMedia = f.media;
		f.findMany.mockImplementationOnce(async () => {
			f.media = { ...originalMedia, id: randomUUID() };
			f.organizationId = randomUUID();
			return [f.row];
		});
		await expect(getPreparedNormalizationReceipt(f)).resolves.toEqual({
			proof: f.proof,
			proofHash: f.row.proofHash,
		});
		expect(f.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: originalMedia.organizationId,
				mediaVersionId: originalMedia.id,
				kind: "NORMALIZATION_CAPTURE",
			},
			take: 2,
		});
	});
	it("retains the live captured media reference after the await", async () => {
		const f = fixture();
		f.findMany.mockImplementationOnce(async () => {
			f.media.id = randomUUID();
			return [f.row];
		});
		await expect(getPreparedNormalizationReceipt(f)).rejects.toThrow(
			LibraryNormalizationClockError,
		);
	});
	it("does not move the original pre-SELECT organization check after the await", async () => {
		const f = fixture();
		f.findMany.mockImplementationOnce(async () => {
			f.media.organizationId = randomUUID();
			return [f.row];
		});
		await expect(getPreparedNormalizationReceipt(f)).resolves.toEqual({
			proof: f.proof,
			proofHash: f.row.proofHash,
		});
	});
	it("uses the same original reference and full proof in the collected-row path", () => {
		const f = fixture();
		const originalMedia = f.media;
		const prepared = prepareLibraryNormalizationClockRead(f);
		f.media = { ...originalMedia, id: randomUUID() };
		f.organizationId = randomUUID();
		expect(verifyLibraryNormalizationClockRows(prepared, [f.row])).toEqual({
			proof: f.proof,
			proofHash: f.row.proofHash,
		});
		originalMedia.width = 1280;
		expect(() =>
			verifyLibraryNormalizationClockRows(prepared, [f.row]),
		).toThrow(LibraryNormalizationClockError);
	});
});
