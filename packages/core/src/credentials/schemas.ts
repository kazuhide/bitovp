import { z } from "zod";
import { secretEgressUrlSchema } from "../plan/schema";
import { parseCredentialEdgeBaseUrl } from "../verify/live-evidence";
import { BASE_URL_HINT, normalizeBaseUrl } from "./public-base-urls";

/**
 * Storage credential contracts shared by web forms (react-hook-form
 * resolvers) and API routes — single source of validation (ARCHITECTURE §9).
 * `config` is non-secret (stored as plain JSON); `secret` is serialized and
 * AES-encrypted by the db store. Akamai/OCI are GenericS3-compatible with
 * V4 signing (constraint C10).
 */

export const CREDENTIAL_PROVIDERS = [
	"AWS_S3",
	"AWS_S3_ROLE_BASED",
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GENERIC_S3",
	"GCS_HMAC",
	"GCS_SERVICE_ACCOUNT",
	"AZURE_BLOB",
	"SFTP",
	"AKAMAI_NETSTORAGE",
	"AKAMAI_MSL",
	"LIVE_MEDIA_INGEST",
	"DRM_CENC",
	"DRM_SPEKE",
	"NEXGUARD",
	"SRT_PASSPHRASE",
	"ZIXI",
	"POIS_ENDPOINT",
	"KANTAR",
	"NOTIFICATION_WEBHOOK",
] as const;

/**
 * What a provider is FOR .
 *
 * The settings screen was called "Storage credentials" and held seven things
 * that are not storage — a DRM content key, live-ingest secrets, and four
 * integration endpoints. The owner raised the DRM one twice; it is the most
 * visibly wrong, but it is not alone, and a screen whose title contradicts its
 * contents teaches operators to distrust the labels.
 *
 * The grouping lives HERE rather than in the settings page so the UI cannot
 * guess: a provider added later must be classified in the same commit that
 * adds it, and the exhaustive `Record` makes tsc say so.
 *
 * DRM keys stay in the vault. Moving them into the plan — the other reading of
 * "remove it from credentials" — would put key bytes into plan JSON, which is
 * persisted, snapshotted, rendered in the plan preview, exported as a template
 * and copied by Duplicate. The schema's own header rule ("secrets never ride a
 * plan") predates this row and survives it; what changes is where the key is
 * MANAGED, not where it is stored.
 */
export const CREDENTIAL_GROUPS = [
	"STORAGE",
	"DRM",
	"LIVE_INGEST",
	"INTEGRATION",
] as const;
export type CredentialGroup = (typeof CREDENTIAL_GROUPS)[number];

export const CREDENTIAL_PROVIDER_GROUP: Record<
	(typeof CREDENTIAL_PROVIDERS)[number],
	CredentialGroup
> = {
	AWS_S3: "STORAGE",
	AWS_S3_ROLE_BASED: "STORAGE",
	AKAMAI_OBJECT_STORAGE: "STORAGE",
	OCI_OBJECT_STORAGE: "STORAGE",
	GENERIC_S3: "STORAGE",
	GCS_HMAC: "STORAGE",
	GCS_SERVICE_ACCOUNT: "STORAGE",
	AZURE_BLOB: "STORAGE",
	SFTP: "STORAGE",
	AKAMAI_NETSTORAGE: "STORAGE",
	// Delivery rather than storage, but it is where the encoding writes and it
	// is picked in the same output step, so an operator looks for it here.
	// Owner-confirmed 2026-08-19 rather than left as a quiet compromise.
	AKAMAI_MSL: "STORAGE",
	LIVE_MEDIA_INGEST: "STORAGE",
	DRM_CENC: "DRM",
	DRM_SPEKE: "DRM",
	NEXGUARD: "DRM",
	SRT_PASSPHRASE: "LIVE_INGEST",
	ZIXI: "LIVE_INGEST",
	POIS_ENDPOINT: "INTEGRATION",
	KANTAR: "INTEGRATION",
	NOTIFICATION_WEBHOOK: "INTEGRATION",
};

/**
 * Can a driver LIST objects for this provider?
 *
 * `@bitovp/storage`'s `createBrowserForCredential` is the authority — it either
 * returns a browser or throws `UnsupportedBrowseError` — but it is server-side
 * (it pulls in the AWS/Azure/GCS SDKs), so a client component cannot ask it.
 * This is the same answer in a form the UI can import, and
 * `packages/storage/src/factory.test.ts` pins the two together per provider: a
 * disagreement fails there rather than in front of an operator.
 *
 * Why it matters that this is exhaustive: the watch-folder location picker
 * passed `CREDENTIAL_PROVIDERS` — all of them — so an operator could choose
 * their Kantar login as a folder to sweep. The rule saved, and every sweep tick
 * then threw "nothing to browse" and backed the rule off to the 15-minute cap.
 * A picker that offers the impossible does not fail at the click; it fails
 * quietly, later, somewhere else.
 *
 * `false` is not always "not storage": SFTP, NetStorage and role-based S3 are
 * real destinations we simply cannot enumerate (no S3 listing, or an STS broker
 * we have not built). The path is typed by hand for those, which is why they
 * stay selectable everywhere EXCEPT a picker whose whole job is to browse.
 */
export const CREDENTIAL_PROVIDER_BROWSABLE: Record<
	(typeof CREDENTIAL_PROVIDERS)[number],
	boolean
> = {
	AWS_S3: true,
	AKAMAI_OBJECT_STORAGE: true,
	OCI_OBJECT_STORAGE: true,
	GENERIC_S3: true,
	GCS_HMAC: true,
	GCS_SERVICE_ACCOUNT: true,
	AZURE_BLOB: true,
	// Needs an STS broker (P2) — key-based AWS browses, this one cannot.
	AWS_S3_ROLE_BASED: false,
	SFTP: false,
	// Its own HTTP API, not S3 — see the note in factory.ts against confusing it
	// with AKAMAI_OBJECT_STORAGE, which IS browsable.
	AKAMAI_NETSTORAGE: false,
	// A provisioned live stream, not a container .
	AKAMAI_MSL: false,
	LIVE_MEDIA_INGEST: false,
	DRM_CENC: false,
	DRM_SPEKE: false,
	NEXGUARD: false,
	SRT_PASSPHRASE: false,
	ZIXI: false,
	POIS_ENDPOINT: false,
	KANTAR: false,
	NOTIFICATION_WEBHOOK: false,
};

/** The providers a storage picker may offer. Derived, never hand-listed. */
export const BROWSABLE_CREDENTIAL_PROVIDERS = CREDENTIAL_PROVIDERS.filter(
	(p) => CREDENTIAL_PROVIDER_BROWSABLE[p],
);

export const credentialProviderSchema = z.enum(CREDENTIAL_PROVIDERS);
export type CredentialProviderId = z.infer<typeof credentialProviderSchema>;

export const CREDENTIAL_PROVIDER_LABELS: Record<CredentialProviderId, string> =
	{
		AWS_S3: "AWS S3",
		AWS_S3_ROLE_BASED: "AWS S3 (role-based)",
		AKAMAI_OBJECT_STORAGE: "Akamai Object Storage",
		OCI_OBJECT_STORAGE: "OCI Object Storage",
		GENERIC_S3: "Generic S3",
		/**
		 * NOT "(HMAC)" (owner, 2026-08-20). A parenthesis here is a variant
		 * discriminator, and the pair two lines up already sets the convention:
		 * the ordinary way in is unqualified (`AWS S3`) and only the departure
		 * carries the qualifier (`AWS S3 (role-based)`). GCS was the one pair
		 * where BOTH members were qualified, so the parenthesis stopped
		 * distinguishing anything and just nested — the source step renders
		 * `{label} ({provider})`, which made it "… (Google Cloud Storage (HMAC))".
		 *
		 * This leaves the label a strict PREFIX of the one below it, which is
		 * fine on screen and a trap for `text.includes(LABEL)` in a test — hence
		 * the uniqueness/prefix pin in schemas.test.ts.
		 */
		GCS_HMAC: "Google Cloud Storage",
		GCS_SERVICE_ACCOUNT: "Google Cloud Storage (service account)",
		AZURE_BLOB: "Azure Blob Storage",
		SFTP: "SFTP (encoding output)",
		AKAMAI_NETSTORAGE: "Akamai NetStorage",
		AKAMAI_MSL: "Akamai MSL (live delivery)",
		LIVE_MEDIA_INGEST: "Live Media Ingest",
		DRM_CENC: "DRM content key (CENC/FairPlay)",
		DRM_SPEKE: "SPEKE key provider",
		NEXGUARD: "Nagra NexGuard license",
		SRT_PASSPHRASE: "SRT passphrase (live ingest)",
		ZIXI: "Zixi credentials (live ingest)",
		POIS_ENDPOINT: "POIS endpoint (ESAM basic auth)",
		KANTAR: "Kantar audio watermarking",
		NOTIFICATION_WEBHOOK: "Notification webhook (Slack/generic)",
	};

export const AKAMAI_HOST_SUFFIX = ".linodeobjects.com";

/** OCI S3-compat endpoint per C10. */
export function ociCompatHost(namespace: string, region: string): string {
	return `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
}

const label = z.string().min(1, "Label is required").max(120);

/**
 * Operator-declared public bases per bucket . The
 * only way to express a public Azure container, and the way a CDN in front of
 * any bucket is expressed. Optional everywhere, so no migration and no
 * behaviour change for existing rows.
 */
const publicBaseUrls = z
	.record(
		z.string().min(1, "Bucket name is required"),
		z.string().refine((raw) => normalizeBaseUrl(raw) !== null, BASE_URL_HINT),
	)
	.optional();

/** Object-storage providers with no other config than the declared bases. */
const bucketOnlyConfig = z.object({ publicBaseUrls });

const accessKeyPair = z.object({
	accessKeyId: z.string().min(1, "Access key id is required"),
	secretAccessKey: z.string().min(1, "Secret access key is required"),
});

const awsS3Config = z.object({
	region: z.string().min(1, "Region is required"),
	publicBaseUrls,
});

const s3RoleConfig = z.object({
	roleArn: z
		.string()
		.regex(
			/^arn:aws:iam::\d{12}:role\/.+/,
			"Must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)",
		),
	// Deliberately non-secret config: the external id is a confused-deputy
	// guard, useless without the role's trust policy — accepted as readable.
	externalId: z.string().min(1).optional(),
	region: z.string().min(1, "Region is required"),
	publicBaseUrls,
});

const akamaiConfig = z.object({
	host: z
		.string()
		.min(1, "Host is required")
		.refine(
			// Exactly one cluster label: bucket-qualified hosts would poison
			// region derivation and pin the endpoint to a single bucket.
			(host) => /^[a-z0-9][a-z0-9-]*\.linodeobjects\.com$/i.test(host),
			`Host must be a region endpoint like jp-osa-1${AKAMAI_HOST_SUFFIX} (no bucket prefix, C10)`,
		),
	publicBaseUrls,
});

const ociConfig = z.object({
	// Anchored : these two interpolate into the C10 compat host
	// (`{ns}.compat.objectstorage.{region}.oraclecloud.com`) — free strings
	// could smuggle dots/slashes and point the client at an attacker host.
	namespace: z
		.string()
		.min(1, "Namespace is required")
		.regex(/^[a-z][a-z0-9]{0,62}$/, {
			// Object form deliberately: the totality gate's bare-string
			// extraction cannot see past the regex literal's comma.
			message: "OCI namespace is lowercase alphanumeric",
		}),
	region: z
		.string()
		.min(1, "Region is required")
		.regex(/^[a-z]{2,3}-[a-z]+-\d{1,2}$/, {
			message: "OCI region looks like ap-osaka-1",
		}),
	publicBaseUrls,
});

const genericS3Config = z.object({
	// A bare hostname or IPv4 — never a URL (: this field decides
	// where OUR server connects with vault credentials; scheme/port ride
	// their own fields, and the deployment-level rail is
	// STORAGE_ENDPOINT_ALLOWED_HOSTS, enforced at the point of use).
	host: z
		.string()
		.min(1, "Host is required")
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i,
			{ message: "Host must be a bare hostname (no scheme, path or port)" },
		),
	port: z.number().int().min(1).max(65535).optional(),
	ssl: z.boolean().default(true),
	/** Bitmovin GenericS3 signing; Akamai/OCI always map to S3_V4 (C10). */
	signatureVersion: z.enum(["S3_V4", "S3_V2"]).default("S3_V4"),
	publicBaseUrls,
});

const gcsHmacSecret = z.object({
	accessKey: z.string().min(1, "HMAC access key is required"),
	secret: z.string().min(1, "HMAC secret is required"),
});

const gcsServiceAccountSecret = z.object({
	serviceAccountJson: z.string().superRefine((raw, ctx) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			ctx.addIssue({ code: "custom", message: "Must be valid JSON" });
			return;
		}
		const record = parsed as Record<string, unknown>;
		if (
			typeof record !== "object" ||
			record === null ||
			typeof record.client_email !== "string" ||
			typeof record.private_key !== "string"
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Must be a service-account key JSON (client_email, private_key)",
			});
		}
	}),
});

const azureConfig = z.object({
	accountName: z.string().min(1, "Account name is required"),
	publicBaseUrls,
});

const azureSecret = z.object({
	accountKey: z.string().min(1, "Account key is required"),
});

/** Bitmovin SftpOutput connection — password is the only secret part. */
const sftpConfig = z.object({
	host: z.string().min(1, "Host is required"),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1, "Username is required"),
});

const sftpSecret = z.object({
	password: z.string().min(1, "Password is required"),
});

/**
 * Bitmovin AkamaiNetStorageInput/Output  — host, username and
 * password, and nothing else. No port and no bucket: a NetStorage upload
 * account IS the container, and paths hang off the CP code directory the
 * account is scoped to.
 *
 * Distinct from `AKAMAI_OBJECT_STORAGE`, which is the Linode S3-compatible
 * service reached through GenericS3 (C10). Same vendor, unrelated protocol —
 * folding them together would put an S3 key pair where a NetStorage upload
 * account belongs.
 */
const akamaiNetStorageConfig = z.object({
	host: z.string().min(1, "Host is required"),
	username: z.string().min(1, "Username is required"),
});

const akamaiNetStorageSecret = z.object({
	password: z.string().min(1, "Password is required"),
});

/**
 * Akamai MSL provisioning identity (remodelled 2026-08-19 on the
 * owner's call).
 *
 * MSL4 carries no password, and the first cut concluded from that it was not a
 * credential — the identifiers went inline in the plan.
 *
 * THE VERSION QUALIFIER ON THAT FIRST WORD IS NEW AND LOAD-BEARING (ledger
 * #162, 2026-08-27). It read "MSL carries no password" until MSL5 went GA and
 * `AkamaiMslOutput` gained `publishingAuthentication` — an HTTP Digest
 * username/password pair. This docblock is the argument for why `secret` below
 * is `emptyObject`, so leaving it unqualified would have had the next reader
 * defend an empty slot the API had already outgrown. The owner's decision
 * (registered in #162) is that the pair goes into THIS credential's empty
 * secret slot rather than a new provider, precisely so one provisioned Akamai
 * stream stays one credential. The owner's argument
 * is the better one: **you cannot obtain a streamId or an eventName without an
 * Akamai account**, so they are account-scoped provisioning facts, which is
 * what this vault is for. Having no secret is not the same as having no
 * identity, and `AWS_S3_ROLE_BASED` already stands here with an empty secret.
 *
 * Treating it as the exception is what produced the defects: the output step
 * is credential-first, so MSL was unreachable until a bespoke destination
 * selector was bolted on, with its own state union, its own fields component
 * and its own duplicate-collision hazard. As a credential it is registered
 * once, labelled, reused across channels, and judged by the Akamai-only
 * profile through the same provider rule as everything else.
 *
 * `streamFormat` deliberately does NOT live here: it constrains the ENCODING
 * (C31 — HLS wants a TS ladder, CMAF wants both manifests), so it is a
 * per-channel choice, not an account fact. Fixing it to the credential would
 * stop one provisioned stream from being usable in more than one topology.
 *
 * `edgeBaseUrl` DOES live here (2026-09-02). Bitmovin's `AkamaiMslOutput`
 * carries the stream id and event name but never the Akamai property hostname
 * the stream is served from, so until this field existed the app had no
 * playback link for an MSL channel at all (`NO_PATTERN` on every one, measured
 * on channel 0645c2f1) and the verifier's edge read depended on a CLI flag
 * typed per run. The delivery root is an account/provisioning fact exactly
 * like the two identifiers above it — you get it from the same Akamai
 * console — so it is registered once, on the credential, and every channel and
 * every verifier run reads it from there. Optional, because a credential
 * without it is still a complete provisioning identity; the playback panel
 * then names the missing field rather than guessing a host.
 *
 * The value is the event ROOT with no trailing slash: the app appends
 * `/<manifestName>` and nothing else, so it is MSL4/MSL5-agnostic. Validation
 * is `parseCredentialEdgeBaseUrl`, which shares its shape rules with the
 * verifier's `--live-msl-edge-base-url` — one classifier, two doors.
 */
const akamaiMslConfig = z.object({
	streamId: z.coerce
		.number()
		.int()
		.positive("Stream ID must be a positive integer"),
	eventName: z.string().min(1, "Event name is required"),
	edgeBaseUrl: z
		.string()
		.trim()
		.superRefine((raw, ctx) => {
			const parsed = parseCredentialEdgeBaseUrl(raw);
			if (parsed.ok) {
				return;
			}
			// One authored sentence per defect, in `message:` form so the form
			// layer's totality gate (zod-issue-message.test.ts) enrols each one
			// and the ja form never renders raw English.
			switch (parsed.defect) {
				case "length":
					ctx.addIssue({
						code: "custom",
						message: "Edge base URL must be at most 512 characters",
					});
					return;
				case "invalid":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must be an absolute https URL (https://host/path)",
					});
					return;
				case "scheme":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must use https — viewers load the stream over TLS only",
					});
					return;
				case "userinfo":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must not embed credentials (user:pass@host) — every viewer receives this link",
					});
					return;
				case "query":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must not carry a query or fragment — supply the event root, not a signed playback URL",
					});
					return;
				case "trailing-slash":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must not end with a slash — the app appends the manifest name itself",
					});
					return;
				case "private-host":
					ctx.addIssue({
						code: "custom",
						message:
							"Edge base URL must name a public host — localhost and private or link-local addresses cannot be reached by viewers",
					});
					return;
				default: {
					const exhaustive: never = parsed.defect;
					throw new Error(`Unknown edge base URL defect ${exhaustive}`);
				}
			}
		})
		.optional(),
});

const emptyObject = z.object({});

const liveMediaIngestSecret = z.strictObject({
	publishingPoint: z.url().refine((value) => {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	}, "Publishing point must be an HTTP(S) URL without user credentials or fragment"),
});

/**
 * CENC/FairPlay content key — the only secret half of a DRM config. kid,
 * PSSH, license URLs and FairPlay IV/URI are public manifest material and
 * live in the plan.
 */
const drmCencSecret = z.object({
	key: z
		.string()
		.regex(/^[0-9a-fA-F]{32}$/, "16-byte content key as 32 hex chars"),
});

const nexguardSecret = z.object({
	license: z.string().min(1, "NexGuard license is required"),
});

/**
 * SrtInput.passphrase — vault material resolved by the channel worker at
 * execution only (never in plans/payloads/snapshots). SRT derives the AES
 * key from the passphrase: AES-128 needs exactly 16 characters, AES-256
 * exactly 32 (the plan-side keyLength must match — executor tripwire).
 */
const srtPassphraseSecret = z.object({
	passphrase: z
		.string()
		.refine(
			(value) => value.length === 16 || value.length === 32,
			"Passphrase must be exactly 16 chars (AES-128) or 32 chars (AES-256)",
		),
});

/**
 * ZixiInput secret material — password and/or decryptionKey, both resolved
 * at execution only. A row carrying neither would make the executor fail
 * open, so at least one is required here.
 */
const zixiSecret = z
	.object({
		password: z.string().min(1).optional(),
		decryptionKey: z.string().min(1).optional(),
	})
	.refine((value) => value.password || value.decryptionKey, {
		message: "Provide at least one of password / decryptionKey",
		path: ["password"],
	});

/**
 * POIS (ESAM) endpoint basic-auth pair — resolved by the channel worker at
 * START_LIVE_ENCODING only (plans carry poisCredentialId refs, never the
 * pair). BOTH halves are vault material: the username is PII-ish (KANTAR
 * plan precedent), so it is encrypted alongside the password rather than
 * stored as readable config.
 */
/**
 * Akamai MSL5 HTTP Digest publishing credentials — , PR 1.
 *
 * BOTH-OR-NEITHER, which is neither live precedent in this file and is the
 * whole point. `poisEndpointSecret` below requires BOTH halves (`min(1)` each);
 * `zixiSecret` above requires AT LEAST ONE. A Digest pair is a third shape:
 *
 *  - it must stay legal EMPTY, because MSL4 credentials carry no pair and are
 *    the incumbent until MSL4's EOL 2026-12-31 — a required pair would make
 *    every existing `AKAMAI_MSL` row unsaveable;
 *  - it must not be legal HALF, because the executor resolves "a pair" from a
 *    username alone, sets `enabled: true`, and sends a username with no
 *    password — which `MslPublishingAuthentication` documents as rejected, so
 *    the 400 lands partway through live provisioning from a credential the UI
 *    accepted.
 *
 * `zixiSecret`'s own comment is the argument for having a refine at all here:
 * a row carrying neither "would make the executor fail open". The difference is
 * only which combination is the failure.
 *
 * Note what this does NOT close, so nobody reads it as more than it is: an
 * EMPTY pair on an MSL5 output is legal here and legal at Bitmovin — the
 * encoder simply publishes unauthenticated. That state is a validator warning
 * (rail 3b), not a schema error, because refusing it would reject a
 * deliberately-unauthenticated setup the API accepts.
 */
const akamaiMslSecret = z
	.object({
		username: z.string().min(1).optional(),
		password: z.string().min(1).optional(),
	})
	.refine((value) => !value.username === !value.password, {
		message:
			"Provide both the Digest username and password, or neither — a half pair is rejected by Bitmovin at provisioning",
		path: ["password"],
	});

const poisEndpointSecret = z.object({
	username: z.string().min(1, "Username is required"),
	password: z.string().min(1, "Password is required"),
});

/**
 * Outbound notification webhook . The URL itself is the secret —
 * Slack's own docs say to treat incoming-webhook URLs as such — and it is a
 * credential-EGRESS destination, so the C22 rails apply verbatim:
 * secretEgressUrlSchema at save (https-only, no userinfo) and the
 * SECRET_EGRESS_ALLOWED_HOSTS allowlist re-checked in the worker before
 * every POST (dual enforcement, same as Kantar/ESAM).
 */
const notificationWebhookSecret = z.object({
	url: secretEgressUrlSchema,
});

/**
 * Kantar watermarking service login. Both halves are vault material for the
 * same reason as POIS: the SDK sends them in the KantarWatermark body, the
 * plan carries only a credentialId, and the login is account-identifying.
 */
const kantarSecret = z.object({
	login: z.string().min(1, "Login is required"),
	password: z.string().min(1, "Password is required"),
});

/** The entire endpoint/auth configuration is write-only vault material. */
const spekeProviderSecret = z
	.strictObject({
		url: secretEgressUrlSchema,
		username: z.string().min(1).optional(),
		password: z.string().min(1).optional(),
		apiKey: z.string().min(1).optional(),
		roleArn: z
			.string()
			.regex(
				/^arn:aws(?:-[a-z]+)?:iam::\d{12}:role\/.+$/,
				"AWS role ARN is required",
			)
			.optional(),
		gatewayRegion: z.string().min(1).optional(),
		externalId: z.string().min(1).optional(),
		externalIdMode: z.enum(["CUSTOM", "GLOBAL", "GENERATED"]).optional(),
	})
	.superRefine((value, ctx) => {
		if (!!value.username !== !!value.password)
			ctx.addIssue({
				code: "custom",
				path: ["password"],
				message: "Provide both Basic authentication username and password",
			});
		if (value.roleArn && !value.gatewayRegion)
			ctx.addIssue({
				code: "custom",
				path: ["gatewayRegion"],
				message: "Gateway region is required with roleArn",
			});
		if (
			!value.roleArn &&
			(value.gatewayRegion || value.externalId || value.externalIdMode)
		)
			ctx.addIssue({
				code: "custom",
				path: ["roleArn"],
				message: "AWS role settings require roleArn",
			});
		if (value.externalIdMode === "CUSTOM" && !value.externalId)
			ctx.addIssue({
				code: "custom",
				path: ["externalId"],
				message: "CUSTOM external ID mode requires externalId",
			});
		if (value.externalIdMode === "GENERATED" && value.externalId)
			ctx.addIssue({
				code: "custom",
				path: ["externalId"],
				message: "GENERATED external ID mode cannot set externalId",
			});
	});

/** Per-provider config/secret shapes, used by create + update schemas. */
export const CREDENTIAL_PROVIDER_SHAPES = {
	AWS_S3: { config: awsS3Config, secret: accessKeyPair },
	AWS_S3_ROLE_BASED: { config: s3RoleConfig, secret: emptyObject },
	AKAMAI_OBJECT_STORAGE: { config: akamaiConfig, secret: accessKeyPair },
	OCI_OBJECT_STORAGE: { config: ociConfig, secret: accessKeyPair },
	GENERIC_S3: { config: genericS3Config, secret: accessKeyPair },
	GCS_HMAC: { config: bucketOnlyConfig, secret: gcsHmacSecret },
	GCS_SERVICE_ACCOUNT: {
		config: bucketOnlyConfig,
		secret: gcsServiceAccountSecret,
	},
	AZURE_BLOB: { config: azureConfig, secret: azureSecret },
	SFTP: { config: sftpConfig, secret: sftpSecret },
	AKAMAI_NETSTORAGE: {
		config: akamaiNetStorageConfig,
		secret: akamaiNetStorageSecret,
	},
	AKAMAI_MSL: { config: akamaiMslConfig, secret: akamaiMslSecret },
	LIVE_MEDIA_INGEST: { config: emptyObject, secret: liveMediaIngestSecret },
	DRM_CENC: { config: emptyObject, secret: drmCencSecret },
	DRM_SPEKE: { config: z.strictObject({}), secret: spekeProviderSecret },
	NEXGUARD: { config: emptyObject, secret: nexguardSecret },
	SRT_PASSPHRASE: { config: emptyObject, secret: srtPassphraseSecret },
	ZIXI: { config: emptyObject, secret: zixiSecret },
	POIS_ENDPOINT: { config: emptyObject, secret: poisEndpointSecret },
	NOTIFICATION_WEBHOOK: {
		config: emptyObject,
		secret: notificationWebhookSecret,
	},
	KANTAR: { config: emptyObject, secret: kantarSecret },
} as const;

export const createCredentialSchema = z.discriminatedUnion("provider", [
	z.object({
		provider: z.literal("LIVE_MEDIA_INGEST"),
		label,
		config: emptyObject.default({}),
		secret: liveMediaIngestSecret,
	}),
	z.object({
		provider: z.literal("AWS_S3"),
		label,
		config: awsS3Config,
		secret: accessKeyPair,
	}),
	z.object({
		provider: z.literal("AWS_S3_ROLE_BASED"),
		label,
		config: s3RoleConfig,
		secret: emptyObject.default({}),
	}),
	z.object({
		provider: z.literal("AKAMAI_OBJECT_STORAGE"),
		label,
		config: akamaiConfig,
		secret: accessKeyPair,
	}),
	z.object({
		provider: z.literal("OCI_OBJECT_STORAGE"),
		label,
		config: ociConfig,
		secret: accessKeyPair,
	}),
	z.object({
		provider: z.literal("GENERIC_S3"),
		label,
		config: genericS3Config,
		secret: accessKeyPair,
	}),
	z.object({
		provider: z.literal("GCS_HMAC"),
		label,
		config: bucketOnlyConfig.default({}),
		secret: gcsHmacSecret,
	}),
	z.object({
		provider: z.literal("GCS_SERVICE_ACCOUNT"),
		label,
		config: bucketOnlyConfig.default({}),
		secret: gcsServiceAccountSecret,
	}),
	z.object({
		provider: z.literal("AZURE_BLOB"),
		label,
		config: azureConfig,
		secret: azureSecret,
	}),
	z.object({
		provider: z.literal("SFTP"),
		label,
		config: sftpConfig,
		secret: sftpSecret,
	}),
	z.object({
		provider: z.literal("AKAMAI_NETSTORAGE"),
		label,
		config: akamaiNetStorageConfig,
		secret: akamaiNetStorageSecret,
	}),
	z.object({
		provider: z.literal("AKAMAI_MSL"),
		label,
		config: akamaiMslConfig,
		// WAS `emptyObject.default({})`, with a comment saying MSL has no
		// secret — the FIFTH such comment , and the one a
		// phrase-grep could not find because it says the same thing in
		// different words. `preflight.ts` records that exact failure.
		//
		// Two things were wrong here, not one. The stale claim, and the fact
		// that `emptyObject` is `z.object({})` — NOT strict — so a Digest pair
		// typed against a build without this line was silently STRIPPED and the
		// credential saved looking configured (security F13).
		secret: akamaiMslSecret.optional().default({}),
	}),
	z.object({
		provider: z.literal("DRM_CENC"),
		label,
		config: emptyObject.default({}),
		secret: drmCencSecret,
	}),
	z.object({
		provider: z.literal("DRM_SPEKE"),
		label,
		config: z.strictObject({}).default({}),
		secret: spekeProviderSecret,
	}),
	z.object({
		provider: z.literal("NEXGUARD"),
		label,
		config: emptyObject.default({}),
		secret: nexguardSecret,
	}),
	z.object({
		provider: z.literal("SRT_PASSPHRASE"),
		label,
		config: emptyObject.default({}),
		secret: srtPassphraseSecret,
	}),
	z.object({
		provider: z.literal("ZIXI"),
		label,
		config: emptyObject.default({}),
		secret: zixiSecret,
	}),
	z.object({
		provider: z.literal("POIS_ENDPOINT"),
		label,
		config: emptyObject.default({}),
		secret: poisEndpointSecret,
	}),
	z.object({
		provider: z.literal("KANTAR"),
		label,
		config: emptyObject.default({}),
		secret: kantarSecret,
	}),
	z.object({
		provider: z.literal("NOTIFICATION_WEBHOOK"),
		label,
		config: emptyObject.default({}),
		secret: notificationWebhookSecret,
	}),
]);

export type CreateCredentialRequest = z.infer<typeof createCredentialSchema>;

/** PATCH contract: label/config replaceable; secret only when re-keying. */
export function updateCredentialSchema(provider: CredentialProviderId) {
	const shapes = CREDENTIAL_PROVIDER_SHAPES[provider];
	return z.object({
		label: label.optional(),
		config: shapes.config.optional(),
		secret: shapes.secret.optional(),
	});
}

// SFTP/FTP outputs stay inline job parameters as in encoding examples for now;
// whether they enter the vault is a P1 decision (fixed-bitrate sftp fixtures).

/**
 * Wire shape of a credential summary as served by the API (dates ISO,
 * ciphertext never present). Single source for client DTOs — do not fork
 * per-app types (the shared contract contract rule).
 */
export const credentialSummaryWireSchema = z.object({
	id: z.uuid(),
	label: z.string(),
	provider: credentialProviderSchema,
	config: z.record(z.string(), z.unknown()),
	createdAt: z.string(),
	updatedAt: z.string(),
	/**
	 * Does THIS ROW hold secret material — .
	 *
	 * A boolean, never the material, and it exists because the credentials
	 * screen was answering this question from the PROVIDER TYPE while its badge
	 * claimed something about the INSTANCE. Those coincide for 17 of 18
	 * providers and stop coinciding for `AKAMAI_MSL` the moment MSL5's Digest
	 * pair joins its secret slot: some MSL rows carry a pair, some do not, and
	 * the provider cannot tell you which.
	 *
	 * MEASURED, not assumed: exactly two providers' secret schemas accept `{}`
	 * — `AWS_S3_ROLE_BASED` (the instance role IS the auth) and `AKAMAI_MSL`.
	 * For the other sixteen a stored row implies a non-empty secret, so a
	 * structural answer would be right today. It is NOT used, because that
	 * shortcut is an assumption about schema HISTORY rather than a fact about
	 * the row: a row written before a provider's secret schema tightened would
	 * make it a confident lie. The server looks instead.
	 */
	hasSecret: z.boolean(),
});

export type CredentialSummaryWire = z.infer<typeof credentialSummaryWireSchema>;
