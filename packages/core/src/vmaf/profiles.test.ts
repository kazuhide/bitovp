import { describe, expect, it } from "vitest";
import { vmafCloudProfileSchema } from "./cloud";
import { vmafComputeSecretSchema } from "./profiles";

describe("VMAF profile secrets", () => {
	it("never stores URL credentials or signed query strings in readable profile config", () => {
		const base = {
			id: "test",
			label: "test",
			provider: "AZURE_BATCH",
			image: `registry:5000/image@sha256:${"a".repeat(64)}`,
			region: "eastus",
			cpu: 4,
			memoryMiB: 8192,
			diskGiB: 100,
			maxParallel: 1,
			timeoutSeconds: 3600,
			queueTimeoutSeconds: 600,
			maxCostUsdPerHour: 1,
			overheadUsd: 0,
			transferUsdPerGiB: 0,
			maxStagingGiB: 80,
			accountUrl: "https://account.region.batch.azure.com",
			poolId: "pool",
			staging: {
				provider: "AZURE",
				accountUrl: "https://account.blob.core.windows.net",
				container: "stage",
			},
		};
		expect(vmafCloudProfileSchema.safeParse(base).success).toBe(true);
		for (const url of [
			"https://user:secret@account.example",
			"https://account.example?sig=secret",
			"https://account.example#secret",
			"http://account.example",
		]) {
			expect(
				vmafCloudProfileSchema.safeParse({ ...base, accountUrl: url }).success,
			).toBe(false);
			expect(
				vmafCloudProfileSchema.safeParse({
					...base,
					staging: { ...base.staging, accountUrl: url },
				}).success,
			).toBe(false);
			expect(
				vmafCloudProfileSchema.safeParse({
					...base,
					staging: {
						provider: "S3",
						bucket: "stage",
						region: "eu-west-1",
						endpoint: url,
					},
				}).success,
			).toBe(false);
		}
		expect(
			vmafCloudProfileSchema.safeParse({
				...base,
				image: `user:secret@registry/image@sha256:${"a".repeat(64)}`,
			}).success,
		).toBe(false);
	});
	it("rejects missing material and unknown secret fields", () => {
		expect(
			vmafComputeSecretSchema.safeParse({ provider: "AWS", accessKeyId: "key" })
				.success,
		).toBe(false);
		expect(
			vmafComputeSecretSchema.safeParse({
				provider: "AKAMAI",
				token: "secret",
				url: "https://evil.test",
			}).success,
		).toBe(false);
	});
});

it("rejects saved AWS temporary credentials without a refresh/lifetime contract", () => {
	const staticKey = {
		provider: "AWS",
		accessKeyId: "key",
		secretAccessKey: "secret",
	};
	expect(vmafComputeSecretSchema.safeParse(staticKey).success).toBe(true);
	expect(
		vmafComputeSecretSchema.safeParse({
			...staticKey,
			sessionToken: "temporary-token",
		}).success,
	).toBe(false);
	expect(
		vmafComputeSecretSchema.safeParse({
			...staticKey,
			sessionToken: "temporary-token",
			expiration: "2027-01-01T00:00:00Z",
		}).success,
	).toBe(false);
});
