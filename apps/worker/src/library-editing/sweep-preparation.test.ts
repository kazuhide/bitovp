import { hashEditingEvidence } from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	download: vi.fn(),
	normalize: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("./media", () => ({
	downloadPinnedEditingMedia: mocks.download,
	probeEditingMedia: vi.fn(),
}));
vi.mock("./normalization", () => ({ normalizeEditingMedia: mocks.normalize }));
vi.mock("../library/captured-bindings", () => ({
	reconcileCapturedBindings: mocks.reconcile,
}));

import { createLibraryEditingSweep } from "./sweep";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => vi.resetAllMocks());
function setup() {
	const now = new Date("2026-11-02T00:00:00Z");
	const original = "1".repeat(64),
		prepared = "2".repeat(64);
	const media: Record<string, unknown> = {
		id: id(1),
		sourceId: id(2),
		organizationId: id(3),
		state: "PENDING",
		attempts: 0,
		availableAt: now,
		leaseToken: null,
		leaseUntil: null,
		storage: {
			source: {
				credentialId: id(4),
				bucket: "b",
				key: "original.mp4",
				size: 20,
				expect: { etag: "original" },
			},
			output: { credentialId: id(4), bucket: "b", prefix: "out" },
		},
	};
	const facts = {
		width: 320,
		height: 180,
		frameCount: 60,
		durationUs: 2_000_000,
		fps: { num: 30, den: 1 },
		hasAudio: false,
		probe: { indexed: true },
	};
	const normalization = {
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: original,
		preparedSha256: prepared,
		originalBytes: 20,
		preparedBytes: 30,
		source: {
			width: 320,
			height: 180,
			codec: "h264",
			fps: { num: 24, den: 1 },
			timeBase: { num: 1, den: 24000 },
			frameCount: 48,
			durationUs: 2_000_000,
			videoPtsHash: original,
			colorProfile: "BT709_8BIT_LIMITED",
			audio: null,
		},
		output: {
			width: 320,
			height: 180,
			frameCount: 60,
			durationUs: 2_000_000,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		sourceFrameIndex: Array.from({ length: 60 }, (_, frame) =>
			Math.floor((frame * 24) / 30),
		),
		indexMapHash: hashEditingEvidence(
			Array.from({ length: 60 }, (_, frame) => Math.floor((frame * 24) / 30)),
		),
		recipeHash: original,
	};
	const receipts: Record<string, unknown>[] = [];
	const tx = {
		libraryMediaVersion: {
			updateMany: vi.fn(async ({ where, data }) => {
				if (!matchesWhere(media, where)) return { count: 0 };
				for (const [key, value] of Object.entries(data))
					media[key] =
						value && typeof value === "object" && "increment" in value
							? Number(media[key]) + Number(value.increment)
							: value;
				return { count: 1 };
			}),
		},
		libraryEvidenceReceipt: {
			findMany: vi.fn(async ({ where, select }) =>
				select
					? media.state === "READY"
						? receipts
						: []
					: receipts.filter((row) => matchesWhere(row, where)),
			),
			create: vi.fn(async ({ data }) => {
				const row = { id: id(50), ...data };
				receipts.push(row);
				return row;
			}),
		},
	};
	const db = {
		...tx,
		libraryMediaVersion: {
			...tx.libraryMediaVersion,
			findMany: vi.fn(async ({ where }) =>
				matchesWhere(media, where) ? [media] : [],
			),
		},
		renderRun: {
			findMany: vi.fn().mockResolvedValue([]),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
			const before = structuredClone(media);
			const beforeReceipts = [...receipts];
			try {
				return await callback(tx);
			} catch (error) {
				for (const key of Object.keys(media)) delete media[key];
				Object.assign(media, before);
				receipts.splice(0, receipts.length, ...beforeReceipts);
				throw error;
			}
		}),
	};
	const browser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		putObject: vi.fn(async (_input: { filePath: string }) => {}),
		headObject: vi.fn().mockResolvedValue({ size: 30, etag: "prepared" }),
		dispose: vi.fn(),
	};
	mocks.download.mockResolvedValue({
		sha256: original,
		bytes: 20,
		identity: { size: 20, etag: "original" },
	});
	mocks.normalize.mockImplementation(async ({ destinationPath }) => ({
		path: destinationPath,
		facts,
		originalSha256: original,
		preparedSha256: prepared,
		bytes: 30,
		normalization,
	}));
	mocks.reconcile.mockImplementation(async () => {
		expect(media.state).toBe("READY");
		expect(receipts).toHaveLength(1);
		return { created: 1, preserved: 0 };
	});
	const tick = createLibraryEditingSweep({
		prisma: db as unknown as AppPrismaClient,
		browserFor: async () => browser,
		now: () => now,
	});
	return { media, receipts, db, tx, browser, tick, original, prepared };
}
describe("normalized preparation sweep wiring", () => {
	it("uploads normalized bytes and binds original/prepared hashes after atomic READY", async () => {
		const f = setup();
		await f.tick();
		expect(f.media).toMatchObject({ state: "READY", sha256: f.prepared });
		expect(mocks.normalize.mock.calls[0]?.[0]).toMatchObject({
			expectedSourceSha256: f.original,
		});
		expect(f.browser.putObject.mock.calls[0]?.[0]).toMatchObject({
			filePath: expect.stringMatching(/normalized\.mp4$/),
		});
		expect(f.receipts[0]).toMatchObject({
			kind: "NORMALIZATION_CAPTURE",
			proof: {
				originalSha256: f.original,
				preparedSha256: f.prepared,
				organizationId: id(3),
				sourceId: id(2),
				mediaVersionId: id(1),
			},
		});
		expect(mocks.reconcile).toHaveBeenCalled();
	});
	it("cannot attach a receipt when the lease changes after normalized upload", async () => {
		const f = setup();
		f.browser.putObject.mockImplementationOnce(async () => {
			f.media.leaseToken = id(99);
		});
		await f.tick();
		expect(f.media).toMatchObject({ state: "RUNNING", leaseToken: id(99) });
		expect(f.receipts).toEqual([]);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
	it("rolls back READY when immutable receipt persistence fails", async () => {
		const f = setup();
		f.tx.libraryEvidenceReceipt.create.mockRejectedValueOnce(
			new Error("receipt rejected"),
		);
		await f.tick();
		expect(f.media).toMatchObject({
			state: "ERROR",
			error: "MEDIA_PREPARATION_FAILED",
		});
		expect(f.receipts).toEqual([]);
		expect(mocks.reconcile).not.toHaveBeenCalled();
	});
});
