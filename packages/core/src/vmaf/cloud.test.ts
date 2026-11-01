import { describe, expect, it } from "vitest";
import { parseVmafCloudProfiles, vmafExecutionSchema } from "./cloud";

describe("VMAF execution selection", () => {
	it.each([
		"CPU",
		"AUTO",
	] as const)("accepts explicit local %s processing", (localMode) => {
		const execution = { backend: "LOCAL", localMode };
		expect(vmafExecutionSchema.parse(execution)).toEqual(execution);
	});
	it.each([
		{ backend: "LOCAL", localMode: "CUDA" },
		{ backend: "LOCAL", localMode: "AUTO", device: 0 },
		{ backend: "LOCAL", localMode: "AUTO", nativePath: "/untrusted" },
		{ backend: "CLOUD", profileId: "gcp", budgetUsd: 1, localMode: "AUTO" },
	])("rejects invalid or misplaced local processing options", (execution) => {
		expect(vmafExecutionSchema.safeParse(execution).success).toBe(false);
	});
	it("defaults to no available paid backends and allows explicit local", () => {
		expect(parseVmafCloudProfiles(undefined)).toEqual([]);
		expect(vmafExecutionSchema.parse({ backend: "LOCAL" })).toEqual({
			backend: "LOCAL",
		});
	});
	it("requires an explicit positive budget and a profile reference", () => {
		for (const value of [
			{ backend: "CLOUD" },
			{ backend: "CLOUD", profileId: "gcp", budgetUsd: 0 },
			{ backend: "CLOUD", profileId: "gcp", budgetUsd: 1, token: "secret" },
		]) {
			expect(vmafExecutionSchema.safeParse(value).success).toBe(false);
		}
		expect(
			vmafExecutionSchema.parse({
				backend: "CLOUD",
				profileId: "gcp",
				budgetUsd: 2,
			}).backend,
		).toBe("CLOUD");
	});
	it("rejects floating image tags and duplicate profiles", () => {
		const p = {
			id: "test",
			label: "test",
			image: `registry/worker@sha256:${"a".repeat(64)}`,
			region: "eu-west-1",
			cpu: 4,
			memoryMiB: 8192,
			diskGiB: 100,
			maxParallel: 8,
			timeoutSeconds: 3600,
			queueTimeoutSeconds: 600,
			maxCostUsdPerHour: 1,
			overheadUsd: 0,
			transferUsdPerGiB: 0,
			maxStagingGiB: 80,
			staging: { provider: "S3", bucket: "private", region: "eu-west-1" },
			provider: "AWS_BATCH",
			jobQueue: "queue",
			jobDefinition: "definition:1",
		};
		expect(parseVmafCloudProfiles(JSON.stringify([p]))).toHaveLength(1);
		expect(() => parseVmafCloudProfiles(JSON.stringify([p, p]))).toThrow();
		expect(() =>
			parseVmafCloudProfiles(
				JSON.stringify([{ ...p, image: "worker:latest" }]),
			),
		).toThrow();
	});
});
