import { describe, expect, it, vi } from "vitest";

const clientConfigs: Record<string, unknown>[] = [];
/**
 * Middleware names registered per constructed client, one entry per client.
 *
 * The mock used to stub `middlewareStack` with a bare `vi.fn` — enough to
 * stop the constructor throwing and nothing more, which left "AWS is
 * untouched" asserted only in a comment. A reviewer flipped the guard to
 * always-on and all 82 tests stayed green. Recording what gets registered
 * turns the accommodation into an instrument.
 */
const clientMiddleware: string[][] = [];
const getObjectMiddleware: string[][] = [];

/**
 * One fresh middleware-name list per constructed client.
 *
 * Deliberately NOT reset between tests the way `clientConfigs` is: readers
 * index it RELATIVELY (`clientMiddleware.at(-1)` after asserting the length
 * grew by exactly one), so a shared history is harmless. A future test
 * reaching for `clientMiddleware[0]` would read another test's client — index
 * from the end, or add the reset.
 */
function registerClient(): string[] {
	const names: string[] = [];
	clientMiddleware.push(names);
	return names;
}

vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: class {
		constructor(config: Record<string, unknown>) {
			clientConfigs.push(config);
		}
		send = vi.fn();
		// What the middleware DOES is pinned in `s3-x-id.test.ts` against a
		// signature-verifying server — a mocked stack cannot show that. What it
		// can show is WHICH clients get it, which is the half that was
		// unpinned.
		names: string[] = registerClient();
		middlewareStack = {
			add: (_mw: unknown, options: { name?: string }) => {
				this.names.push(options?.name ?? "(unnamed)");
			},
		};
	},
	ListBucketsCommand: class {},
	ListObjectsV2Command: class {},
	GetObjectCommand: class {
		constructor(readonly input: unknown) {
			getObjectMiddleware.push(this.names);
		}
		names: string[] = [];
		middlewareStack = {
			addRelativeTo: (_mw: unknown, options: { name?: string }) => {
				this.names.push(options?.name ?? "(unnamed)");
			},
		};
	},
}));

const gcsConfigs: unknown[] = [];
vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		constructor(readonly config: unknown) {
			gcsConfigs.push(config);
		}
	},
}));

const azureUrls: string[] = [];
const azureOptions: unknown[] = [];

vi.mock("@azure/storage-blob", () => ({
	BlobServiceClient: class {
		constructor(url: string, _credential: unknown, options: unknown) {
			azureUrls.push(url);
			azureOptions.push(options);
		}
	},
	StorageSharedKeyCredential: class {},
}));

import {
	CREDENTIAL_PROVIDER_BROWSABLE,
	CREDENTIAL_PROVIDERS,
} from "@bitovp/core";
import { createBrowserForCredential } from "./factory";
import { UnsupportedBrowseError } from "./types";

const secret = { accessKeyId: "a", secretAccessKey: "s" };

describe("createBrowserForCredential", () => {
	it.each([
		"AWS_S3",
		"AKAMAI_OBJECT_STORAGE",
		"GCS_HMAC",
	] as const)("propagates readiness timeout to %s without changing endpoint handling", (provider) => {
		createBrowserForCredential(
			{
				provider,
				config: { host: "jp-osa-1.linodeobjects.com", region: "us-east-1" },
				secret,
			},
			{ readTimeoutMs: 5000 },
		);
		expect(clientConfigs.at(-1)).toMatchObject({
			maxAttempts: 1,
			requestHandler: { requestTimeout: 5000 },
		});
	});
	it("propagates readiness timeout to native GCS and Azure", () => {
		createBrowserForCredential(
			{
				provider: "GCS_SERVICE_ACCOUNT",
				config: {},
				secret: {
					serviceAccountJson: JSON.stringify({
						client_email: "test",
						private_key: "fixture",
					}),
				},
			},
			{ readTimeoutMs: 5000 },
		);
		expect(gcsConfigs.at(-1)).toMatchObject({
			timeout: 5000,
			retryOptions: { autoRetry: false },
		});
		createBrowserForCredential(
			{
				provider: "AZURE_BLOB",
				config: { accountName: "test" },
				secret: { accountKey: "fixture" },
			},
			{ readTimeoutMs: 5000 },
		);
		expect(azureOptions.at(-1)).toMatchObject({
			retryOptions: { maxTries: 1, tryTimeoutInMs: 5000 },
		});
	});
	it("derives the Akamai signing region from the host (C10)", () => {
		clientConfigs.length = 0;
		createBrowserForCredential({
			provider: "AKAMAI_OBJECT_STORAGE",
			config: { host: "jp-osa-1.linodeobjects.com" },
			secret,
		});
		expect(clientConfigs[0]).toMatchObject({
			region: "jp-osa-1",
			endpoint: "https://jp-osa-1.linodeobjects.com",
			forcePathStyle: true,
		});
	});

	it("builds the OCI compat endpoint with path-style (C10)", () => {
		clientConfigs.length = 0;
		createBrowserForCredential({
			provider: "OCI_OBJECT_STORAGE",
			config: { namespace: "ns1", region: "ap-osaka-1" },
			secret,
		});
		expect(clientConfigs[0]).toMatchObject({
			region: "ap-osaka-1",
			endpoint: "https://ns1.compat.objectstorage.ap-osaka-1.oraclecloud.com",
			forcePathStyle: true,
		});
	});

	it("honors GENERIC_S3 scheme/port settings", () => {
		clientConfigs.length = 0;
		createBrowserForCredential({
			provider: "GENERIC_S3",
			config: { host: "minio.internal", port: 9000, ssl: false },
			secret,
		});
		expect(clientConfigs[0]).toMatchObject({
			endpoint: "http://minio.internal:9000",
		});
	});

	it("routes GCS HMAC through the S3 interop endpoint", () => {
		clientConfigs.length = 0;
		createBrowserForCredential({
			provider: "GCS_HMAC",
			config: {},
			secret: { accessKey: "GOOG1", secret: "hmac" },
		});
		expect(clientConfigs[0]).toMatchObject({
			endpoint: "https://storage.googleapis.com",
			credentials: { accessKeyId: "GOOG1", secretAccessKey: "hmac" },
		});
	});

	it("builds the Azure blob endpoint from accountName + accountKey", () => {
		azureUrls.length = 0;
		createBrowserForCredential({
			provider: "AZURE_BLOB",
			config: { accountName: "acct" },
			secret: { accountKey: "a2V5" },
		});
		expect(azureUrls[0]).toBe("https://acct.blob.core.windows.net");
	});

	it("refuses providers that cannot browse yet", () => {
		// Role-based still needs an STS broker; an Azure credential with no key
		// is refused by the driver rather than 403ing on the first request.
		expect(() =>
			createBrowserForCredential({
				provider: "AWS_S3_ROLE_BASED",
				config: {},
				secret: {},
			}),
		).toThrow(UnsupportedBrowseError);
		expect(() =>
			createBrowserForCredential({
				provider: "AZURE_BLOB",
				config: {},
				secret: {},
			}),
		).toThrow(UnsupportedBrowseError);
	});

	it("refuses live ingest secret providers (nothing to browse)", () => {
		for (const provider of ["SRT_PASSPHRASE", "ZIXI"] as const) {
			expect(() =>
				createBrowserForCredential({ provider, config: {}, secret: {} }),
			).toThrow(UnsupportedBrowseError);
		}
	});
});
/**
 *  — the STORAGE_ENDPOINT_ALLOWED_HOSTS rail: GENERIC_S3 is the
 * one provider whose endpoint is a free field, i.e. the SSRF reach C22
 * names. The rail refuses unlisted hosts at the point of use; the other
 * providers' hosts are derived or schema-anchored and pass untouched.
 */
describe("ledger #28 — GENERIC_S3 endpoint allowlist", () => {
	const generic = (host: string) => ({
		provider: "GENERIC_S3" as const,
		config: { host, ssl: true },
		secret: { accessKeyId: "a", secretAccessKey: "s" },
	});

	it("UNCONFIGURED (undefined) constructs but WARNS — existing deployments keep working", () => {
		const warnings: string[] = [];
		const browser = createBrowserForCredential(generic("minio.internal"), {
			endpointAllowlist: undefined,
			onWarning: (m) => warnings.push(m),
		});
		expect(browser).toBeTruthy();
		expect(warnings.join(" ")).toContain("STORAGE_ENDPOINT_ALLOWED_HOSTS");
		expect(warnings.join(" ")).toContain("minio.internal");
	});

	it("a listed host constructs — exact match and .suffix both work", () => {
		expect(
			createBrowserForCredential(generic("minio.internal"), {
				endpointAllowlist: ["minio.internal"],
			}),
		).toBeTruthy();
		expect(
			createBrowserForCredential(generic("s3.eu.vendor.example"), {
				endpointAllowlist: [".vendor.example"],
			}),
		).toBeTruthy();
	});

	it("an UNLISTED host is refused — the request is never made", () => {
		expect(() =>
			createBrowserForCredential(generic("169.254.169.254"), {
				endpointAllowlist: ["minio.internal"],
			}),
		).toThrowError(/STORAGE_ENDPOINT_ALLOWED_HOSTS/);
	});

	it("the rail does not touch derived-host providers", () => {
		const browser = createBrowserForCredential(
			{
				provider: "AKAMAI_OBJECT_STORAGE",
				config: { host: "jp-osa-1.linodeobjects.com" },
				secret: { accessKeyId: "a", secretAccessKey: "s" },
			},
			{ endpointAllowlist: ["something.else"] },
		);
		expect(browser).toBeTruthy();
	});
});

/**
 * , REOPENED and closed the other way on 2026-08-19.
 *
 * This block used to assert that Akamai Object Storage and GCS-HMAC REFUSE
 * bucket enumeration, each with a confident reason: Akamai's "measured, 403
 * under both signing regions", GCS-HMAC's "structural, the XML API needs a
 * project id the S3 protocol cannot carry". Both were wrong, and the tests
 * pinned the wrongness in place.
 *
 * The cause was one query parameter WE sent — `?x-id=<Operation>`, added by
 * aws-sdk-js and refused by both stores on the SERVICE-LEVEL request. The AWS
 * CLI and s3cmd listed the buckets our client got a 403 on, with the same keys
 * against the same endpoint, which is what settled whose defect it was.
 *
 * NOT "Ceph-derived stores exclude it when recomputing the signature". That
 * story was written here first and it is refuted by two things in the same
 * evidence: `GetObject` carries `x-id` too and both stores ACCEPT it (276 MB
 * from Akamai, 614 bytes from GCS, with the parameter present), and GCS failed
 * with 400 InvalidArgument, which a signature mismatch cannot produce. One
 * mechanism cannot explain two incompatible error codes. Why the two differ is
 * unknown; see `s3.ts`. Both providers now enumerate: Akamai 3 buckets, GCS 69,
 * measured .
 *
 * These tests are kept, inverted, because the refusal could come back by
 * accident — a re-added wrapper, or the middleware dropped.
 */
describe("bucket enumeration is available to every S3-speaking provider (ledger #112)", () => {
	it.each([
		["AKAMAI_OBJECT_STORAGE", { host: "jp-osa-1.linodeobjects.com" }],
		["GCS_HMAC", {}],
		["AWS_S3", { region: "ap-northeast-1" }],
		["GENERIC_S3", { host: "s3.example.com" }],
		["OCI_OBJECT_STORAGE", { namespace: "ns", region: "ap-tokyo-1" }],
	] as const)("%s does not REFUSE listBuckets", async (provider, config) => {
		const browser = createBrowserForCredential({
			provider,
			config,
			secret:
				provider === "GCS_HMAC" ? { accessKey: "a", secret: "s" } : secret,
		});
		// The mocked send resolves undefined, so the real driver's parse step
		// throws a TypeError. Asserting THAT class is the point: it proves the
		// call reached the driver. `rejects.not.toBeInstanceOf(...)` would pass
		// for any error at all, including a differently-worded refusal.
		await expect(browser.listBuckets()).rejects.toBeInstanceOf(TypeError);
	});

	it("no provider carries a refusal message about entering the bucket by hand", async () => {
		// The two removed reasons both ended "enter the bucket name manually".
		// If either wrapper is reinstated, this finds it by its own words.
		for (const [provider, config] of [
			["AKAMAI_OBJECT_STORAGE", { host: "jp-osa-1.linodeobjects.com" }],
			["GCS_HMAC", {}],
		] as const) {
			const browser = createBrowserForCredential({
				provider,
				config,
				secret:
					provider === "GCS_HMAC" ? { accessKey: "a", secret: "s" } : secret,
			});
			await expect(browser.listBuckets()).rejects.not.toThrow(
				/enter the bucket name manually/,
			);
		}
	});

	it("object listing still reaches the driver — the fix did not trade one for the other", async () => {
		const browser = createBrowserForCredential({
			provider: "AKAMAI_OBJECT_STORAGE",
			config: { host: "jp-osa-1.linodeobjects.com" },
			secret,
		});
		await expect(
			browser.listObjects({ bucket: "b", prefix: "" }),
		).rejects.toBeInstanceOf(TypeError);
	});
});

describe("the UI's browsable list agrees with this factory, per provider", () => {
	/**
	 * `CREDENTIAL_PROVIDER_BROWSABLE` lives in core because a client component
	 * cannot import this file (it pulls in the cloud SDKs). Two copies of one
	 * answer drift, so this is the joint: the factory is the authority and core
	 * merely restates it.
	 *
	 * The failure this prevents is not cosmetic. The watch-folder picker offered
	 * every provider, so a Kantar login could be chosen as a folder to sweep —
	 * accepted at the click, then thrown by this factory on every sweep tick
	 * until the rule backed off to its 15-minute cap.
	 */
	it("claims browsable for exactly the providers this factory can build", () => {
		const disagreements: string[] = [];
		for (const provider of CREDENTIAL_PROVIDERS) {
			let factorySaysBrowsable: boolean;
			try {
				createBrowserForCredential({
					provider,
					// Enough shape for the browsable branches to construct; the
					// unbrowsable ones throw before reading any of it.
					config: {
						host: "example.linodeobjects.com",
						region: "us-east-1",
						bucket: "b",
						accountName: "acct",
						namespace: "ns",
					},
					secret: {
						accessKey: "a",
						secret: "s",
						accountKey: "k",
						serviceAccountJson: '{"client_email":"x","private_key":"y"}',
					},
				});
				factorySaysBrowsable = true;
			} catch (error) {
				// Only a REFUSAL counts as "not browsable" — a construction error
				// from the dummy config above would otherwise read as one, and
				// every provider would silently agree.
				if (!(error instanceof UnsupportedBrowseError)) throw error;
				factorySaysBrowsable = false;
			}
			if (factorySaysBrowsable !== CREDENTIAL_PROVIDER_BROWSABLE[provider]) {
				disagreements.push(
					`${provider}: factory=${factorySaysBrowsable}, core=${CREDENTIAL_PROVIDER_BROWSABLE[provider]}`,
				);
			}
		}
		expect(
			disagreements,
			"core's CREDENTIAL_PROVIDER_BROWSABLE no longer matches this factory",
		).toEqual([]);
	});

	it("covers every provider, so the loop cannot pass over an empty set", () => {
		expect(Object.keys(CREDENTIAL_PROVIDER_BROWSABLE).sort()).toEqual(
			[...CREDENTIAL_PROVIDERS].sort(),
		);
	});
});

describe("the x-id strip is registered only for custom endpoints", () => {
	/**
	 * `x-id` is AWS's own marker and S3 handles it correctly, so plain AWS must
	 * not get the middleware. That was true and asserted nowhere: flipping the
	 * guard to always-on left the whole suite green (reviewer's MUT-C).
	 */
	const STRIP = "stripXIdForS3Compatible";

	function middlewareFor(
		provider: Parameters<typeof createBrowserForCredential>[0]["provider"],
		config: Record<string, unknown>,
	): string[] {
		const before = clientMiddleware.length;
		createBrowserForCredential({
			provider,
			config,
			secret:
				provider === "GCS_HMAC" ? { accessKey: "a", secret: "s" } : secret,
		});
		// One client per call; anything else means the factory changed shape
		// and this test is reading someone else's registrations.
		expect(clientMiddleware.length).toBe(before + 1);
		return clientMiddleware.at(-1) as string[];
	}

	it("registers it for every S3-compatible provider", () => {
		for (const [provider, config] of [
			["AKAMAI_OBJECT_STORAGE", { host: "jp-osa-1.linodeobjects.com" }],
			["GCS_HMAC", {}],
			["GENERIC_S3", { host: "s3.example.com" }],
			["OCI_OBJECT_STORAGE", { namespace: "ns", region: "ap-tokyo-1" }],
		] as const) {
			expect(middlewareFor(provider, config), provider).toContain(STRIP);
		}
	});

	it("does NOT register it for plain AWS", () => {
		expect(middlewareFor("AWS_S3", { region: "ap-northeast-1" })).not.toContain(
			STRIP,
		);
	});
});

describe("GCS range checksum interoperability", () => {
	it.each([
		["GCS_HMAC", {}, true],
		["AWS_S3", { region: "us-east-1" }, false],
		["AKAMAI_OBJECT_STORAGE", { host: "jp-osa-1.linodeobjects.com" }, false],
		["GENERIC_S3", { host: "s3.example.com" }, false],
		["OCI_OBJECT_STORAGE", { namespace: "ns", region: "ap-tokyo-1" }, false],
	] as const)("limits the whole-object range checksum exception to %s", async (provider, config, enabled) => {
		const browser = createBrowserForCredential({
			provider,
			config,
			secret:
				provider === "GCS_HMAC" ? { accessKey: "a", secret: "s" } : secret,
		});
		await expect(
			browser.getObject?.({
				bucket: "b",
				key: "k",
				range: { start: 0, end: 3 },
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(
			getObjectMiddleware
				.at(-1)
				?.includes("omitWholeObjectChecksumForGcsRange"),
		).toBe(enabled);
	});
});
