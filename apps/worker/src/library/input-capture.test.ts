import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	hashEditingEvidence,
	verifyInputCaptureAuthorization,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { describe, expect, it, vi } from "vitest";
import plan from "../../../../packages/core/src/plan/__fixtures__/ai-scene-analysis-passthrough.plan.json";
import type { SdkOps } from "../orchestrator/sdk-ops";
import { createEncodingInputCapture } from "./input-capture";

const mock = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../library-editing/normalization", () => ({
	probeEditingNormalizationSource: mock.probe,
}));
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = new Date("2026-11-02T00:00:00Z");
const secret = "test-capture-key-with-at-least-thirty-two-chars";
function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("Missing test fixture");
	return value;
}
function setup() {
	const bytes = Buffer.from("versioned-input-bytes");
	const job = {
		id: id(2),
		organizationId: id(1),
		bitmovinEncodingId: id(3),
		plan: structuredClone(plan),
	};
	const receipts: Array<Record<string, unknown>> = [];
	const prisma = {
		encodingJob: { findUnique: vi.fn(async () => job) },
		libraryEvidenceReceipt: {
			findMany: vi.fn(async () => receipts),
			create: vi.fn(async ({ data }) => {
				receipts.push(data);
				return data;
			}),
		},
	};
	const browser: ObjectStorageBrowser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		headObject: vi.fn(async () => ({
			size: bytes.length,
			etag: '"fixed"',
			versionId: "immutable-version-1",
		})),
		getObject: vi.fn(async () => Readable.from([bytes])),
		dispose: vi.fn(),
	};
	const source = {
		width: 320,
		height: 180,
		codec: "h264",
		fps: { num: 30, den: 1 },
		timeBase: { num: 1, den: 90000 },
		frameCount: 30,
		durationUs: 1_000_000,
		videoPtsHash: "a".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED",
		audio: null,
	};
	mock.probe.mockResolvedValue({ source });
	const sdk = {
		createHttpsInput: vi.fn(
			async (_input: Parameters<SdkOps["createHttpsInput"]>[0]) => id(7),
		),
	};
	const operation = {
		step: "ingest:video",
		kind: "CREATE_INGEST_INPUT_STREAM" as const,
		payload: {
			inputPath: "big_buck_bunny_1080p_h264.mov",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		},
		refs: { encodingId: "encoding", inputId: "input:main" },
	};
	const input = {
		organizationId: id(1),
		jobId: id(2),
		encodingId: id(3),
		operation,
		sdk: sdk as unknown as SdkOps,
		checkpoint: vi.fn(async () => {}),
	};
	const config = { baseUrl: "https://capture.example.test", secret };
	const make = (settings: typeof config | null = config) =>
		createEncodingInputCapture({
			prisma: prisma as unknown as AppPrismaClient,
			browserFor: async () => browser,
			config: settings,
			now: () => instant,
			uuid: () => id(9),
		});
	return { bytes, job, receipts, prisma, browser, source, sdk, input, make };
}
describe("actual version-pinned encoding input capture", () => {
	it("creates immutable evidence before the provider receives its gateway input", async () => {
		const f = setup();
		f.sdk.createHttpsInput.mockImplementation(async () => {
			expect(f.receipts).toHaveLength(1);
			return id(7);
		});
		const result = await f.make()(f.input);
		expect(result).toEqual({
			inputId: id(7),
			inputPath: `/api/encoding-input-captures/${id(9)}/content`,
			inputReceiptId: id(9),
		});
		const receipt = f.receipts[0] as {
			proof: { sha256: string; expiresAt: number };
			proofHash: string;
		};
		expect(receipt.proof.sha256).toBe(
			createHash("sha256").update(f.bytes).digest("hex"),
		);
		expect(receipt.proofHash).toBe(hashEditingEvidence(receipt.proof));
		const sent = f.sdk.createHttpsInput.mock.calls[0]?.[0] as {
			username: string;
			password: string;
		};
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId: id(9),
				authorization: `Basic ${Buffer.from(`${sent.username}:${sent.password}`).toString("base64")}`,
				now: instant.getTime() / 1000,
			}),
		).toEqual({ organizationId: id(1), expiresAt: receipt.proof.expiresAt });
		expect(JSON.stringify(receipt)).not.toContain(sent.password);
		expect(JSON.stringify(result)).not.toContain(sent.password);
	});
	it("keeps ordinary encoding unchanged while capture is disabled", async () => {
		const f = setup();
		expect(await f.make(null)(f.input)).toBeNull();
		expect(f.browser.headObject).not.toHaveBeenCalled();
		expect(f.sdk.createHttpsInput).not.toHaveBeenCalled();
	});
	it("does not turn an ETag-only mutable object into provider proof", async () => {
		const f = setup();
		vi.mocked(required(f.browser.headObject)).mockResolvedValue({
			size: f.bytes.length,
			etag: '"current"',
		});
		expect(await f.make()(f.input)).toBeNull();
		expect(f.receipts).toHaveLength(0);
		expect(f.sdk.createHttpsInput).not.toHaveBeenCalled();
	});
	it("does not replace a prior captured version with today's bytes on retry", async () => {
		const f = setup();
		const capture = f.make();
		await capture(f.input);
		vi.mocked(required(f.browser.headObject)).mockClear();
		expect(await capture(f.input)).toMatchObject({ inputReceiptId: id(9) });
		expect(f.receipts).toHaveLength(1);
		expect(f.browser.headObject).not.toHaveBeenCalled();
	});
	it("never propagates provider errors that could echo Basic credentials into the step log", async () => {
		const f = setup();
		f.sdk.createHttpsInput.mockImplementation(async (params) => {
			throw new Error(
				`provider echoed username=${params.username} password=${params.password}`,
			);
		});
		await expect(f.make()(f.input)).rejects.toThrow(
			/^INPUT_CAPTURE_PROVIDER_FAILED$/,
		);
	});
	it.each([
		"tenant",
		"encoding",
		"transformed",
		"audio-selection",
		"different-operation",
	])("rejects unproven %s association without emitting a capture", async (change) => {
		const f = setup();
		if (change === "tenant") f.job.organizationId = id(99);
		if (change === "encoding") f.job.bitmovinEncodingId = id(99);
		if (change === "transformed")
			Object.assign(f.job.plan, { trimmingStreams: [{ key: "trim" }] });
		if (change === "audio-selection")
			required(f.job.plan.ingest[0]).selectionMode = "AUDIO_RELATIVE";
		if (change === "different-operation")
			f.input.operation.payload.position = 1;
		if (
			["transformed", "audio-selection", "different-operation"].includes(change)
		)
			expect(await f.make()(f.input)).toBeNull();
		else await expect(f.make()(f.input)).rejects.toThrow();
		expect(f.receipts).toHaveLength(0);
		expect(f.sdk.createHttpsInput).not.toHaveBeenCalled();
	});
	it("does not send provider mutations after its attempt lease is lost", async () => {
		const f = setup();
		f.input.checkpoint.mockRejectedValue(new Error("LEASE_LOST"));
		await expect(f.make()(f.input)).rejects.toThrow("LEASE_LOST");
		expect(f.sdk.createHttpsInput).not.toHaveBeenCalled();
	});
});
