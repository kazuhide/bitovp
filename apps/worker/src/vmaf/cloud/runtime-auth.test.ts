import { vmafCloudProfileSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { createCloudRuntimeAuth } from "./runtime-auth";

const constructors = vi.hoisted(() => ({
	batch: vi.fn(),
	s3: vi.fn(),
	google: vi.fn(),
	storage: vi.fn(),
	azure: vi.fn(),
	blob: vi.fn(),
}));
vi.mock("@aws-sdk/client-batch", () => ({
	BatchClient: class {
		constructor(config: unknown) {
			constructors.batch(config);
		}
	},
}));
vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		constructor(config: unknown) {
			constructors.s3(config);
		}
	},
}));
vi.mock("google-auth-library", () => ({
	GoogleAuth: class {
		constructor(config: unknown) {
			constructors.google(config);
		}
		async getAccessToken() {
			return "google-token";
		}
	},
}));
vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		constructor(config: unknown) {
			constructors.storage(config);
		}
	},
}));
vi.mock("@azure/identity", () => ({
	ClientSecretCredential: class {
		constructor(...config: unknown[]) {
			constructors.azure(...config);
		}
		async getToken(scope: string) {
			return { token: scope };
		}
	},
}));
vi.mock("@azure/storage-blob", () => ({
	BlobServiceClient: class {
		constructor(...config: unknown[]) {
			constructors.blob(...config);
		}
	},
}));
const computeId = "11111111-1111-4111-8111-111111111111";
const stagingId = "22222222-2222-4222-8222-222222222222";
const base = {
	id: "profile",
	label: "test",
	image: `worker@sha256:${"a".repeat(64)}`,
	region: "us-east-1",
	cpu: 4,
	memoryMiB: 8192,
	diskGiB: 100,
	maxParallel: 4,
	timeoutSeconds: 3600,
	queueTimeoutSeconds: 600,
	maxCostUsdPerHour: 1,
	transferUsdPerGiB: 0,
	overheadUsd: 1,
	maxStagingGiB: 80,
};
const profile = vmafCloudProfileSchema.parse({
	...base,
	provider: "AWS_BATCH",
	jobQueue: "queue",
	jobDefinition: "definition",
	computeCredentialId: computeId,
	stagingCredentialId: stagingId,
	staging: { provider: "S3", bucket: "staging", region: "us-east-1" },
});

describe("controller-only named authentication", () => {
	it("resolves separate compute and staging credentials without mutating the snapshot", async () => {
		const reveal = vi.fn(async (id: string) => ({
			provider: "AWS" as const,
			accessKeyId: id,
			secretAccessKey: `secret-${id}`,
		}));
		const auth = createCloudRuntimeAuth(reveal);
		await auth.computeAuth(profile);
		await auth.stagingAuth(profile);
		expect(reveal.mock.calls).toEqual([[computeId], [stagingId]]);
		expect(constructors.batch).toHaveBeenLastCalledWith(
			expect.objectContaining({
				credentials: {
					accessKeyId: computeId,
					secretAccessKey: `secret-${computeId}`,
				},
			}),
		);
		expect(constructors.s3).toHaveBeenLastCalledWith(
			expect.objectContaining({
				credentials: {
					accessKeyId: stagingId,
					secretAccessKey: `secret-${stagingId}`,
				},
			}),
		);
		expect(JSON.stringify(profile)).not.toContain("secret-");
	});
	it("retains environment identity when no named credential is selected", async () => {
		const reveal = vi.fn();
		const auth = createCloudRuntimeAuth(reveal);
		const ambient = {
			...profile,
			computeCredentialId: undefined,
			stagingCredentialId: undefined,
		};
		expect(await auth.computeAuth(ambient)).toEqual({});
		expect(await auth.stagingAuth(ambient)).toEqual({});
		expect(reveal).not.toHaveBeenCalled();
	});
	it("denies ambient compute and staging identity for a non-default organization", async () => {
		const reveal = vi.fn();
		const auth = createCloudRuntimeAuth(reveal, () => false);
		const ambient = {
			...profile,
			computeCredentialId: undefined,
			stagingCredentialId: undefined,
		};
		await expect(auth.computeAuth(ambient)).rejects.toThrow(
			"credentials are unavailable",
		);
		await expect(auth.stagingAuth(ambient)).rejects.toThrow(
			"credentials are unavailable",
		);
		expect(reveal).not.toHaveBeenCalled();
	});
	it("never falls back to environment identity for mismatched or unavailable named credentials", async () => {
		const mismatch = createCloudRuntimeAuth(async () => ({
			provider: "AKAMAI",
			token: "PRIVATE",
		}));
		await expect(mismatch.computeAuth(profile)).rejects.toThrow(
			"credentials are unavailable",
		);
		await expect(mismatch.stagingAuth(profile)).rejects.toThrow(
			"credentials are unavailable",
		);
		const unavailable = createCloudRuntimeAuth(async () => {
			throw new Error("PRIVATE token");
		});
		await expect(unavailable.computeAuth(profile)).rejects.toThrow(
			/^VMAF cloud credentials are unavailable$/,
		);
	});
	it("uses Google service-account material independently for Batch and storage", async () => {
		const value = {
			provider: "GCP" as const,
			clientEmail: "service@example.com",
			privateKey: "key",
			projectId: "project",
		};
		const auth = createCloudRuntimeAuth(async () => value);
		const p = vmafCloudProfileSchema.parse({
			...base,
			provider: "GCP_BATCH",
			project: "project",
			machineType: "c3-standard-4",
			serviceAccount: "service@example.com",
			computeCredentialId: computeId,
			stagingCredentialId: stagingId,
			staging: { provider: "GCS", bucket: "staging" },
		});
		expect(await (await auth.computeAuth(p)).googleToken?.()).toBe(
			"google-token",
		);
		await auth.stagingAuth(p);
		for (const sdkConstructor of [constructors.google, constructors.storage])
			expect(sdkConstructor).toHaveBeenLastCalledWith(
				expect.objectContaining({
					credentials: {
						client_email: value.clientEmail,
						private_key: value.privateKey,
					},
				}),
			);
	});
	it("uses Azure service principal for Batch tokens and storage delegation", async () => {
		const auth = createCloudRuntimeAuth(async () => ({
			provider: "AZURE",
			tenantId: "tenant",
			clientId: "client",
			clientSecret: "key",
		}));
		const p = vmafCloudProfileSchema.parse({
			...base,
			provider: "AZURE_BATCH",
			accountUrl: "https://account.region.batch.azure.com",
			poolId: "pool",
			computeCredentialId: computeId,
			stagingCredentialId: stagingId,
			staging: {
				provider: "AZURE",
				accountUrl: "https://account.blob.core.windows.net",
				container: "staging",
			},
		});
		expect(await (await auth.computeAuth(p)).azureToken?.()).toBe(
			"https://batch.core.windows.net/.default",
		);
		await auth.stagingAuth(p);
		expect(constructors.azure).toHaveBeenLastCalledWith(
			"tenant",
			"client",
			"key",
		);
		expect(constructors.blob).toHaveBeenCalled();
	});
	it("keeps Akamai API token separate from S3 staging keys", async () => {
		const auth = createCloudRuntimeAuth(async (id) =>
			id === computeId
				? { provider: "AKAMAI", token: "private-token" }
				: {
						provider: "AWS",
						accessKeyId: "storage",
						secretAccessKey: "storage-key",
					},
		);
		const p = vmafCloudProfileSchema.parse({
			...base,
			provider: "AKAMAI_VM",
			instanceType: "g6-standard-4",
			bootImage: "linode/ubuntu24.04",
			reaperEnabled: true,
			computeCredentialId: computeId,
			stagingCredentialId: stagingId,
			staging: {
				provider: "S3",
				bucket: "staging",
				region: "us-east-1",
				endpoint: "https://us-east-1.linodeobjects.com",
			},
		});
		expect((await auth.computeAuth(p)).akamaiToken?.()).toBe("private-token");
		await auth.stagingAuth(p);
		expect(constructors.s3).toHaveBeenLastCalledWith(
			expect.objectContaining({
				credentials: expect.objectContaining({ accessKeyId: "storage" }),
			}),
		);
	});
});
