import { describe, expect, it } from "vitest";
import { bandingAssessmentOf, bandingExecutionOf } from "./banding-public";

const execution = {
	version: 1,
	metric: "CAMBI_NR",
	backend: "cuda",
	implementation: "bitovp-owned",
	decisionSource: "CPU_REFERENCE",
	decisionPrecision: "LIBVMAF_JSON_ADAPTIVE_6_16",
	coverage: { complete: true, frameCount: 2, durationSeconds: 0.08 },
};

describe("public Banding evidence", () => {
	it("projects actual backend and canonical precision while stripping private native evidence", () => {
		expect(
			bandingExecutionOf({
				bandingExecution: {
					...execution,
					receipt: { path: "/private/run.json" },
					signedUrl: "https://private.example",
				},
				source: { credentials: "secret" },
			}),
		).toEqual(execution);
	});
	it.each([
		{ ...execution, decisionPrecision: "UNKNOWN" },
		{ ...execution, coverage: { ...execution.coverage, complete: false } },
		{ ...execution, backend: "cpu" },
		{ ...execution, decisionSource: "GPU" },
	])("does not claim unsupported or incomplete execution evidence: %j", (invalid) => {
		expect(bandingExecutionOf({ bandingExecution: invalid })).toBeUndefined();
	});
	it("preserves measured full-frame intervals and explicit limits only", () => {
		const assessment = {
			severity: "WARN",
			ranges: [
				{
					startSeconds: 0,
					endSeconds: 0.04,
					startFrame: 0,
					endFrame: 0,
					peak: 7,
					severity: "WARN",
				},
			],
			warningThreshold: 5,
			affectedSeconds: 0.04,
			warningSeconds: 0.04,
			failureSeconds: 0,
		};
		expect(
			bandingAssessmentOf({
				bandingAssessment: { ...assessment, privatePath: "/private/evidence" },
			}),
		).toEqual(assessment);
		expect(
			bandingAssessmentOf({
				bandingAssessment: { ...assessment, failureThreshold: -1 },
			}),
		).toBeUndefined();
	});
});
