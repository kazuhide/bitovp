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
