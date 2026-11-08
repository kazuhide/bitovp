import { setTimeout as delay } from "node:timers/promises";
import { hashEditingEvidence } from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ normalize: vi.fn(), hls: vi.fn() }));
vi.mock("./hls-source", () => ({
	HLS_PREPARATION_LIMITS: { timeoutMs: 30 },
	prepareHlsEditingSource: mocks.hls,
}));
vi.mock("./normalization", () => ({ normalizeEditingMedia: mocks.normalize }));

import { createLibraryEditingSweep } from "./sweep";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
it("bounds a stalled HLS output upload and never publishes READY after its total deadline", async () => {
	const now = new Date(),
		media: Record<string, unknown> = {
			id: id(1),
			organizationId: id(2),
			sourceId: id(3),
			state: "PENDING",
			availableAt: now,
			attempts: 0,
			leaseToken: null,
			leaseUntil: null,
			storage: {
				source: {
					credentialId: id(4),
					bucket: "b",
					key: "out/master.m3u8",
					size: 10,
					expect: { etag: '"root"' },
				},
				output: { credentialId: id(4), bucket: "b", prefix: "prepared" },
				sourceFormat: "HLS",
				hlsRootPrefix: "out",
			},
		};
	const updateMany = vi.fn(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (!matchesWhere(media, where)) return { count: 0 };
			for (const [k, v] of Object.entries(data))
				media[k] =
					v && typeof v === "object" && "increment" in v
						? Number(media[k]) + Number(v.increment)
						: v;
			return { count: 1 };
		},
	);
	const receiptCreate = vi.fn(),
		prisma = {
			libraryMediaVersion: {
				updateMany,
				findMany: async ({ where }: { where: Record<string, unknown> }) =>
					matchesWhere(media, where) ? [media] : [],
			},
			renderRun: {
				findMany: async () => [],
				updateMany: async () => ({ count: 0 }),
			},
			libraryEvidenceReceipt: {
				findMany: async () => [],
				create: receiptCreate,
			},
			$transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
		};
	let release: () => void = () => {};
	const upload = new Promise<void>((resolve) => {
		release = resolve;
	});
	const expiration = new AbortController();
	const timeout = vi
		.spyOn(AbortSignal, "timeout")
		.mockReturnValue(expiration.signal);
	let entered: () => void = () => {};
	const uploadEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const browser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		headObject: async () => ({ size: 30, etag: '"prepared"' }),
		putObject: vi.fn(() => {
			entered();
			return upload;
		}),
		dispose: vi.fn(),
	};
	const facts = {
		width: 2,
		height: 2,
		frameCount: 1,
		durationUs: 33334,
		fps: { num: 30, den: 1 },
		hasAudio: false,
		probe: { indexed: true },
	};
	const normalization = {
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: "1".repeat(64),
		preparedSha256: "2".repeat(64),
		originalBytes: 20,
		preparedBytes: 30,
		source: {
			width: 2,
			height: 2,
			codec: "hevc",
			fps: { num: 30, den: 1 },
			timeBase: { num: 1, den: 30000 },
			frameCount: 1,
			durationUs: 33334,
			videoPtsHash: "1".repeat(64),
			colorProfile: "BT709_8BIT_LIMITED",
			audio: null,
		},
		output: {
			width: 2,
			height: 2,
			frameCount: 1,
			durationUs: 33334,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: 33334,
		sourceFrameIndex: [0],
		indexMapHash: hashEditingEvidence([0]),
		recipeHash: "1".repeat(64),
	};
	mocks.hls.mockResolvedValue({
		sha256: "1".repeat(64),
		witness: { version: "unit-stub-not-native-evidence" },
	});
	mocks.normalize.mockImplementation(async ({ destinationPath }) => ({
		path: destinationPath,
		bytes: 30,
		facts,
		normalization,
	}));
	const tick = createLibraryEditingSweep({
		canClaim: async () => true,
		prisma: prisma as unknown as AppPrismaClient,
		browserFor: async () => browser,
		now: () => now,
	})();
	try {
		await uploadEntered;
		expiration.abort(
			new DOMException("Measured total deadline", "TimeoutError"),
		);
		const result = await Promise.race([
			tick.then(() => "FINISHED"),
			delay(150).then(() => "STILL_PENDING"),
		]);
		expect(result).toBe("FINISHED");
		expect(browser.putObject).toHaveBeenCalledTimes(1);
		expect(media).toMatchObject({ state: "ERROR", error: "TIMED_OUT" });
		expect(receiptCreate).not.toHaveBeenCalled();
		expect(browser.dispose).toHaveBeenCalledTimes(1);
	} finally {
		release();
		await tick;
		timeout.mockRestore();
	}
	expect(media.state).toBe("ERROR");
});
