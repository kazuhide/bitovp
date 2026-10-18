import { randomBytes } from "node:crypto";
import { AesGcmCipher, type VmafCloudProfile } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "./client";
import { TENANT_ORGANIZATION } from "./tenant-client";
import { fakeTable } from "./test-helpers";
import {
	createVmafComputeCredentialStore,
	createVmafExecutionProfileStore,
	listVmafCloudProfiles,
} from "./vmaf-profiles";

const profile: VmafCloudProfile = {
	id: "aws",
	label: "AWS",
	provider: "AWS_BATCH",
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
	jobQueue: "queue",
	jobDefinition: "definition:1",
};
const secret = {
	provider: "AWS" as const,
	accessKeyId: "test-access-key",
	secretAccessKey: "test-secret-key",
};
function setup() {
	const credentials = fakeTable(["encryptedSecret"]);
	const profiles = fakeTable();
	const prisma = {
		vmafComputeCredential: credentials,
		vmafExecutionProfile: profiles,
		$transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
	} as unknown as AppPrismaClient;
	const cipher = new AesGcmCipher(randomBytes(32));
	return {
		prisma,
		credentials,
		profiles,
		vault: createVmafComputeCredentialStore(prisma, cipher),
		store: createVmafExecutionProfileStore(prisma),
	};
}

describe("immutable cloud credential vault", () => {
	it("encrypts write-only material, binds row/provider, and retains disabled versions for cleanup", async () => {
		const { vault, credentials } = setup();
		const first = await vault.create({ label: "First", secret });
		const second = await vault.create({
			label: "Rotated",
			secret: { ...secret, secretAccessKey: "new-key" },
		});
		expect(first).not.toHaveProperty("encryptedSecret");
		expect(JSON.stringify(await vault.list())).not.toContain("test-secret-key");
		expect(credentials.rows.get(first.id)?.encryptedSecret).not.toContain(
			"test-secret-key",
		);
		await vault.disable(first.id);
		const listing = vi
			.spyOn(credentials, "findMany")
			.mockImplementation(async (args) => {
				expect(args).toMatchObject({ where: { disabledAt: null } });
				return [...credentials.rows.values()]
					.filter((row) => !row.disabledAt)
					.map(({ encryptedSecret: _secret, ...row }) => row);
			});
		expect((await vault.list()).map((row) => row.id)).toEqual([second.id]);
		listing.mockRestore();
		expect(await vault.revealSecret(first.id)).toEqual(secret);
		expect(await vault.revealSecret(second.id)).toMatchObject({
			secretAccessKey: "new-key",
		});
		const row = credentials.rows.get(second.id);
		if (!row) throw new Error("missing fixture");
		row.encryptedSecret = credentials.rows.get(first.id)?.encryptedSecret;
		await expect(vault.revealSecret(second.id)).rejects.toThrow();
	});
});

describe("named cloud execution profiles", () => {
	it("new organizations never inherit environment profiles", async () => {
		const { prisma } = setup();
		Object.defineProperty(prisma, TENANT_ORGANIZATION, {
			value: "00000000-0000-4000-8000-00000000000a",
		});
		expect(
			await listVmafCloudProfiles(prisma, JSON.stringify([profile])),
		).toEqual([]);
	});
	it("versions updates, prevents stale overwrite, and snapshots secret references only", async () => {
		const { store, vault, prisma } = setup();
		const credential = await vault.create({ label: "Compute", secret });
		const config = {
			...profile,
			computeCredentialId: credential.id,
			stagingCredentialId: credential.id,
		};
		const created = await store.save({ profile: config });
		expect(created.version).toBe(1);
		const [snapshot] = await listVmafCloudProfiles(prisma);
		expect(snapshot).toMatchObject({
			profileVersion: 1,
			computeCredentialId: credential.id,
		});
		await expect(store.save({ profile: config })).rejects.toThrow("reload");
		await store.save({
			profile: { ...config, label: "New" },
			expectedVersion: 1,
		});
		await expect(
			store.save({ profile: config, expectedVersion: 1 }),
		).rejects.toThrow("reload");
		expect(snapshot?.label).toBe("AWS");
		expect(JSON.stringify(snapshot)).not.toContain("test-secret-key");
	});
	it("disabled DB profiles never resurrect through same-ID env fallback", async () => {
		const { prisma, store } = setup();
		await store.save({ profile, enabled: false });
		expect(
			await listVmafCloudProfiles(prisma, JSON.stringify([profile])),
		).toEqual([]);
	});
	it("reset tombstones stay hidden, shadow env fallback, and only explicit recreation revives them", async () => {
		const { prisma, store, profiles } = setup();
		await store.save({ profile, enabled: false });
		const row = profiles.rows.get(profile.id);
		if (!row) throw new Error("Missing profile");
		const list = vi
			.spyOn(profiles, "findMany")
			.mockImplementation(async (args = {}) => {
				const where = args as { where?: { resetAt?: unknown } };
				return [...profiles.rows.values()].filter(
					(value) => !where.where || !value.resetAt,
				);
			});
		// Manual disable remains visible/editable, unlike a customer reset.
		expect(await store.list()).toHaveLength(1);
		Object.assign(row, { resetAt: new Date(), enabled: false, version: 2 });
		expect(await store.list()).toEqual([]);
		expect(list).toHaveBeenLastCalledWith({
			where: { resetAt: null },
			orderBy: { label: "asc" },
		});
		expect(
			await listVmafCloudProfiles(prisma, JSON.stringify([profile])),
		).toEqual([]);
		await expect(store.save({ profile, expectedVersion: 1 })).rejects.toThrow(
			"reload",
		);
		await expect(store.save({ profile, expectedVersion: 2 })).rejects.toThrow(
			"reload",
		);
		const recreated = await store.save({ profile });
		expect(recreated).toMatchObject({
			version: 3,
			resetAt: null,
			enabled: true,
		});
		expect(await store.list()).toHaveLength(1);
		expect(
			await listVmafCloudProfiles(prisma, JSON.stringify([profile])),
		).toMatchObject([{ id: profile.id, profileVersion: 3 }]);
	});
	it("refuses missing, disabled, and wrong-provider credentials while retaining historical decrypt", async () => {
		const { prisma, vault, store } = setup();
		const row = await vault.create({ label: "Compute", secret });
		await store.save({ profile: { ...profile, computeCredentialId: row.id } });
		await vault.disable(row.id);
		expect(await listVmafCloudProfiles(prisma)).toEqual([]);
		await expect(
			store.save({
				profile: { ...profile, computeCredentialId: row.id },
				expectedVersion: 1,
			}),
		).rejects.toThrow("disabled");
		const wrong = await vault.create({
			label: "Other",
			secret: { provider: "AKAMAI", token: "token" },
		});
		await expect(
			store.save({
				profile: { ...profile, computeCredentialId: wrong.id },
				expectedVersion: 1,
			}),
		).rejects.toThrow("incompatible");
		await expect(
			store.save({
				profile: {
					...profile,
					computeCredentialId: "00000000-0000-4000-8000-000000000000",
				},
				expectedVersion: 1,
			}),
		).rejects.toThrow("missing");
	});
});
