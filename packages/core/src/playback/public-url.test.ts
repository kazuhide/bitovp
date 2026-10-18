import { describe, expect, it } from "vitest";
import type { CredentialProviderId } from "../credentials/schemas";
import {
	describePublicUrlReason,
	mslEdgeManifestUrl,
	type PublicUrlReasonCode,
	publicObjectUrl,
} from "./public-url";

/**
 * Per-driver public URL derivation , including
 * every negative case the design names: no ACL, an http endpoint, OCI, SFTP.
 *
 * A URL here is a claim that an anonymous GET succeeds. The AWS row is the one
 * that has actually been measured against a real bucket — §14.2 records the
 * anonymous 200 and confirms this builder produces exactly that URL. Every
 * other row is derived from the provider's documented URL shape and is
 * unverified against a live tenancy; that is why OCI derives nothing at all
 * rather than a plausible guess.
 */

type Case = {
	name: string;
	provider: CredentialProviderId;
	config?: Record<string, unknown>;
	bucket?: string | null;
	key?: string;
	acl?: "PUBLIC_READ" | "PRIVATE" | undefined;
	url: string | null;
	via: "publicBaseUrls" | "derived" | "none";
	reason?: PublicUrlReasonCode;
	/** For MISSING_CONFIG rows: the field the message must name. */
	field?: string;
};

const KEY = "output/run-1/stream.m3u8";

const cases: Case[] = [
	{
		name: "AWS_S3 public-read → virtual-host URL from the credential region",
		provider: "AWS_S3",
		config: { region: "ap-northeast-1" },
		bucket: "out-bucket",
		acl: "PUBLIC_READ",
		url: "https://out-bucket.s3.ap-northeast-1.amazonaws.com/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "AWS_S3 dotted bucket → path-style (virtual-host breaks TLS)",
		provider: "AWS_S3",
		config: { region: "ap-northeast-1" },
		bucket: "cdn.example.com",
		acl: "PUBLIC_READ",
		url: "https://s3.ap-northeast-1.amazonaws.com/cdn.example.com/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "AWS_S3_ROLE_BASED derives the same shape as key-based",
		provider: "AWS_S3_ROLE_BASED",
		config: { region: "us-east-2", roleArn: "arn:aws:iam::1:role/x" },
		bucket: "out-bucket",
		acl: "PUBLIC_READ",
		url: "https://out-bucket.s3.us-east-2.amazonaws.com/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "AWS_S3 without an ACL is not public",
		provider: "AWS_S3",
		config: { region: "ap-northeast-1" },
		bucket: "out-bucket",
		url: null,
		via: "none",
		reason: "NOT_PUBLIC",
	},
	{
		name: "AWS_S3 with an explicit PRIVATE ACL is not public",
		provider: "AWS_S3",
		config: { region: "ap-northeast-1" },
		bucket: "out-bucket",
		acl: "PRIVATE",
		url: null,
		via: "none",
		reason: "NOT_PUBLIC",
	},
	{
		name: "AWS_S3 public-read but region-less → named config gap, not a guess",
		field: "region",
		provider: "AWS_S3",
		config: {},
		bucket: "out-bucket",
		acl: "PUBLIC_READ",
		url: null,
		via: "none",
		reason: "MISSING_CONFIG",
	},
	{
		name: "Akamai → path-style on the cluster host (C10)",
		provider: "AKAMAI_OBJECT_STORAGE",
		config: { host: "jp-osa-1.linodeobjects.com" },
		bucket: "bm-input",
		acl: "PUBLIC_READ",
		url: "https://jp-osa-1.linodeobjects.com/bm-input/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "Akamai keeps path-style for a dotted bucket too",
		provider: "AKAMAI_OBJECT_STORAGE",
		config: { host: "jp-osa-1.linodeobjects.com" },
		bucket: "cdn.example.com",
		acl: "PUBLIC_READ",
		url: "https://jp-osa-1.linodeobjects.com/cdn.example.com/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "GENERIC_S3 over https with a port",
		provider: "GENERIC_S3",
		config: { host: "s3.example.com", port: 8443 },
		bucket: "out",
		acl: "PUBLIC_READ",
		url: "https://s3.example.com:8443/out/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "GENERIC_S3 with ssl:false yields http and says so",
		provider: "GENERIC_S3",
		config: { host: "minio.internal", port: 9000, ssl: false },
		bucket: "out",
		acl: "PUBLIC_READ",
		url: "http://minio.internal:9000/out/output/run-1/stream.m3u8",
		via: "derived",
		reason: "INSECURE_ENDPOINT",
	},
	{
		name: "GENERIC_S3 without a host → named config gap",
		field: "host",
		provider: "GENERIC_S3",
		config: {},
		bucket: "out",
		acl: "PUBLIC_READ",
		url: null,
		via: "none",
		reason: "MISSING_CONFIG",
	},
	{
		name: "GCS HMAC → path-style on storage.googleapis.com",
		provider: "GCS_HMAC",
		bucket: "gcs-out",
		acl: "PUBLIC_READ",
		url: "https://storage.googleapis.com/gcs-out/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "GCS service account → the same public shape",
		provider: "GCS_SERVICE_ACCOUNT",
		bucket: "gcs-out",
		acl: "PUBLIC_READ",
		url: "https://storage.googleapis.com/gcs-out/output/run-1/stream.m3u8",
		via: "derived",
	},
	{
		name: "OCI derives nothing even when public-read — compat needs auth",
		provider: "OCI_OBJECT_STORAGE",
		config: { namespace: "ns1", region: "ap-osaka-1" },
		bucket: "out",
		acl: "PUBLIC_READ",
		url: null,
		via: "none",
		reason: "NO_PATTERN",
	},
	{
		name: "Azure derives nothing — an ACL cannot express a public container",
		provider: "AZURE_BLOB",
		config: { accountName: "acct" },
		bucket: "container",
		acl: "PUBLIC_READ",
		url: null,
		via: "none",
		reason: "NO_PATTERN",
	},
	{
		name: "SFTP outputs have no bucket and no HTTP address",
		provider: "SFTP",
		config: { host: "sftp.example.com", username: "u" },
		bucket: null,
		acl: "PUBLIC_READ",
		url: null,
		via: "none",
		reason: "NO_PATTERN",
	},
];

describe("publicObjectUrl — per driver", () => {
	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = publicObjectUrl({
				credential: {
					provider: testCase.provider,
					config: testCase.config ?? {},
				},
				bucket: testCase.bucket ?? null,
				key: testCase.key ?? KEY,
				acl: testCase.acl,
			});
			expect(result.url).toBe(testCase.url);
			expect(result.via).toBe(testCase.via);
			expect(result.reason?.code).toBe(testCase.reason);
			if (testCase.field) {
				expect(
					result.reason?.code === "MISSING_CONFIG" && result.reason.field,
				).toBe(testCase.field);
			}
			// Every refusal must SAY something: a null URL with an empty reason
			// is the "generic playback error" the design exists to remove.
			if (result.url === null && result.reason) {
				expect(describePublicUrlReason(result.reason).length).toBeGreaterThan(
					20,
				);
			}
		});
	}
});

describe("publicObjectUrl — declared bases win", () => {
	const declared = (map: Record<string, string>) => ({
		provider: "AWS_S3" as const,
		config: { region: "ap-northeast-1", publicBaseUrls: map },
	});

	it("overrides the derived host", () => {
		const result = publicObjectUrl({
			credential: declared({ out: "https://cdn.example.com/vod" }),
			bucket: "out",
			key: KEY,
			acl: "PUBLIC_READ",
		});
		expect(result.url).toBe(
			"https://cdn.example.com/vod/output/run-1/stream.m3u8",
		);
		expect(result.via).toBe("publicBaseUrls");
		expect(result.reason).toBeUndefined();
	});

	it("overrides a private ACL — a CDN in front is knowledge the plan lacks", () => {
		const result = publicObjectUrl({
			credential: declared({ out: "https://cdn.example.com" }),
			bucket: "out",
			key: KEY,
			acl: "PRIVATE",
		});
		expect(result.url).toBe("https://cdn.example.com/output/run-1/stream.m3u8");
		expect(result.via).toBe("publicBaseUrls");
	});

	it("only applies to the bucket it names", () => {
		const result = publicObjectUrl({
			credential: declared({ other: "https://cdn.example.com" }),
			bucket: "out",
			key: KEY,
			acl: "PUBLIC_READ",
		});
		expect(result.url).toBe(
			"https://out.s3.ap-northeast-1.amazonaws.com/output/run-1/stream.m3u8",
		);
		expect(result.via).toBe("derived");
	});

	it("is the only way to play an Azure container", () => {
		const result = publicObjectUrl({
			credential: {
				provider: "AZURE_BLOB",
				config: {
					accountName: "acct",
					publicBaseUrls: {
						assets: "https://acct.blob.core.windows.net/assets",
					},
				},
			},
			bucket: "assets",
			key: KEY,
			acl: undefined,
		});
		expect(result.url).toBe(
			"https://acct.blob.core.windows.net/assets/output/run-1/stream.m3u8",
		);
		expect(result.via).toBe("publicBaseUrls");
	});

	it("is the escape hatch for OCI", () => {
		const result = publicObjectUrl({
			credential: {
				provider: "OCI_OBJECT_STORAGE",
				config: {
					namespace: "ns1",
					region: "ap-osaka-1",
					publicBaseUrls: { out: "https://objectstorage.example/p/tok/o" },
				},
			},
			bucket: "out",
			key: KEY,
			acl: undefined,
		});
		expect(result.url).toBe(
			"https://objectstorage.example/p/tok/o/output/run-1/stream.m3u8",
		);
	});

	it("strips trailing slashes instead of emitting a double slash", () => {
		const result = publicObjectUrl({
			credential: declared({ out: "https://cdn.example.com/vod//" }),
			bucket: "out",
			key: KEY,
			acl: "PRIVATE",
		});
		expect(result.url).toBe(
			"https://cdn.example.com/vod/output/run-1/stream.m3u8",
		);
	});

	it("flags an http base as mixed content but keeps it copyable", () => {
		const result = publicObjectUrl({
			credential: declared({ out: "http://origin.internal" }),
			bucket: "out",
			key: KEY,
			acl: "PRIVATE",
		});
		expect(result.url).toBe("http://origin.internal/output/run-1/stream.m3u8");
		expect(result.reason?.code).toBe("INSECURE_ENDPOINT");
	});

	it("refuses a base that was hand-edited into the row badly", () => {
		// The design says the map is settable by editing Postgres directly, so
		// the builder cannot lean on the form's zod validation.
		for (const bad of [
			"cdn.example.com",
			"ftp://cdn.example.com",
			"https://cdn.example.com/vod?token=x",
			"https://cdn.example.com/vod#frag",
			"",
		]) {
			const result = publicObjectUrl({
				credential: declared({ out: bad }),
				bucket: "out",
				key: KEY,
				acl: "PUBLIC_READ",
			});
			expect(result.url, bad).toBeNull();
			expect(result.reason?.code, bad).toBe("MISSING_BASE_URL");
			expect(
				result.reason && describePublicUrlReason(result.reason),
				bad,
			).toContain('publicBaseUrls["out"]');
		}
	});
});

describe("publicObjectUrl — path handling", () => {
	it("percent-encodes each segment but keeps the separators", () => {
		const result = publicObjectUrl({
			credential: { provider: "AWS_S3", config: { region: "eu-west-1" } },
			bucket: "out",
			key: "my dir/stream #1.m3u8",
			acl: "PUBLIC_READ",
		});
		expect(result.url).toBe(
			"https://out.s3.eu-west-1.amazonaws.com/my%20dir/stream%20%231.m3u8",
		);
	});

	it("does not double the slash when the key is rooted", () => {
		const result = publicObjectUrl({
			credential: {
				provider: "AWS_S3",
				config: {
					region: "eu-west-1",
					publicBaseUrls: { out: "https://cdn.example.com" },
				},
			},
			bucket: "out",
			key: "/a/b.m3u8",
			acl: "PUBLIC_READ",
		});
		expect(result.url).toBe("https://cdn.example.com/a/b.m3u8");
	});

	it("names a missing credential rather than returning a bare null", () => {
		const result = publicObjectUrl({
			credential: undefined,
			bucket: "out",
			key: KEY,
			acl: "PUBLIC_READ",
		});
		expect(result.url).toBeNull();
		expect(result.reason?.code).toBe("NO_CREDENTIAL");
	});
});

describe("publicObjectUrl — a bucket named after a prototype key", () => {
	it("derives normally when no base is declared for it", () => {
		/**
		 * `constructor` is a valid S3 bucket name. Indexing the declared-base map
		 * with it used to return `Function.prototype.constructor`, so this bucket
		 * reported `MISSING_BASE_URL` — an error about a map entry that does not
		 * exist — instead of deriving its ordinary S3 URL.
		 */
		const result = publicObjectUrl({
			credential: { provider: "AWS_S3", config: { region: "eu-west-1" } },
			bucket: "constructor",
			key: "out/stream.m3u8",
			acl: "PUBLIC_READ",
		});
		expect(result.reason).toBeUndefined();
		expect(result.url).toBe(
			"https://constructor.s3.eu-west-1.amazonaws.com/out/stream.m3u8",
		);
	});

	it("honours a base genuinely declared for such a bucket", () => {
		const result = publicObjectUrl({
			credential: {
				provider: "AWS_S3",
				config: {
					region: "eu-west-1",
					publicBaseUrls: { constructor: "https://cdn.example.com" },
				},
			},
			bucket: "constructor",
			key: "out/stream.m3u8",
			acl: "PRIVATE",
		});
		expect(result.via).toBe("publicBaseUrls");
		expect(result.url).toBe("https://cdn.example.com/out/stream.m3u8");
	});
});

describe("mslEdgeManifestUrl — the AKAMAI_MSL entry point (2026-09-02)", () => {
	const ROOT =
		"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821";
	const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000003";
	const withEdge = {
		id: CREDENTIAL_ID,
		provider: "AKAMAI_MSL" as const,
		config: {
			streamId: 2126636,
			eventName: "bitmovinhlsjp20260821",
			edgeBaseUrl: ROOT,
		},
	};

	it("appends ONLY the manifest name to the credential's edge root — the measured MSL4 master", () => {
		expect(
			mslEdgeManifestUrl({ credential: withEdge, manifestName: "stream.m3u8" }),
		).toEqual({ url: `${ROOT}/stream.m3u8`, via: "credential-edge" });
	});

	it("names the credential when no edge root is declared, so the panel can send the operator to it", () => {
		for (const config of [
			{ streamId: 2126636, eventName: "ev" },
			{ streamId: 2126636, eventName: "ev", edgeBaseUrl: "" },
			{ streamId: 2126636, eventName: "ev", edgeBaseUrl: "   " },
			{ streamId: 2126636, eventName: "ev", edgeBaseUrl: 42 },
		]) {
			expect(
				mslEdgeManifestUrl({
					credential: { id: CREDENTIAL_ID, provider: "AKAMAI_MSL", config },
					manifestName: "stream.m3u8",
				}),
			).toEqual({
				url: null,
				via: "none",
				reason: {
					code: "MSL_EDGE_URL_NOT_CONFIGURED",
					credentialId: CREDENTIAL_ID,
				},
			});
		}
	});

	it("is NO_CREDENTIAL when the row is gone — not 'not configured', which would name a row that does not exist", () => {
		expect(
			mslEdgeManifestUrl({
				credential: undefined,
				manifestName: "stream.m3u8",
			}),
		).toEqual({ url: null, via: "none", reason: { code: "NO_CREDENTIAL" } });
	});

	it("tolerates a hand-edited trailing slash and percent-encodes the manifest name", () => {
		expect(
			mslEdgeManifestUrl({
				credential: {
					...withEdge,
					config: { ...withEdge.config, edgeBaseUrl: `${ROOT}/` },
				},
				manifestName: "stream.m3u8",
			}).url,
		).toBe(`${ROOT}/stream.m3u8`);
		expect(
			mslEdgeManifestUrl({
				credential: withEdge,
				manifestName: "my stream.m3u8",
			}).url,
		).toBe(`${ROOT}/my%20stream.m3u8`);
	});

	it("keeps the INSECURE_ENDPOINT rail for a hand-edited http root", () => {
		const result = mslEdgeManifestUrl({
			credential: {
				...withEdge,
				config: {
					...withEdge.config,
					edgeBaseUrl: "http://x.akamaized.net/ev",
				},
			},
			manifestName: "stream.m3u8",
		});
		expect(result.url).toBe("http://x.akamaized.net/ev/stream.m3u8");
		expect(result.reason).toEqual({ code: "INSECURE_ENDPOINT" });
	});

	it("describes the not-configured reason in English, naming the credential", () => {
		expect(
			describePublicUrlReason({
				code: "MSL_EDGE_URL_NOT_CONFIGURED",
				credentialId: CREDENTIAL_ID,
			}),
		).toContain(CREDENTIAL_ID);
	});
});
