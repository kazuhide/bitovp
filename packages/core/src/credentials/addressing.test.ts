import { describe, expect, it } from "vitest";
import { akamaiRegionFromHost, bucketAddressing } from "./addressing";
import { CREDENTIAL_PROVIDERS } from "./schemas";

/**
 * The one place browsing and playback agree about where a bucket lives. Both
 * `packages/storage/src/factory.ts` (SDK endpoints) and
 * `playback/public-url.ts` (public URLs) read this, so a wrong row here shows
 * up as "the storage browser lists the object and the player 404s on it".
 */

describe("bucketAddressing", () => {
	const cases: {
		name: string;
		provider: (typeof CREDENTIAL_PROVIDERS)[number];
		config: Record<string, unknown>;
		expected: {
			origin: string;
			pathStyle: boolean;
			region: string;
			awsManaged: boolean;
			missing: string | null;
		};
	}[] = [
		{
			name: "AWS_S3 → regional endpoint, virtual-host, SDK-managed",
			provider: "AWS_S3",
			config: { region: "ap-northeast-1" },
			expected: {
				origin: "https://s3.ap-northeast-1.amazonaws.com",
				pathStyle: false,
				region: "ap-northeast-1",
				awsManaged: true,
				missing: null,
			},
		},
		{
			name: "AWS_S3_ROLE_BASED addresses identically to key-based",
			provider: "AWS_S3_ROLE_BASED",
			config: { region: "us-east-2", roleArn: "arn:aws:iam::1:role/x" },
			expected: {
				origin: "https://s3.us-east-2.amazonaws.com",
				pathStyle: false,
				region: "us-east-2",
				awsManaged: true,
				missing: null,
			},
		},
		{
			name: "AWS_S3 with no region names the field, keeps the signing default",
			provider: "AWS_S3",
			config: {},
			expected: {
				origin: "https://s3.us-east-1.amazonaws.com",
				pathStyle: false,
				region: "us-east-1",
				awsManaged: true,
				missing: "region",
			},
		},
		{
			name: "Akamai → cluster region from the host, path-style (C10)",
			provider: "AKAMAI_OBJECT_STORAGE",
			config: { host: "jp-osa-1.linodeobjects.com" },
			expected: {
				origin: "https://jp-osa-1.linodeobjects.com",
				pathStyle: true,
				region: "jp-osa-1",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "OCI → compat host, path-style (C10)",
			provider: "OCI_OBJECT_STORAGE",
			config: { namespace: "ns1", region: "ap-osaka-1" },
			expected: {
				origin: "https://ns1.compat.objectstorage.ap-osaka-1.oraclecloud.com",
				pathStyle: true,
				region: "ap-osaka-1",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "OCI missing a namespace names it before the region",
			provider: "OCI_OBJECT_STORAGE",
			config: { region: "ap-osaka-1" },
			expected: {
				origin: "https://.compat.objectstorage.ap-osaka-1.oraclecloud.com",
				pathStyle: true,
				region: "ap-osaka-1",
				awsManaged: false,
				missing: "namespace",
			},
		},
		{
			name: "OCI missing only a region names the region",
			provider: "OCI_OBJECT_STORAGE",
			config: { namespace: "ns1" },
			expected: {
				origin: "https://ns1.compat.objectstorage..oraclecloud.com",
				pathStyle: true,
				region: "",
				awsManaged: false,
				missing: "region",
			},
		},
		{
			name: "GENERIC_S3 honours port and plaintext",
			provider: "GENERIC_S3",
			config: { host: "minio.internal", port: 9000, ssl: false },
			expected: {
				origin: "http://minio.internal:9000",
				pathStyle: true,
				region: "us-east-1",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "GENERIC_S3 defaults to https when ssl is absent",
			provider: "GENERIC_S3",
			config: { host: "s3.example.com" },
			expected: {
				origin: "https://s3.example.com",
				pathStyle: true,
				region: "us-east-1",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "GCS HMAC → XML interop endpoint, path-style",
			provider: "GCS_HMAC",
			config: {},
			expected: {
				origin: "https://storage.googleapis.com",
				pathStyle: true,
				region: "auto",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "GCS service account addresses the same way",
			provider: "GCS_SERVICE_ACCOUNT",
			config: {},
			expected: {
				origin: "https://storage.googleapis.com",
				pathStyle: true,
				region: "auto",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "Azure → account blob host, container as the first path segment",
			provider: "AZURE_BLOB",
			config: { accountName: "acct" },
			expected: {
				origin: "https://acct.blob.core.windows.net",
				pathStyle: true,
				region: "",
				awsManaged: false,
				missing: null,
			},
		},
		{
			name: "Azure with no account names the field",
			provider: "AZURE_BLOB",
			config: {},
			expected: {
				origin: "https://.blob.core.windows.net",
				pathStyle: true,
				region: "",
				awsManaged: false,
				missing: "accountName",
			},
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(bucketAddressing(testCase.provider, testCase.config)).toEqual(
				testCase.expected,
			);
		});
	}

	it("returns null for every provider that holds no buckets", () => {
		const bucketless = [
			"SFTP",
			"DRM_CENC",
			"DRM_SPEKE",
			"LIVE_MEDIA_INGEST",
			"NEXGUARD",
			"SRT_PASSPHRASE",
			"ZIXI",
			"POIS_ENDPOINT",
			"KANTAR",
		] as const;
		for (const provider of bucketless) {
			expect(bucketAddressing(provider, { host: "h" }), provider).toBeNull();
		}
	});

	it("answers for every provider in the enum — a new one cannot be silently skipped", () => {
		// The switch is exhaustive by types, but a `default` that returned null
		// would compile and would quietly make a new provider unplayable. This
		// asserts on the population instead: every id is either addressable or
		// deliberately bucketless, and the list of both is fixed above.
		const answered = CREDENTIAL_PROVIDERS.filter(
			(p) => bucketAddressing(p, {}) !== null,
		);
		expect(answered).toEqual([
			"AWS_S3",
			"AWS_S3_ROLE_BASED",
			"AKAMAI_OBJECT_STORAGE",
			"OCI_OBJECT_STORAGE",
			"GENERIC_S3",
			"GCS_HMAC",
			"GCS_SERVICE_ACCOUNT",
			"AZURE_BLOB",
		]);
		// 7 -> 8 non-storage providers: NOTIFICATION_WEBHOOK  joins
		// the null branch — a webhook URL has no bucket addressing.
		// 8 -> 9: AKAMAI_NETSTORAGE . It IS storage, and it is
		// still bucketless: the upload account is the container, so there is no
		// bucket to address. Note it does not join the list above even though
		// AKAMAI_OBJECT_STORAGE is there — same vendor, different product.
		// 9 -> 10: AKAMAI_MSL . Storage in
		// the sense that bytes land there, and bucketless like NetStorage — it
		// addresses a provisioned STREAM, so there is no container to name.
		// SPEKE and Media Ingest have no storage bucket.
		expect(answered.length + 12).toBe(CREDENTIAL_PROVIDERS.length);
	});
});

describe("akamaiRegionFromHost", () => {
	it("extracts the cluster id", () => {
		expect(akamaiRegionFromHost("jp-osa-1.linodeobjects.com")).toBe("jp-osa-1");
	});

	it("ignores a bucket-qualified host's leading labels", () => {
		expect(akamaiRegionFromHost("bkt.jp-osa-1.linodeobjects.com")).toBe(
			"jp-osa-1",
		);
	});

	it("falls back for a host that is not Akamai's at all", () => {
		expect(akamaiRegionFromHost("s3.example.com")).toBe("us-east-1");
	});
});
