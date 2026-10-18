import { describe, expect, it } from "vitest";
import { automaticVmafProfile, type VmafCloudProfile } from "./cloud";

const profile: VmafCloudProfile = {
	id: "gcp",
	label: "GCP",
	provider: "GCP_BATCH",
	project: "project",
	serviceAccount: "worker@example.com",
	machineType: "old-manual-type",
	spot: true,
	image: `registry/worker@sha256:${"a".repeat(64)}`,
	region: "us-central1",
	cpu: 1,
	memoryMiB: 1024,
	diskGiB: 10,
	maxParallel: 1,
	timeoutSeconds: 3600,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 2,
	transferUsdPerGiB: 0,
	overheadUsd: 0,
	maxStagingGiB: 400,
	staging: { provider: "GCS", bucket: "private" },
	profileVersion: 7,
};

describe("automatic VMAF resources", () => {
	it.each([
		[720, 576, 4, 8192, "n2-standard-4"],
		[1920, 1080, 8, 32768, "n2-standard-8"],
		[3840, 2160, 16, 65536, "n2-standard-16"],
		[1080, 1920, 8, 32768, "n2-standard-8"],
	])("sizes reference %dx%d from SVAT tiers", (width, height, cpu, memoryMiB, machineType) => {
		expect(
			automaticVmafProfile(profile, { width, height, bytes: 1024 ** 3 }),
		).toMatchObject({ cpu, memoryMiB, machineType, diskGiB: 50 });
	});
	it("replaces old manual limits, preserving immutable connection and budget settings", () => {
		const result = automaticVmafProfile(profile);
		expect(result).toMatchObject({
			cpu: 8,
			memoryMiB: 32768,
			diskGiB: 500,
			maxParallel: 100,
			profileVersion: 7,
			maxCostUsdPerHour: 2,
			staging: profile.staging,
		});
		expect(profile.cpu).toBe(1);
	});
	it("sizes disk from both actual input byte lengths plus headroom", () => {
		expect(
			automaticVmafProfile(profile, { bytes: 250 * 1024 ** 3 }).diskGiB,
		).toBe(320);
	});
	it.each([
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid byte count %s", (bytes) => {
		expect(() => automaticVmafProfile(profile, { bytes })).toThrow();
	});
});
