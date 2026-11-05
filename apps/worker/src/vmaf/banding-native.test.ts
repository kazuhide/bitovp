import { NATIVE_OFFICIAL_REVISION } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	officialCambiOptions,
	verifyBandingCapabilities,
	verifyBandingReceipt,
} from "./banding-native";

const identity = {
	sourceSha256: "a".repeat(64),
	binarySha256: "b".repeat(64),
	supervisorBinarySha256: "c".repeat(64),
	deviceUuid: "d".repeat(32),
};
const selected = { backend: "cuda" as const, device: 0, identity };
const timing = [
	{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04 },
	{ frameNum: 1, timestampSeconds: 0.04, durationSeconds: 0.08 },
];
const expected = {
	selected,
	inputSha256: "e".repeat(64),
	width: 640,
	height: 360,
	bitDepth: 10,
	timing,
	threads: 2,
	decodeThreads: 2,
};
function receipt() {
	return {
		schemaVersion: 1,
		metric: "CAMBI_NR",
		implementation: "bitovp-owned",
		officialSourceRevision: NATIVE_OFFICIAL_REVISION,
		sourceSha256: identity.sourceSha256,
		binarySha256: identity.binarySha256,
		supervisorBinarySha256: identity.supervisorBinarySha256,
		backend: "cuda",
		decodeBackend: "cpu",
		cpuThreads: 2,
		decodeThreads: 2,
		inflightFrames: 1,
		requestedDeviceIndex: 0,
		input: {
			sha256: expected.inputSha256,
			width: 640,
			height: 360,
			bitDepth: 10,
		},
		extractor: {
			name: "cambi",
			featureName: "cambi_encbd_10_ench_360_encw_640",
			options: officialCambiOptions(expected),
		},
		device: {
			index: 0,
			name: "GPU",
			uuid: identity.deviceUuid,
			vendorId: 0x10de,
			deviceId: 0,
			integrated: false,
			memoryBudgetBytes: 1024,
			pciBusId: null,
			driverVersion: "driver",
			driverVersionKnown: true,
			driverVersionSource: "cuda",
			memoryTotalBytes: 1024,
			memoryAvailableBytes: 1024,
			memoryAvailableSource: "cuda",
			memoryHeapIndex: null,
		},
		coverage: {
			complete: true,
			decodedFrames: 2,
			scoredFrames: 2,
			startTimeSeconds: 0,
			endTimeSeconds: 0.12,
			timingSource: "PRESENTATION_TIMESTAMPS_AND_FRAME_DURATION",
		},
		frames: [
			{
				index: 0,
				timeSeconds: 0,
				durationSeconds: 0.04,
				rawScore: 5.0000001,
				cpuReferenceScore: 5,
			},
			{
				index: 1,
				timeSeconds: 0.04,
				durationSeconds: 0.08,
				rawScore: 27,
				cpuReferenceScore: 27,
			},
		],
		cpuParity: {
			checked: true,
			frameCount: 2,
			maxAbsoluteError: 0.0000001,
			absoluteTolerance: 0.000001,
			relativeTolerance: 0.0000001,
		},
		timingMs: {
			wall: 1,
			initialize: 0,
			decode: 0,
			conform: 0,
			extract: 0,
			cpuReference: 0,
			finish: 0,
			upload: 0,
			kernel: 0,
			download: 0,
			cpuPostprocess: 0,
		},
		extractorKernelMs: {},
		memory: {
			maxRssBytes: 10,
			gpuAllocatedBytes: 10,
			hostCopiedInputBytes: 10,
			hostReadbackBytes: 10,
			deviceCopyBytes: 10,
		},
		resourceSnapshotScope: "before-result-serialization",
	};
}

describe("native CAMBI trust boundary", () => {
	it("requires additive metric capability with pinned executable identity", () => {
		const raw = {
			schemaVersion: 1,
			kind: "bitovp-native-capabilities",
			sourceSha256: identity.sourceSha256,
			binarySha256: identity.binarySha256,
			officialSourceRevision: NATIVE_OFFICIAL_REVISION,
			metrics: ["VMAF_V1", "CAMBI_NR"],
			backends: ["cpu", "cuda"],
			bandingReceiptSchemaVersion: 1,
		};
		expect(verifyBandingCapabilities(raw, selected)).toBe(true);
		expect(() =>
			verifyBandingCapabilities(
				{ ...raw, binarySha256: "f".repeat(64) },
				selected,
			),
		).toThrow("BANDING_CAPABILITY_BUILD_MISMATCH");
		expect(() =>
			verifyBandingCapabilities({ ...raw, unexpected: true }, selected),
		).toThrow("BANDING_CAPABILITY_SCHEMA");
	});

	it("uses every official CPU reference value for decisions while retaining actual GPU scores", () => {
		const parsed = verifyBandingReceipt(receipt(), expected);
		expect(parsed.frames[0]).toMatchObject({
			cambi: 5,
			computedCambi: 5.0000001,
		});
		expect(parsed.frames[1]?.cambi).toBe(27);
		expect(parsed.execution).toMatchObject({
			backend: "cuda",
			decisionSource: "CPU_REFERENCE",
		});
	});

	it("accepts owned CAMBI stage timings and rejects other metric namespaces", () => {
		const raw = receipt();
		Object.assign(raw.extractorKernelMs, {
			"cambi.stage.0": 0.1,
			"cambi.stage.11": 0.2,
		});
		expect(
			verifyBandingReceipt(raw, expected).execution.extractorKernelMs,
		).toMatchObject({ "cambi.stage.11": 0.2 });
		Object.assign(raw.extractorKernelMs, { "ssim.stage.0": 0.1 });
		expect(() => verifyBandingReceipt(raw, expected)).toThrow(
			"BANDING_RECEIPT_SCHEMA",
		);
	});

	it.each([
		"frames",
		"identity",
		"parity",
		"timestamp",
		"unknown",
	])("rejects %s corruption", (kind) => {
		const raw = receipt();
		const [first, second] = raw.frames;
		if (!first || !second) throw new Error("invalid native test fixture");
		if (kind === "frames") raw.frames.pop();
		if (kind === "identity") raw.input.sha256 = "f".repeat(64);
		if (kind === "parity") first.rawScore = 6;
		if (kind === "timestamp") second.timeSeconds = 0.05;
		if (kind === "unknown") Object.assign(raw, { extra: true });
		expect(() => verifyBandingReceipt(raw, expected)).toThrow(
			"BANDING_RECEIPT",
		);
	});
});
