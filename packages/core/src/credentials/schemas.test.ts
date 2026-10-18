import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_GROUPS,
	CREDENTIAL_PROVIDER_GROUP,
	CREDENTIAL_PROVIDER_LABELS,
	CREDENTIAL_PROVIDERS,
	createCredentialSchema,
	ociCompatHost,
	updateCredentialSchema,
} from "./schemas";

const VALID_CASES = [
	{
		name: "AWS_S3",
		input: {
			provider: "AWS_S3",
			label: "prod",
			config: { region: "ap-northeast-1" },
			secret: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s" },
		},
	},
	{
		name: "AWS_S3_ROLE_BASED without secret material",
		input: {
			provider: "AWS_S3_ROLE_BASED",
			label: "role",
			config: {
				roleArn: "arn:aws:iam::123456789012:role/bitmovin",
				region: "us-east-1",
			},
		},
	},
	{
		name: "AKAMAI_OBJECT_STORAGE",
		input: {
			provider: "AKAMAI_OBJECT_STORAGE",
			label: "akamai",
			config: { host: "jp-osa-1.linodeobjects.com" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "OCI_OBJECT_STORAGE",
		input: {
			provider: "OCI_OBJECT_STORAGE",
			label: "oci",
			config: { namespace: "axaxnpcrorw5", region: "ap-osaka-1" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "GENERIC_S3 with port",
		input: {
			provider: "GENERIC_S3",
			label: "minio",
			config: { host: "minio.internal", port: 9000, ssl: false },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "GCS_HMAC",
		input: {
			provider: "GCS_HMAC",
			label: "gcs",
			secret: { accessKey: "GOOG1EXAMPLE", secret: "s" },
		},
	},
	{
		name: "GCS_SERVICE_ACCOUNT",
		input: {
			provider: "GCS_SERVICE_ACCOUNT",
			label: "gcs-sa",
			secret: {
				serviceAccountJson: JSON.stringify({
					type: "service_account",
					client_email: "x@p.iam.gserviceaccount.com",
					private_key: "-----BEGIN PRIVATE KEY-----…",
				}),
			},
		},
	},
	{
		name: "AZURE_BLOB",
		input: {
			provider: "AZURE_BLOB",
			label: "az",
			config: { accountName: "mystorage" },
			secret: { accountKey: "k" },
		},
	},
	{
		name: "SRT_PASSPHRASE with a 16-char passphrase (AES-128)",
		input: {
			provider: "SRT_PASSPHRASE",
			label: "srt-128",
			secret: { passphrase: "0123456789abcdef" },
		},
	},
	{
		name: "SRT_PASSPHRASE with a 32-char passphrase (AES-256)",
		input: {
			provider: "SRT_PASSPHRASE",
			label: "srt-256",
			secret: { passphrase: "0123456789abcdef0123456789abcdef" },
		},
	},
	{
		name: "ZIXI with password only",
		input: {
			provider: "ZIXI",
			label: "zixi-pw",
			secret: { password: "zixi-secret" },
		},
	},
	{
		name: "ZIXI with decryptionKey only",
		input: {
			provider: "ZIXI",
			label: "zixi-dk",
			secret: { decryptionKey: "0123456789abcdef" },
		},
	},
	/**
	 * The AKAMAI_MSL Digest pair —  PR 1. THREE legal states, and
	 * the empty one is the load-bearing arm: MSL4 credentials carry no pair and
	 * stay the incumbent until MSL4's EOL 2026-12-31, so a required pair would
	 * make every existing AKAMAI_MSL row unsaveable. The `.refine` is
	 * both-or-neither, which is neither of this file's two live precedents —
	 * POIS requires both halves, ZIXI requires at least one.
	 */
	{
		name: "AKAMAI_MSL with NO Digest pair — every MSL4 credential today",
		input: {
			provider: "AKAMAI_MSL",
			label: "msl4-no-pair",
			config: { streamId: 2126636, eventName: "ev" },
			secret: {},
		},
	},
	{
		name: "AKAMAI_MSL with the Digest pair omitted entirely",
		input: {
			provider: "AKAMAI_MSL",
			label: "msl4-absent",
			config: { streamId: 2126636, eventName: "ev" },
		},
	},
	{
		name: "AKAMAI_MSL with BOTH Digest halves",
		input: {
			provider: "AKAMAI_MSL",
			label: "msl5-pair",
			config: { streamId: 2126636, eventName: "ev" },
			secret: { username: "pub", password: "S3gm3nt" },
		},
	},
	/**
	 * The delivery edge base URL (2026-09-02): optional, https-only, the event
	 * root with no trailing slash. The measured MSL4 Production root, a customer
	 * CNAME, and an MSL5-shaped root are all legal — the field is about the
	 * URL's shape, never the path's meaning.
	 */
	{
		name: "AKAMAI_MSL with the measured MSL4 Production edge root",
		input: {
			provider: "AKAMAI_MSL",
			label: "msl4-edge",
			config: {
				streamId: 2126636,
				eventName: "bitmovinhlsjp20260821",
				edgeBaseUrl:
					"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821",
			},
		},
	},
	{
		name: "AKAMAI_MSL (MSL5, Digest pair) with a Control Center edge root",
		input: {
			provider: "AKAMAI_MSL",
			label: "msl5-edge",
			config: {
				streamId: 20001601,
				eventName: "ev",
				edgeBaseUrl: "https://live.example.com/msl5/20001601/ev",
			},
			secret: { username: "pub", password: "S3gm3nt" },
		},
	},
	{
		name: "ZIXI with both password and decryptionKey",
		input: {
			provider: "ZIXI",
			label: "zixi-both",
			secret: { password: "pw", decryptionKey: "dk" },
		},
	},
	{
		name: "POIS_ENDPOINT with a username + password pair",
		input: {
			provider: "POIS_ENDPOINT",
			label: "pois",
			secret: { username: "esam-operator", password: "pois-secret" },
		},
	},
] as const;

const INVALID_CASES = [
	{
		name: "unknown provider",
		input: { provider: "FTP", label: "x", config: {}, secret: {} },
	},
	{
		name: "Akamai host without linodeobjects suffix (C10)",
		input: {
			provider: "AKAMAI_OBJECT_STORAGE",
			label: "x",
			config: { host: "s3.amazonaws.com" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "Akamai bare suffix without region",
		input: {
			provider: "AKAMAI_OBJECT_STORAGE",
			label: "x",
			config: { host: ".linodeobjects.com" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "Akamai bucket-qualified host (would poison region derivation)",
		input: {
			provider: "AKAMAI_OBJECT_STORAGE",
			label: "x",
			config: { host: "my-bucket.jp-osa-1.linodeobjects.com" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		},
	},
	{
		name: "role ARN that is not an IAM role",
		input: {
			provider: "AWS_S3_ROLE_BASED",
			label: "x",
			config: { roleArn: "arn:aws:s3:::bucket", region: "us-east-1" },
		},
	},
	{
		name: "service account JSON missing private_key",
		input: {
			provider: "GCS_SERVICE_ACCOUNT",
			label: "x",
			secret: {
				serviceAccountJson: JSON.stringify({ client_email: "x@y" }),
			},
		},
	},
	{
		name: "empty AWS secret",
		input: {
			provider: "AWS_S3",
			label: "x",
			config: { region: "us-east-1" },
			secret: { accessKeyId: "", secretAccessKey: "" },
		},
	},
	{
		name: "SRT passphrase of 15 chars (not an AES key length)",
		input: {
			provider: "SRT_PASSPHRASE",
			label: "x",
			secret: { passphrase: "0123456789abcde" },
		},
	},
	{
		name: "SRT passphrase of 31 chars (not an AES key length)",
		input: {
			provider: "SRT_PASSPHRASE",
			label: "x",
			secret: { passphrase: "0123456789abcdef0123456789abcde" },
		},
	},
	{
		name: "empty SRT passphrase",
		input: {
			provider: "SRT_PASSPHRASE",
			label: "x",
			secret: { passphrase: "" },
		},
	},
	{
		name: "ZIXI with neither password nor decryptionKey (fails open)",
		input: { provider: "ZIXI", label: "x", secret: {} },
	},
	/**
	 * Both HALF-pair directions, because a refine written `!!a === !!b` is
	 * symmetric and a refine written `a && !b` is not — one violating fixture
	 * per direction is what tells them apart. Without these the executor
	 * resolves "a pair" from one half, sets `enabled: true`, and Bitmovin
	 * answers 400 partway through live provisioning.
	 */
	{
		name: "AKAMAI_MSL with a Digest username and no password",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: { streamId: 1, eventName: "ev" },
			secret: { username: "pub" },
		},
	},
	{
		name: "AKAMAI_MSL with a Digest password and no username",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: { streamId: 1, eventName: "ev" },
			secret: { password: "S3gm3nt" },
		},
	},
	/**
	 * The edge base URL's refusals (2026-09-02), one per rail: every viewer
	 * receives this link verbatim plus `/<manifestName>`, so a scheme, a
	 * credential, a signature, a doubled slash or a host nobody outside the
	 * operator's network can reach must be refused at save, not discovered by
	 * a player.
	 */
	{
		name: "AKAMAI_MSL edge base URL over plain http",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "http://x.akamaized.net/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL carrying a query (a signed playback URL)",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://x.akamaized.net/hls/live/1/ev?hdnts=abc",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL carrying a fragment",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://x.akamaized.net/hls/live/1/ev#top",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL embedding userinfo",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://user:pass@x.akamaized.net/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL with a trailing slash (would double against the manifest name)",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://x.akamaized.net/hls/live/1/ev/",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL on localhost",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://localhost/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL on a private-range IP literal",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://192.168.0.10/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL on a link-local IP literal",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://169.254.169.254/hls/live/1/ev",
			},
		},
	},
	/**
	 * IPv4-mapped IPv6 at the DOOR (rev401 R2): the URL parser hands the
	 * schema `[::ffff:7f00:1]`, not the dotted quad the operator typed, and the
	 * first cut's dotted-only regex admitted every one of these.
	 */
	{
		name: "AKAMAI_MSL edge base URL on an IPv4-mapped loopback literal (dotted)",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://[::ffff:127.0.0.1]/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL on an IPv4-mapped private literal (hex, as serialised)",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://[::ffff:a00:1]/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL on a CGNAT literal",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "https://100.64.0.1/hls/live/1/ev",
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL longer than 512 characters",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: `https://x.akamaized.net/${"a".repeat(500)}`,
			},
		},
	},
	{
		name: "AKAMAI_MSL edge base URL that is not a URL",
		input: {
			provider: "AKAMAI_MSL",
			label: "x",
			config: {
				streamId: 1,
				eventName: "ev",
				edgeBaseUrl: "bitmovinmsl4hlsjp.akamaized.net/hls/live/1/ev",
			},
		},
	},
	{
		name: "ZIXI with empty-string password only",
		input: { provider: "ZIXI", label: "x", secret: { password: "" } },
	},
	{
		name: "POIS_ENDPOINT missing the password half",
		input: {
			provider: "POIS_ENDPOINT",
			label: "x",
			secret: { username: "esam-operator" },
		},
	},
	{
		name: "POIS_ENDPOINT missing the username half (vaulted too — KANTAR precedent)",
		input: {
			provider: "POIS_ENDPOINT",
			label: "x",
			secret: { password: "pois-secret" },
		},
	},
	{
		name: "POIS_ENDPOINT with empty-string halves (would fail open)",
		input: {
			provider: "POIS_ENDPOINT",
			label: "x",
			secret: { username: "", password: "" },
		},
	},
] as const;

describe("createCredentialSchema", () => {
	for (const tc of VALID_CASES) {
		it(`accepts ${tc.name}`, () => {
			const parsed = createCredentialSchema.parse(tc.input);
			expect(parsed.provider).toBe(tc.input.provider);
		});
	}

	for (const tc of INVALID_CASES) {
		it(`rejects ${tc.name}`, () => {
			expect(createCredentialSchema.safeParse(tc.input).success).toBe(false);
		});
	}

	it("defaults GENERIC_S3 ssl to true", () => {
		const parsed = createCredentialSchema.parse({
			provider: "GENERIC_S3",
			label: "x",
			config: { host: "h" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		});
		expect(parsed.config).toMatchObject({ ssl: true });
	});
});

describe("the AKAMAI_MSL edge base URL (2026-09-02)", () => {
	const ROOT =
		"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821";

	it("stores the trimmed value byte-for-byte — no normalisation a player would not do", () => {
		const parsed = createCredentialSchema.parse({
			provider: "AKAMAI_MSL",
			label: "msl4",
			config: { streamId: 2126636, eventName: "ev", edgeBaseUrl: `  ${ROOT} ` },
		});
		expect(parsed.config).toEqual({
			streamId: 2126636,
			eventName: "ev",
			edgeBaseUrl: ROOT,
		});
	});

	it("leaves an existing MSL4 row's config untouched when the field is absent", () => {
		const parsed = createCredentialSchema.parse({
			provider: "AKAMAI_MSL",
			label: "msl4",
			config: { streamId: 2126636, eventName: "ev" },
		});
		expect("edgeBaseUrl" in parsed.config).toBe(false);
	});

	it("names ONE remedy per refusal, on the field's own path", () => {
		const issueFor = (edgeBaseUrl: string) => {
			const out = createCredentialSchema.safeParse({
				provider: "AKAMAI_MSL",
				label: "x",
				config: { streamId: 1, eventName: "ev", edgeBaseUrl },
			});
			if (out.success) {
				throw new Error(`expected ${edgeBaseUrl} to be refused`);
			}
			expect(out.error.issues).toHaveLength(1);
			expect(out.error.issues[0]?.path).toEqual(["config", "edgeBaseUrl"]);
			return out.error.issues[0]?.message ?? "";
		};
		expect(issueFor("http://x.akamaized.net/ev")).toMatch(/must use https/);
		expect(issueFor("https://u:p@x.akamaized.net/ev")).toMatch(
			/must not embed credentials/,
		);
		expect(issueFor("https://x.akamaized.net/ev?hdnts=1")).toMatch(
			/query or fragment/,
		);
		expect(issueFor("https://x.akamaized.net/ev/")).toMatch(
			/must not end with a slash/,
		);
		expect(issueFor("https://10.0.0.1/ev")).toMatch(/public host/);
		expect(issueFor(`https://x.akamaized.net/${"a".repeat(600)}`)).toMatch(
			/at most 512 characters/,
		);
		expect(issueFor("not a url")).toMatch(/absolute https URL/);
	});

	it("is settable and refusable through PATCH exactly as through POST", () => {
		const patch = updateCredentialSchema("AKAMAI_MSL");
		expect(
			patch.parse({
				config: { streamId: 2126636, eventName: "ev", edgeBaseUrl: ROOT },
			}).config,
		).toEqual({ streamId: 2126636, eventName: "ev", edgeBaseUrl: ROOT });
		expect(
			patch.safeParse({
				config: { streamId: 2126636, eventName: "ev", edgeBaseUrl: `${ROOT}/` },
			}).success,
		).toBe(false);
	});
});

describe("updateCredentialSchema", () => {
	it("allows partial updates without secret", () => {
		const parsed = updateCredentialSchema("AWS_S3").parse({
			label: "renamed",
		});
		expect(parsed.secret).toBeUndefined();
	});

	it("validates secret shape per provider when re-keying", () => {
		const schema = updateCredentialSchema("AZURE_BLOB");
		expect(schema.safeParse({ secret: { accountKey: "k" } }).success).toBe(
			true,
		);
		expect(
			schema.safeParse({ secret: { secretAccessKey: "wrong-shape" } }).success,
		).toBe(false);
	});

	it("keeps C10 host validation on config updates", () => {
		const schema = updateCredentialSchema("AKAMAI_OBJECT_STORAGE");
		expect(schema.safeParse({ config: { host: "bad.example" } }).success).toBe(
			false,
		);
	});

	it("keeps the AES length rule when re-keying an SRT passphrase", () => {
		const schema = updateCredentialSchema("SRT_PASSPHRASE");
		expect(
			schema.safeParse({ secret: { passphrase: "0123456789abcdef" } }).success,
		).toBe(true);
		expect(
			schema.safeParse({ secret: { passphrase: "too-short" } }).success,
		).toBe(false);
	});

	it("keeps the at-least-one rule when re-keying Zixi material", () => {
		const schema = updateCredentialSchema("ZIXI");
		expect(schema.safeParse({ secret: { password: "pw" } }).success).toBe(true);
		expect(schema.safeParse({ secret: {} }).success).toBe(false);
	});

	it("requires the full username+password pair when re-keying POIS material", () => {
		const schema = updateCredentialSchema("POIS_ENDPOINT");
		expect(
			schema.safeParse({ secret: { username: "u", password: "p" } }).success,
		).toBe(true);
		expect(schema.safeParse({ secret: { username: "u" } }).success).toBe(false);
		expect(schema.safeParse({ secret: { password: "p" } }).success).toBe(false);
	});
});

describe("ociCompatHost", () => {
	it("derives the C10 endpoint", () => {
		expect(ociCompatHost("ns1", "ap-osaka-1")).toBe(
			"ns1.compat.objectstorage.ap-osaka-1.oraclecloud.com",
		);
	});
});

describe("ledger #28 — endpoint anchoring (the SSRF reach)", () => {
	it("OCI namespace/region reject host-injection shapes", () => {
		const base = {
			label: "oci",
			provider: "OCI_OBJECT_STORAGE",
			config: { namespace: "axfoo", region: "ap-osaka-1" },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		};
		expect(createCredentialSchema.safeParse(base).success).toBe(true);
		for (const namespace of [
			"evil.com",
			"a/b",
			"a b",
			"A",
			"foo.compat.objectstorage.x",
		]) {
			expect(
				createCredentialSchema.safeParse({
					...base,
					config: { ...base.config, namespace },
				}).success,
				`namespace ${namespace} must be refused`,
			).toBe(false);
		}
		for (const region of [
			"evil.com",
			"ap-osaka-1.attacker.io",
			"x",
			"ap osaka 1",
		]) {
			expect(
				createCredentialSchema.safeParse({
					...base,
					config: { ...base.config, region },
				}).success,
				`region ${region} must be refused`,
			).toBe(false);
		}
	});

	it("GENERIC_S3 host must be a bare hostname — URLs and paths are refused", () => {
		const base = {
			label: "minio",
			provider: "GENERIC_S3",
			config: { host: "minio.internal", ssl: true },
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		};
		expect(createCredentialSchema.safeParse(base).success).toBe(true);
		// IPv4 stays legal (on-prem endpoints) — the ALLOWLIST is the rail.
		expect(
			createCredentialSchema.safeParse({
				...base,
				config: { host: "192.168.10.5" },
			}).success,
		).toBe(true);
		for (const host of [
			"http://minio.internal",
			"minio.internal/path",
			"minio.internal:9000",
			"user@minio.internal",
			"minio_internal",
			"-minio.internal",
		]) {
			expect(
				createCredentialSchema.safeParse({ ...base, config: { host } }).success,
				`host ${host} must be refused`,
			).toBe(false);
		}
	});
});

describe("every provider is classified by PURPOSE (ledger #141)", () => {
	/**
	 * The settings screen said "Storage credentials" and listed a DRM content
	 * key, two live-ingest secrets and four integration endpoints. The owner
	 * raised it twice. These arms are what stop it recurring: the grouping is
	 * exhaustive by type, and derived from the enum rather than hand-listed.
	 */
	it("classifies every provider, with no invented entries", () => {
		expect([...CREDENTIAL_PROVIDERS].sort()).toEqual(
			Object.keys(CREDENTIAL_PROVIDER_GROUP).sort(),
		);
	});

	it("uses only declared groups", () => {
		for (const [provider, group] of Object.entries(CREDENTIAL_PROVIDER_GROUP)) {
			expect(CREDENTIAL_GROUPS, provider).toContain(group);
		}
	});

	it("keeps the STORAGE group to things bytes actually land in", () => {
		// The invariant the screen's title should have expressed all along. If
		// a future provider lands here wrongly, this is where it shows.
		const storage = Object.entries(CREDENTIAL_PROVIDER_GROUP)
			.filter(([, g]) => g === "STORAGE")
			.map(([p]) => p)
			.sort();
		expect(storage).toEqual(
			[
				"AKAMAI_MSL",
				"LIVE_MEDIA_INGEST",
				"AKAMAI_NETSTORAGE",
				"AKAMAI_OBJECT_STORAGE",
				"AWS_S3",
				"AWS_S3_ROLE_BASED",
				"AZURE_BLOB",
				"GCS_HMAC",
				"GCS_SERVICE_ACCOUNT",
				"GENERIC_S3",
				"OCI_OBJECT_STORAGE",
				"SFTP",
			].sort(),
		);
	});

	it("does NOT put the DRM content key in storage", () => {
		// Stated on its own because it is the specific complaint, twice made.
		expect(CREDENTIAL_PROVIDER_GROUP.DRM_CENC).toBe("DRM");
		expect(CREDENTIAL_PROVIDER_GROUP.NOTIFICATION_WEBHOOK).toBe("INTEGRATION");
		expect(CREDENTIAL_PROVIDER_GROUP.ZIXI).toBe("LIVE_INGEST");
	});
});

/**
 * The labels ARE the UI for choosing a provider — the add-credential dialog and
 * the source step both render nothing else — so two providers reading alike is
 * a dead end for the operator, not a cosmetic slip.
 *
 * Written when `GCS_HMAC` lost its "(HMAC)" (owner, 2026-08-20): dropping a
 * qualifier is exactly the edit that can collide two rows, and dropping the
 * OTHER one would have. Derived from the enum, so a new provider is covered the
 * day it is added rather than the day someone remembers this file.
 */
describe("every provider is nameable on screen", () => {
	it("gives each one a label", () => {
		for (const provider of CREDENTIAL_PROVIDERS) {
			expect(CREDENTIAL_PROVIDER_LABELS[provider], provider).toBeTruthy();
		}
	});

	it("never shows the same words for two different providers", () => {
		const seen = new Map<string, string>();
		for (const provider of CREDENTIAL_PROVIDERS) {
			const label = CREDENTIAL_PROVIDER_LABELS[provider];
			const twin = seen.get(label);
			expect(twin, `${provider} and ${twin} both read "${label}"`).toBe(
				undefined,
			);
			seen.set(label, provider);
		}
	});

	it("keeps a prefix pair distinguishable by what FOLLOWS the prefix", () => {
		// "Google Cloud Storage" is a strict prefix of "Google Cloud Storage
		// (service account)". That is deliberate and matches `AWS S3` /
		// `AWS S3 (role-based)` — the plain one is the ordinary way in. What
		// must not happen is a prefix pair whose longer member adds only
		// whitespace or punctuation, which reads as a typo rather than a
		// variant, and which `text.includes(label)` cannot tell apart at all.
		for (const a of CREDENTIAL_PROVIDERS) {
			for (const b of CREDENTIAL_PROVIDERS) {
				if (a === b) continue;
				const short = CREDENTIAL_PROVIDER_LABELS[a];
				const long = CREDENTIAL_PROVIDER_LABELS[b];
				if (!long.startsWith(short)) continue;
				expect(
					long.slice(short.length),
					`${b} adds nothing readable to ${a}`,
				).toMatch(/\w/);
			}
		}
	});
});

/**
 * THE CREATE UNION AND THE SHAPES TABLE ARE TWO UNIVERSES —  PR 1,
 * and this guard exists because they had already diverged when I looked.
 *
 * `createCredentialSchema` is a 22-arm discriminated union that hand-writes
 * every arm's `secret`. `updateCredentialSchema` derives its from
 * `CREDENTIAL_PROVIDER_SHAPES`. Nothing connected them, so pointing the SHAPES
 * table at the new Digest schema changed the PATCH contract and left POST
 * accepting `emptyObject` — which is `z.object({})`, non-strict, so a Digest
 * pair typed into the create form was silently STRIPPED and the credential
 * saved looking configured (security F13). Two half-pair fixtures caught it;
 * without them the change would have read as landed.
 *
 * This is the same shape as M7 (the version enum vs the behavior Record) and
 * as `ENCODER_VERSION_OPTIONS` (two literals, one name) — a fact maintained in
 * two places with nothing forcing agreement. So the guard is agreement itself,
 * derived from the provider list rather than from a list of providers someone
 * remembered to add.
 *
 * TWO probes, and the second exists because the first was blind to the very
 * split that motivated this guard. `{}` catches providers whose two universes
 * disagree about an EMPTY secret — real, and not what bit here: both accepted
 * `{}`. Reverting the create arm to `emptyObject` left this describe entirely
 * green; only the two half-pair fixtures went red. A guard whose blind spot is
 * the case it was written for is worth saying out loud rather than quietly
 * widening.
 *
 * So the second probe is every secret this file's own INVALID corpus says must
 * be refused: if PATCH refuses it and POST does not, POST's arm is stale. That
 * is the direction that bit, it is derived from the corpus rather than
 * hand-listed, and it grows whenever anyone adds a fixture.
 */
describe("POST and PATCH agree about every provider's secret", () => {
	/**
	 * Config probes DERIVED from this file's own valid corpus rather than
	 * hand-written — 22 hand-written configs would be a third universe, which
	 * is the thing this guard is about.
	 */
	const CONFIG_PROBE = new Map<string, unknown>();
	for (const c of VALID_CASES) {
		const input = c.input as { provider: string; config?: unknown };
		if (!CONFIG_PROBE.has(input.provider)) {
			CONFIG_PROBE.set(input.provider, input.config ?? {});
		}
	}

	it.each(CREDENTIAL_PROVIDERS)("%s", (provider) => {
		const viaPatch = updateCredentialSchema(provider).safeParse({
			secret: {},
		}).success;
		const viaPost = createCredentialSchema.safeParse({
			provider,
			label: "probe",
			// Every arm needs its own config; an arm whose CONFIG refuses this
			// is not what we are measuring, so read the secret verdict from a
			// config-shaped probe built by the same table PATCH uses.
			config: CONFIG_PROBE.get(provider) ?? {},
			secret: {},
		});
		const secretRefused = viaPost.error?.issues.some((i) =>
			i.path.includes("secret"),
		);
		expect(
			viaPost.success || secretRefused === true || viaPatch,
			`${provider}: POST and PATCH disagree about an empty secret — the create union hand-writes its arms and the shapes table is derived, so a change to one silently misses the other`,
		).toBe(true);
		// The direction that actually bit: PATCH refusing while POST accepts
		// means POST is the stale one.
		if (!viaPatch) {
			expect(
				secretRefused,
				`${provider}: PATCH refuses an empty secret but POST accepts it — POST's arm is stale`,
			).toBe(true);
		}
	});

	/** Every secret the INVALID corpus refuses, run through BOTH doors. */
	const REFUSED_SECRETS = INVALID_CASES.map(
		(c) => c.input as { provider?: string; secret?: unknown },
	).filter(
		(i): i is { provider: string; secret: unknown } =>
			typeof i.provider === "string" &&
			i.secret !== undefined &&
			// The corpus also carries fixtures whose invalidity IS the provider
			// name — `updateCredentialSchema` has no shape for those and throws.
			// Found by running this arm, not by reading the corpus.
			(CREDENTIAL_PROVIDERS as readonly string[]).includes(i.provider),
	);

	it("a secret the corpus refuses is refused by BOTH doors, not just PATCH", () => {
		expect(
			REFUSED_SECRETS.length,
			"the invalid corpus stopped carrying secrets — this arm went inert",
		).toBeGreaterThan(4);
		for (const { provider, secret } of REFUSED_SECRETS) {
			const patch = updateCredentialSchema(
				provider as (typeof CREDENTIAL_PROVIDERS)[number],
			).safeParse({ secret });
			// PATCH accepting means the fixture's invalidity lives elsewhere
			// (a bad label, a bad config) — nothing to compare.
			if (patch.success) {
				continue;
			}
			const post = createCredentialSchema.safeParse({
				provider,
				label: "probe",
				config: CONFIG_PROBE.get(provider) ?? {},
				secret,
			});
			expect(
				post.success,
				`${provider}: PATCH refuses ${JSON.stringify(secret)} and POST ACCEPTS it — the create union's arm is stale against CREDENTIAL_PROVIDER_SHAPES`,
			).toBe(false);
		}
	});
});
