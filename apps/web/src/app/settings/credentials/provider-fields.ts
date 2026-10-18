import type { CredentialProviderId } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";

export type FieldDef = {
	name: string;
	labelKey: MessageKey;
	type?:
		| "text"
		| "password"
		| "number"
		| "checkbox"
		| "textarea"
		| "select"
		/** `bucket = https://base` per line ⇄ the `publicBaseUrls` config map. */
		| "urlmap";
	options?: string[];
	placeholder?: string;
	hintKey?: MessageKey;
	tooltipKey?: MessageKey;
	/** Blank optional fields are omitted from the payload entirely. */
	optional?: boolean;
};

/**
 * The `publicBaseUrls` editor, shared by every provider that holds buckets.
 * Without it the map is only settable by editing Postgres by hand; the
 * operator-facing settings contract requires this value to be editable here.
 */
const PUBLIC_BASE_URLS: FieldDef = {
	name: "publicBaseUrls",
	labelKey: "fields.publicBaseUrlsOptional",
	type: "urlmap",
	optional: true,
	placeholder: "my-output-bucket = https://cdn.example.com/vod",
	hintKey: "fields.oneLinePerBucketBucketHttpsCdn",
};

/** Drives the provider-specific form sections (REQUIREMENTS §3.1). */
export const PROVIDER_FIELDS: Record<
	CredentialProviderId,
	{ config: FieldDef[]; secret: FieldDef[] }
> = {
	AWS_S3: {
		config: [
			{
				name: "region",
				labelKey: "fields.region",
				placeholder: "ap-northeast-1",
			},
			PUBLIC_BASE_URLS,
		],
		secret: [
			{ name: "accessKeyId", labelKey: "fields.accessKeyId" },
			{
				name: "secretAccessKey",
				labelKey: "fields.secretAccessKey",
				type: "password",
			},
		],
	},
	AWS_S3_ROLE_BASED: {
		config: [
			{
				name: "roleArn",
				labelKey: "fields.roleArn",
				placeholder: "arn:aws:iam::123456789012:role/bitmovin",
				hintKey: "fields.bitmovinAssumesThisRoleNoStatic",
			},
			{
				name: "externalId",
				labelKey: "fields.externalIdOptional",
				optional: true,
			},
			{ name: "region", labelKey: "fields.region", placeholder: "us-east-1" },
			PUBLIC_BASE_URLS,
		],
		secret: [],
	},
	AKAMAI_OBJECT_STORAGE: {
		config: [
			{
				name: "host",
				labelKey: "fields.host",
				placeholder: "jp-osa-1.linodeobjects.com",
				hintKey: "fields.regionEndpointEndingInLinodeobjectsCom",
			},
			PUBLIC_BASE_URLS,
		],
		secret: [
			{ name: "accessKeyId", labelKey: "fields.accessKey" },
			{
				name: "secretAccessKey",
				labelKey: "fields.secretKey",
				type: "password",
			},
		],
	},
	OCI_OBJECT_STORAGE: {
		config: [
			{
				name: "namespace",
				labelKey: "fields.namespace",
				placeholder: "axaxnpcrorw5",
			},
			{ name: "region", labelKey: "fields.region", placeholder: "ap-osaka-1" },
			PUBLIC_BASE_URLS,
		],
		secret: [
			{
				name: "accessKeyId",
				labelKey: "fields.customerSecretKeyId",
				hintKey: "fields.ociUserSettingsCustomerSecretKeys",
			},
			{
				name: "secretAccessKey",
				labelKey: "fields.customerSecretKey",
				type: "password",
			},
		],
	},
	GENERIC_S3: {
		config: [
			{ name: "host", labelKey: "fields.host", placeholder: "s3.example.com" },
			{
				name: "port",
				labelKey: "fields.portOptional",
				type: "number",
				optional: true,
			},
			{ name: "ssl", labelKey: "fields.useTls", type: "checkbox" },
			{
				name: "signatureVersion",
				labelKey: "fields.signatureVersion",
				type: "select",
				options: ["S3_V4", "S3_V2"],
				hintKey: "fields.appliesToBitmovinIOBrowsing",
			},
			PUBLIC_BASE_URLS,
		],
		secret: [
			{ name: "accessKeyId", labelKey: "fields.accessKeyId" },
			{
				name: "secretAccessKey",
				labelKey: "fields.secretAccessKey",
				type: "password",
			},
		],
	},
	GCS_HMAC: {
		config: [PUBLIC_BASE_URLS],
		secret: [
			{ name: "accessKey", labelKey: "fields.hmacAccessKey" },
			{ name: "secret", labelKey: "fields.hmacSecret", type: "password" },
		],
	},
	GCS_SERVICE_ACCOUNT: {
		config: [PUBLIC_BASE_URLS],
		secret: [
			{
				name: "serviceAccountJson",
				labelKey: "fields.serviceAccountKeyJson",
				type: "textarea",
				hintKey: "fields.pasteTheFullKeyFileClient",
			},
		],
	},
	AZURE_BLOB: {
		config: [
			{ name: "accountName", labelKey: "fields.storageAccountName" },
			PUBLIC_BASE_URLS,
		],
		secret: [
			{ name: "accountKey", labelKey: "fields.accountKey", type: "password" },
		],
	},
	SFTP: {
		config: [
			{
				name: "host",
				labelKey: "fields.host",
				placeholder: "sftp.example.com",
			},
			{ name: "port", labelKey: "fields.port", type: "number", optional: true },
			{ name: "username", labelKey: "fields.username" },
		],
		secret: [
			{ name: "password", labelKey: "fields.password", type: "password" },
		],
	},
	/**
	 * Akamai NetStorage upload account . Three fields and no port:
	 * the SDK model has none, and inventing one would be a field nobody can
	 * answer.
	 *
	 * The host is the NetStorage HTTP hostname (`*-nsu.akamaihd.net`), NOT an
	 * S3 endpoint — `AKAMAI_OBJECT_STORAGE` is the other Akamai product and
	 * takes a key pair. The placeholder says so, because the two are one
	 * dropdown apart.
	 */
	AKAMAI_NETSTORAGE: {
		config: [
			{
				name: "host",
				labelKey: "fields.host",
				placeholder: "example-nsu.akamaihd.net",
			},
			{ name: "username", labelKey: "fields.username" },
		],
		secret: [
			{ name: "password", labelKey: "fields.password", type: "password" },
		],
	},
	/**
	 * Akamai MSL . Two fields and no secret TODAY — the stream id
	 * and event name are what Akamai provisions, and neither is a key.
	 *
	 * It is a credential because you cannot obtain either without an Akamai
	 * account, not because anything here needs encrypting. `AWS_S3_ROLE_BASED`
	 * above is the same shape.
	 *
	 * "TODAY" is doing work : MSL5 went GA and
	 * `AkamaiMslOutput` gained an HTTP Digest username/password. When that
	 * lands it belongs in the `secret` array below, NOT in `config` — `config`
	 * is plaintext JSONB that `GET /api/credentials` returns to any VIEWER,
	 * while `secret` is ciphertext the Prisma client omits globally. The
	 * neighbour above is the trap rather than the model: `AKAMAI_NETSTORAGE`
	 * keeps its username in `config` and renders it in the credential list,
	 * which is right for a readable upload account and wrong for one half of a
	 * Digest pair. POIS and KANTAR are the precedent to follow.
	 */
	LIVE_MEDIA_INGEST: {
		config: [],
		secret: [
			{
				name: "publishingPoint",
				labelKey: "fields.lmiPublishingPoint",
				type: "password",
				hintKey: "fields.lmiPublishingPointHelp",
			},
		],
	},
	AKAMAI_MSL: {
		config: [
			{
				name: "streamId",
				labelKey: "fields.mslStreamId",
				type: "number",
				placeholder: "123456",
			},
			{
				name: "eventName",
				labelKey: "fields.mslEventName",
				placeholder: "my-live-event",
			},
			/**
			 * The Akamai DELIVERY root (2026-09-02) — readable config, because it
			 * is what every viewer's player loads and nothing about it is secret.
			 * Optional: MSL4 credentials registered before this field carry none,
			 * and the playback panel names the missing field instead of guessing
			 * a host. The form's `MslEdgeCandidate` fills the MSL4 shape from a
			 * host the operator types; MSL5 operators paste the Control Center
			 * value.
			 */
			{
				name: "edgeBaseUrl",
				labelKey: "fields.mslEdgeBaseUrlOptional",
				optional: true,
				placeholder:
					"https://example.akamaized.net/hls/live/123456/my-live-event",
				hintKey: "fields.mslEdgeBaseUrlHint",
			},
		],
		// MSL5's HTTP Digest publishing pair . BOTH halves are
		// vault material and neither is readable config — POIS is the shape to
		// copy, not `AKAMAI_NETSTORAGE`, whose username sits in `config` and is
		// rendered in the credential list. That neighbour is the trap: it is
		// right for a readable upload account and wrong for one half of a
		// Digest pair.
		//
		// BOTH-OR-NEITHER, enforced by the schema's refine, and both stay
		// optional in the form because MSL4 credentials carry no pair and are
		// the incumbent until MSL4's EOL 2026-12-31.
		// `optional: true` on BOTH is load-bearing, and a test caught its
		// absence: `normalize` keeps a blank REQUIRED field as `""` so zod's
		// friendly min(1) message fires, and drops a blank OPTIONAL one so
		// `.optional` applies. Without it, an MSL4 credential — no pair, which
		// is every existing row — could not be saved at all: the untouched
		// inputs submitted `""`, which `z.string.min(1).optional` refuses.
		secret: [
			{
				name: "username",
				labelKey: "fields.mslPublishingUsername",
				optional: true,
				hintKey: "fields.mslPublishingPairBothOrNeither",
			},
			{
				name: "password",
				labelKey: "fields.mslPublishingPassword",
				type: "password",
				optional: true,
				hintKey: "fields.mslPublishingOnlyMsl5",
			},
		],
	},
	DRM_SPEKE: {
		config: [],
		secret: [
			{
				name: "url",
				labelKey: "fields.spekeUrl",
				placeholder: "https://keys.example.com/speke",
				tooltipKey: "fields.spekeVaultHelp",
			},
			{
				name: "username",
				labelKey: "fields.username",
				type: "password",
				optional: true,
			},
			{
				name: "password",
				labelKey: "fields.password",
				type: "password",
				optional: true,
			},
			{
				name: "apiKey",
				labelKey: "fields.spekeApiKey",
				type: "password",
				optional: true,
			},
			{ name: "roleArn", labelKey: "fields.roleArn", optional: true },
			{
				name: "gatewayRegion",
				labelKey: "fields.spekeGatewayRegion",
				optional: true,
				placeholder: "eu-west-1",
				tooltipKey: "fields.spekeRoleHelp",
			},
			{
				name: "externalId",
				labelKey: "fields.externalIdOptional",
				type: "password",
				optional: true,
			},
			{
				name: "externalIdMode",
				labelKey: "fields.spekeExternalIdMode",
				type: "select",
				options: ["CUSTOM", "GLOBAL", "GENERATED"],
				optional: true,
			},
		],
	},
	DRM_CENC: {
		config: [],
		secret: [
			{
				name: "key",
				labelKey: "fields.contentKey32HexChars",
				type: "password",
				hintKey: "fields.k16ByteCencFairplayContentKey",
			},
		],
	},
	NEXGUARD: {
		config: [],
		secret: [
			{ name: "license", labelKey: "fields.nexguardLicense", type: "password" },
		],
	},
	NOTIFICATION_WEBHOOK: {
		config: [],
		secret: [
			{
				name: "url",
				labelKey: "fields.webhookUrl",
				type: "password",
				hintKey: "fields.webhookUrlHint",
			},
		],
	},
	SRT_PASSPHRASE: {
		config: [],
		secret: [
			{
				name: "passphrase",
				labelKey: "fields.passphrase16Or32Chars",
				type: "password",
				hintKey: "fields.aes128Exactly16CharactersAes",
			},
		],
	},
	ZIXI: {
		config: [],
		secret: [
			{
				name: "password",
				labelKey: "fields.passwordOptional",
				type: "password",
				optional: true,
			},
			{
				name: "decryptionKey",
				labelKey: "fields.decryptionKeyOptional",
				type: "password",
				optional: true,
				hintKey: "fields.provideAtLeastOneOfPassword",
			},
		],
	},
	POIS_ENDPOINT: {
		config: [],
		// BOTH halves are vault material (username is PII-ish — KANTAR
		// precedent): write-only here, resolved at live start only.
		secret: [
			{
				name: "username",
				labelKey: "fields.username",
				hintKey: "fields.poisBasicAuthUserEncryptedAlongside",
			},
			{
				name: "password",
				labelKey: "fields.password",
				type: "password",
				hintKey: "fields.resolvedByTheLiveWorkerAt",
			},
		],
	},
	KANTAR: {
		config: [],
		// The Kantar service login. Both halves ride the vault (the SDK sends
		// them in the KantarWatermark body; the plan carries only a
		// credentialId) — write-only here, resolved at encoding-create only.
		secret: [
			{
				name: "login",
				labelKey: "fields.login",
				hintKey: "fields.kantarServiceUserEncryptedAlongsideThe",
			},
			{
				name: "password",
				labelKey: "fields.password",
				type: "password",
				hintKey: "fields.kantarServicePassword",
			},
		],
	},
};

export const PROVIDER_CONFIG_SUMMARY: Record<
	CredentialProviderId,
	(config: Record<string, unknown>) => string
> = {
	AWS_S3: (c) => String(c.region ?? ""),
	AWS_S3_ROLE_BASED: (c) => String(c.roleArn ?? ""),
	AKAMAI_OBJECT_STORAGE: (c) => String(c.host ?? ""),
	OCI_OBJECT_STORAGE: (c) => `${c.namespace ?? ""} · ${c.region ?? ""}`,
	GENERIC_S3: (c) => String(c.host ?? ""),
	GCS_HMAC: () => "HMAC key pair",
	GCS_SERVICE_ACCOUNT: () => "Service account",
	AZURE_BLOB: (c) => String(c.accountName ?? ""),
	SFTP: (c) => `${c.username ?? ""}@${c.host ?? ""}`,
	// . Same summary shape as SFTP because the account IS the
	// address — there is no bucket to name.
	AKAMAI_NETSTORAGE: (c) => `${c.username ?? ""}@${c.host ?? ""}`,
	//  — the provisioned identity, which is the whole INGEST
	// address; the delivery root follows when the row declares one, so the
	// list shows which MSL credentials can hand out a playback link.
	LIVE_MEDIA_INGEST: () => "Live Media Ingest",
	AKAMAI_MSL: (c) =>
		`${c.eventName ?? ""} (stream ${c.streamId ?? ""})${
			typeof c.edgeBaseUrl === "string" && c.edgeBaseUrl !== ""
				? ` · ${c.edgeBaseUrl}`
				: ""
		}`,
	DRM_CENC: () => "Content key",
	DRM_SPEKE: () => "SPEKE key provider",
	NEXGUARD: () => "License",
	SRT_PASSPHRASE: () => "Passphrase",
	ZIXI: () => "Zixi secrets",
	POIS_ENDPOINT: () => "Basic-auth pair",
	KANTAR: () => "Kantar login",
	NOTIFICATION_WEBHOOK: () => "Notification webhook",
};
