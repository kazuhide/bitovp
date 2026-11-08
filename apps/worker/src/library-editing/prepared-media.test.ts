import { hashEditingEvidence } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { persistPreparedMedia } from "./prepared-media";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function setup() {
	const facts = {
		width: 320,
		height: 180,
		frameCount: 60,
		durationUs: 2_000_000,
		fps: { num: 30 as const, den: 1 as const },
		hasAudio: true,
		probe: { supported: true },
	};
	const normalization = {
		schemaVersion: 1 as const,
		profile: "SDR_CFR30_INDEXED_V1" as const,
		mode: "NORMALIZE" as const,
		originalSha256: "1".repeat(64),
		preparedSha256: "2".repeat(64),
		originalBytes: 20,
		preparedBytes: 30,
		source: {
			width: 320,
			height: 180,
			codec: "h264" as const,
			fps: { num: 24, den: 1 },
			timeBase: { num: 1, den: 24000 },
			frameCount: 48,
			durationUs: 2_000_000,
			videoPtsHash: "3".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED" as const,
			audio: {
				sampleRate: 48000 as const,
				channels: 2 as const,
				sampleCount: 96000,
				ptsHash: "4".repeat(64),
			},
		},
		output: {
			width: 320,
			height: 180,
			frameCount: 60,
			durationUs: 2_000_000,
			fps: { num: 30 as const, den: 1 as const },
			hasAudio: true,
		},
		sourceStartUs: 0 as const,
		sourceEndUs: 2_000_000,
		sourceFrameIndex: Array.from({ length: 60 }, (_, frame) =>
			Math.floor((frame * 24) / 30),
		),
		indexMapHash: "5".repeat(64),
		recipeHash: "6".repeat(64),
	};
	const update = vi.fn().mockResolvedValue({ count: 1 });
	const findMany = vi.fn().mockResolvedValue([]);
	const create = vi.fn(async ({ data }) => ({ ...data, id: id(7) }));
	const tx = {
		libraryMediaVersion: { updateMany: update },
		libraryEvidenceReceipt: { findMany, create },
	};
	const db = { $transaction: vi.fn(async (callback) => callback(tx)) };
	const input = {
		prisma: db as unknown as AppPrismaClient,
		mediaVersionId: id(1),
		sourceId: id(2),
		organizationId: id(3),
		leaseToken: id(4),
		now: () => new Date("2026-11-02T00:00:00Z"),
		storage: {
			source: { credentialId: id(5), bucket: "b", key: "original.mp4" },
			output: { credentialId: id(5), bucket: "b", prefix: "out" },
		},
		prepared: {
			credentialId: id(5),
			bucket: "b",
			key: "prepared.mp4",
			size: 30,
			expect: { etag: "prepared" },
		},
		facts,
		normalization,
	};
	return { input, tx, db, update, create, findMany };
}
describe("atomic normalized READY evidence", () => {
	it("stores prepared SHA and immutable original receipt in the same fenced transaction", async () => {
		const f = setup();
		await persistPreparedMedia(f.input);
		expect(f.db.$transaction).toHaveBeenCalledOnce();
		expect(f.update.mock.calls[0]?.[0]).toMatchObject({
			where: {
				id: id(1),
				state: "RUNNING",
				leaseToken: id(4),
				leaseUntil: { gt: f.input.now() },
			},
			data: {
				state: "READY",
				sha256: "2".repeat(64),
				timeMap: {
					mediaVersionId: id(1),
					sourceEndUs: 2_000_000,
					editingEndFrame: 60,
				},
			},
		});
		const data = f.create.mock.calls[0]?.[0].data;
		expect(data).toMatchObject({
			kind: "NORMALIZATION_CAPTURE",
			organizationId: id(3),
			sourceId: id(2),
			mediaVersionId: id(1),
			proof: {
				originalSha256: "1".repeat(64),
				preparedSha256: "2".repeat(64),
				timeMapId: id(1),
			},
		});
		expect(data.proofHash).toBe(hashEditingEvidence(data.proof));
	});
	it("does not publish evidence after losing the preparation lease", async () => {
		const f = setup();
		f.update.mockResolvedValue({ count: 0 });
		await expect(persistPreparedMedia(f.input)).rejects.toThrow("LEASE_LOST");
		expect(f.create).not.toHaveBeenCalled();
	});
	it("reuses exact existing proof and rejects changed proof instead of overwriting it", async () => {
		const f = setup();
		await persistPreparedMedia(f.input);
		const data = f.create.mock.calls[0]?.[0].data;
		f.create.mockClear();
		f.findMany.mockResolvedValue([data]);
		await persistPreparedMedia(f.input);
		expect(f.create).not.toHaveBeenCalled();
		f.findMany.mockResolvedValue([{ ...data, proofHash: "f".repeat(64) }]);
		await expect(persistPreparedMedia(f.input)).rejects.toThrow(
			"SOURCE_UNVERIFIED",
		);
		expect(f.create).not.toHaveBeenCalled();
	});
	it("preserves exact CFR30 identity bytes and rejects inconsistent prepared/object facts", async () => {
		const f = setup();
		const n = f.input.normalization;
		Reflect.set(n, "mode", "IDENTITY_COPY");
		n.source.fps = { num: 30, den: 1 };
		n.source.frameCount = 60;
		n.sourceFrameIndex = Array.from({ length: 60 }, (_, frame) => frame);
		n.originalSha256 = n.preparedSha256;
		n.originalBytes = n.preparedBytes;
		await persistPreparedMedia(f.input);
		expect(f.update.mock.calls[0]?.[0].data.sha256).toBe(n.originalSha256);
		f.input.prepared.size = 31;
		await expect(persistPreparedMedia(f.input)).rejects.toThrow(
			"SOURCE_UNVERIFIED",
		);
	});
});
