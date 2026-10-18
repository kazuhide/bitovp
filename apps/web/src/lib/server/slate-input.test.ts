import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@bitmovin/api-sdk", () => {
	class Resource {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	}
	return {
		S3Input: Resource,
		GenericS3Input: Resource,
		GcsInput: Resource,
		AzureInput: Resource,
		S3SignatureVersion: { V2: "S3_V2", V4: "S3_V4" },
	};
});

import { planSlateInput } from "./slate-input";

/**
 * The per-provider WIRE parameters, pinned against the worker's
 * `slate-register.ts` / `exec-shared.ts` table — the two must not drift, and
 * the one measured trap  is asserted.
 */
async function wire(
	plan: ReturnType<typeof planSlateInput>,
): Promise<{ path: string; call: string; params: Record<string, unknown> }> {
	if (!plan.ok) {
		throw new Error(plan.reason);
	}
	const calls: { call: string; params: Record<string, unknown> }[] = [];
	const create = (call: string) => async (params: Record<string, unknown>) => {
		calls.push({ call, params });
		return { id: "input-1" };
	};
	const api = {
		encoding: {
			inputs: {
				s3: { create: create("s3") },
				genericS3: { create: create("genericS3") },
				gcs: { create: create("gcs") },
				azure: { create: create("azure") },
			},
		},
	} as never;
	const id = await plan.create(api);
	expect(id).toBe("input-1");
	const [only] = calls;
	if (!only) {
		throw new Error("no SDK call");
	}
	return { path: plan.path, ...only };
}

const SECRET = { accessKeyId: "AKIAFAKE", secretAccessKey: "fake-secret" };

describe("planSlateInput — provider table (mirrors the worker's)", () => {
	it("AWS_S3", async () => {
		expect(
			await wire(
				planSlateInput(
					{ provider: "AWS_S3", config: {}, secret: SECRET },
					"b",
					"n",
				),
			),
		).toEqual({
			path: "/encoding/inputs/s3",
			call: "s3",
			params: {
				name: "n",
				bucketName: "b",
				accessKey: "AKIAFAKE",
				secretKey: "fake-secret",
			},
		});
	});

	it("AKAMAI_OBJECT_STORAGE is HTTPS on 443 unless the credential says otherwise", async () => {
		const plan = planSlateInput(
			{
				provider: "AKAMAI_OBJECT_STORAGE",
				config: { host: "jp-osa-1.linodeobjects.com" },
				secret: SECRET,
			},
			"b",
			"n",
		);
		expect((await wire(plan)).params).toMatchObject({
			host: "jp-osa-1.linodeobjects.com",
			port: 443,
			ssl: true,
			signatureVersion: "S3_V4",
		});
	});

	it("OCI_OBJECT_STORAGE derives the S3-compat host from namespace+region (C10)", async () => {
		const plan = planSlateInput(
			{
				provider: "OCI_OBJECT_STORAGE",
				config: { namespace: "ns", region: "ap-osaka-1" },
				secret: SECRET,
			},
			"b",
			"n",
		);
		expect((await wire(plan)).params).toMatchObject({
			host: "ns.compat.objectstorage.ap-osaka-1.oraclecloud.com",
			signatureVersion: "S3_V4",
		});
	});

	it("GENERIC_S3 carries host/port/ssl/signatureVersion from its config", async () => {
		const plan = planSlateInput(
			{
				provider: "GENERIC_S3",
				config: {
					host: "minio.local",
					port: 9000,
					ssl: false,
					signatureVersion: "S3_V2",
				},
				secret: SECRET,
			},
			"b",
			"n",
		);
		expect((await wire(plan)).params).toMatchObject({
			host: "minio.local",
			port: 9000,
			ssl: false,
			signatureVersion: "S3_V2",
		});
	});

	it("GCS_HMAC and AZURE_BLOB use their own secret fields", async () => {
		expect(
			(
				await wire(
					planSlateInput(
						{
							provider: "GCS_HMAC",
							config: {},
							secret: { accessKey: "g", secret: "s" },
						},
						"b",
						"n",
					),
				)
			).params,
		).toEqual({ name: "n", bucketName: "b", accessKey: "g", secretKey: "s" });
		expect(
			(
				await wire(
					planSlateInput(
						{
							provider: "AZURE_BLOB",
							config: { accountName: "acct" },
							secret: { accountKey: "k" },
						},
						"c",
						"n",
					),
				)
			).params,
		).toEqual({
			name: "n",
			container: "c",
			accountName: "acct",
			accountKey: "k",
		});
	});

	it("refuses a missing secret field BY NAME and an unsupported provider", () => {
		expect(
			planSlateInput(
				{ provider: "AWS_S3", config: {}, secret: { accessKeyId: "a" } },
				"b",
				"n",
			),
		).toEqual({
			ok: false,
			reason: "S3 credential carries no secretAccessKey",
		});
		expect(
			planSlateInput(
				{ provider: "AKAMAI_NETSTORAGE", config: {}, secret: {} },
				"b",
				"n",
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("not supported"),
		});
	});
});
