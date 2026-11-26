import { createHash } from "node:crypto";
import type { ExperimentRuntime } from "@bitovp/core/encoding-experiments";
import { expect, it } from "vitest";
import { readMeasurement } from "./receipt";

const identity = "4".repeat(64);
const v1Profile = "bitovp-vmaf-cuda-1.0.16-3d0h";
const scorerSha256 = "5".repeat(64);
const modelSha256 = "6".repeat(64);
const legacyRuntime = { runtimeId: identity };
const runtime = {
	...legacyRuntime,
	additionalScoringProfiles: [
		{
			scoringProfileId: v1Profile,
			scorerSha256,
			modelSha256,
			sourceSha256: "7".repeat(64),
			officialRevision: "8".repeat(40),
			decoderRuntimeSha256: "a".repeat(64),
		},
	] satisfies NonNullable<ExperimentRuntime["additionalScoringProfiles"]>,
};
const receipt = {
	schemaVersion: 1,
	scoringProfileId: "official-vmaf-cuda-0.6.1",
	runtimeId: identity,
	scoreMilli: 94100,
	meanVmaf: 94.1,
	frameCount: 300,
	videoBytes: "4062500",
	durationTicks: "300",
	timeBase: { num: 1, den: 30 },
	encodeMs: 1400,
	scoreMs: 100,
};
const additionalScore = {
	scoringProfileId: v1Profile,
	status: "succeeded",
	scoreMilli: 106_140,
	meanVmaf: 106.14,
	scoreMs: 420,
	scorerSha256,
	modelSha256,
};

it("accepts only a complete receipt from the requested runtime and frame window", () => {
	expect(readMeasurement(receipt, legacyRuntime, 300)).toEqual(receipt);
	expect(readMeasurement(receipt, runtime, 300)).toEqual(receipt);
	expect(() =>
		readMeasurement(receipt, { runtimeId: "9".repeat(64) }, 300),
	).toThrow();
	expect(() => readMeasurement(receipt, legacyRuntime, 301)).toThrow();
	expect(() =>
		readMeasurement({ ...receipt, durationTicks: "299" }, legacyRuntime, 300),
	).toThrow();
});

it("accepts a requested secondary measurement or a bounded secondary failure", () => {
	for (const score of [
		additionalScore,
		{
			scoringProfileId: v1Profile,
			status: "failed",
			failureCode: "VMAF_V1_SCORE_FAILED",
		},
	]) {
		const dualReceipt = { ...receipt, additionalScores: [score] };
		expect(readMeasurement(dualReceipt, runtime, 300, [v1Profile])).toEqual(
			dualReceipt,
		);
	}
});

it("rejects missing or unsolicited secondary scores and unadvertised profiles", () => {
	const dualReceipt = { ...receipt, additionalScores: [additionalScore] };
	for (const call of [
		() => readMeasurement(receipt, runtime, 300, [v1Profile]),
		() => readMeasurement(dualReceipt, runtime, 300),
		() => readMeasurement(dualReceipt, legacyRuntime, 300, [v1Profile]),
	]) {
		expect(call).toThrow("EXPERIMENT_RECEIPT_MISMATCH");
	}
});

it("binds both secondary hashes to the advertised runtime", () => {
	for (const hash of ["scorerSha256", "modelSha256"]) {
		const dualReceipt = {
			...receipt,
			additionalScores: [{ ...additionalScore, [hash]: "9".repeat(64) }],
		};
		expect(() =>
			readMeasurement(dualReceipt, runtime, 300, [v1Profile]),
		).toThrow("EXPERIMENT_RECEIPT_MISMATCH");
	}
});

it("requires proof of the exact SDK settings, including typed zero and frame order", () => {
	const qpMap = "ff".repeat(2040);
	const sdk = {
		version: "13.0" as const,
		session: {
			"NV_ENC_RC_PARAMS.enableAQ": false,
			"NV_ENC_RC_PARAMS.constQP.qpInterP": 0,
			"NV_ENC_RC_PARAMS.qpMapMode": 2,
		},
		pictures: [
			{ frameIndex: 10, fields: { "NV_ENC_PIC_PARAMS.encodePicFlags": 2 } },
			{
				frameIndex: 2,
				fields: { "NV_ENC_PIC_PARAMS.encodePicFlags": 2 },
				qpMap,
				reconfigure: {
					"NV_ENC_RECONFIGURE_PARAMS.resetEncoder": false,
					"NV_ENC_RC_PARAMS.averageBitRate": 2_000_000,
				},
				metadata: [
					{ type: 6, payload: "1122" },
					{ type: 5, payload: "ff" },
				],
			},
		],
	};
	const nvencSdkApplied = {
		fieldCount: 10,
		manifestSha256: createHash("sha256")
			.update(
				[
					"init\tNV_ENC_RC_PARAMS.constQP.qpInterP\t0",
					"init\tNV_ENC_RC_PARAMS.enableAQ\t0",
					"init\tNV_ENC_RC_PARAMS.qpMapMode\t2",
					"reconfigure\t2\tNV_ENC_RC_PARAMS.averageBitRate\t2000000",
					"reconfigure\t2\tNV_ENC_RECONFIGURE_PARAMS.resetEncoder\t0",
					"picture\t2\tNV_ENC_PIC_PARAMS.encodePicFlags\t2",
					`qpmap\t2\t${qpMap}`,
					"metadata\t2\t6\t1122",
					"metadata\t2\t5\tff",
					"picture\t10\tNV_ENC_PIC_PARAMS.encodePicFlags\t2",
					"",
				].join("\n"),
			)
			.digest("hex"),
	};
	const expected = {
		...runtime,
		nvencSdk: { version: sdk.version, catalogSha256: "e".repeat(64) },
	};
	const applied = { ...receipt, nvencSdkApplied };
	expect(readMeasurement(applied, expected, 300, undefined, sdk)).toEqual(
		applied,
	);
	for (const call of [
		() => readMeasurement(receipt, expected, 300, undefined, sdk),
		() => readMeasurement(applied, expected, 300),
		() => readMeasurement(applied, legacyRuntime, 300, undefined, sdk),
		() =>
			readMeasurement(
				{
					...applied,
					nvencSdkApplied: { ...nvencSdkApplied, fieldCount: 9 },
				},
				expected,
				300,
				undefined,
				sdk,
			),
		() =>
			readMeasurement(
				{
					...applied,
					nvencSdkApplied: {
						...nvencSdkApplied,
						manifestSha256: "f".repeat(64),
					},
				},
				expected,
				300,
				undefined,
				sdk,
			),
	]) {
		expect(call).toThrow("EXPERIMENT_RECEIPT_MISMATCH");
	}
});

it("binds the primary score to the CPU worker's scoring profile", () => {
	const cpu = {
		...legacyRuntime,
		scoringProfileId: "official-vmaf-cpu-0.6.1" as const,
	};
	const scored = { ...receipt, scoringProfileId: cpu.scoringProfileId };
	expect(readMeasurement(scored, cpu, 300)).toEqual(scored);
	expect(() => readMeasurement(receipt, cpu, 300)).toThrow(
		"EXPERIMENT_RECEIPT_MISMATCH",
	);
	expect(() => readMeasurement(scored, legacyRuntime, 300)).toThrow(
		"EXPERIMENT_RECEIPT_MISMATCH",
	);
});
