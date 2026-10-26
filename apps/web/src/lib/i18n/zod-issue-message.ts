import type { MessageKey } from ".";
import type { Translator } from "./context";

/**
 * The ONE choke point for zod issue text at the FORM layer — (c).
 *
 * The decided design said the schemas should EMIT `zerr.*` keys as messages;
 * that clause is deliberately NOT implemented, and the deviation is recorded
 * in the row: the same schema objects are parsed by API routes, so a
 * key-emitting schema would leak `zerr.gcsEitherOr` into API responses, the
 * audit log and process logs — violating the same design's own clause (3)
 * ("API-route parses keep English messages BY the standing policy"). Instead
 * the schemas stay byte-untouched and THIS module maps the authored English
 * sentence to its catalogue key by EXACT MATCH. The coupling this creates —
 * reword a schema sentence and the mapping silently misses — is pinned by a
 * source-reading totality test (`zod-issue-message.test.ts`) that extracts
 * every authored sentence from both schema files and fails the build unless
 * each one is in this table.
 *
 * Resolution order:
 *  1. authored sentence → catalogue key (exact match; the dynamic customData
 *     sentence by pattern, its numbers re-extracted into placeholders);
 *  2. zod's OWN default messages → mapped by issue CODE through `zerr.z*`
 *     (`min(1)` on a string reads as "Required", the ubiquitous form case);
 *  3. anything else → the RAW message, visibly — a sentence this module does
 *     not know must never be hidden or blanked (#79's all-or-nothing rule is
 *     enforced by the tests, not by suppressing unknowns at runtime).
 *
 * Server-side parses must NOT import this: `lib/server/plan-validation.ts`
 * keeps English by policy (one wording for the operator reading a log and
 * the operator reading a screen).
 */

export const SENTENCE_TO_KEY: ReadonlyMap<string, MessageKey> = new Map<
	string,
	MessageKey
>([
	[
		"Display aspect ratio requires both numerator and denominator",
		"wizard.codecDarPair",
	],
	[
		"Set both the sample aspect ratio numerator and denominator.",
		"wizard.codecSarPair",
	],
	[
		"Provide both Basic authentication username and password",
		"zerr.spekeBasicPair",
	],
	["Gateway region is required with roleArn", "zerr.spekeGatewayRegion"],
	["AWS role settings require roleArn", "zerr.spekeRoleArn"],
	["CUSTOM external ID mode requires externalId", "zerr.spekeCustomExternalId"],
	[
		"GENERATED external ID mode cannot set externalId",
		"zerr.spekeGeneratedExternalId",
	],
	[
		"srtInputId is only supported for SRT diagnostics",
		"zerr.diagnosticsSrtInputOnly",
	],
	[
		"Expected an HTTPS download URL without credentials",
		"zerr.diagnosticsHttpsDownload",
	],
	[
		"offset must be an ISO 8601 duration (e.g. PT10S, -PT1.500S)",
		"zerr.offsetIso8601",
	],
	//  PR3 (review-87b I-7): the watch rule schema's two authored
	// sentences — the name charset rendered raw English in ja because the
	// file never entered the totality gate's population.
	[
		"Rule names are lowercase letters, digits and hyphens",
		"zerr.watchRuleName",
	],
	[
		"Template must contain the basename or uuid token — outputs would overwrite each other",
		"zerr.watchTemplateToken",
	],
	// : the storage-endpoint anchors (core credentials schemas).
	["OCI namespace is lowercase alphanumeric", "zerr.ociNamespaceCharset"],
	["OCI region looks like ap-osaka-1", "zerr.ociRegionShape"],
	[
		"Host must be a bare hostname (no scheme, path or port)",
		"zerr.hostBareHostname",
	],
	//  PR2: the schedule arm schema's cross-field refinements.
	//  / review-226 I3: the feeder rows' manual-arm refusal.
	[
		"Feeder rows are derived by the program schedule at creation — they cannot be armed manually",
		"zerr.scheduleFeederDerivedOnly",
	],
	//  PR2: the air-time deadline is START-only.
	[
		"Air-time deadlines only apply to START schedules",
		"zerr.scheduleAirAtStartOnly",
	],
	["Air time must be after the fire time", "zerr.scheduleAirAtAfterFireAt"],
	//  PR3: the auto-lead arm's three refusals.
	[
		"Fire time is required unless auto-lead derives it",
		"zerr.scheduleFireAtRequired",
	],
	[
		"Auto-lead only applies to START schedules",
		"zerr.scheduleAutoLeadStartOnly",
	],
	[
		"Auto-lead needs an air time to derive from",
		"zerr.scheduleAutoLeadNeedsAirAt",
	],
	["Slate schedules need insertable content", "zerr.scheduleSlateContent"],
	["Slate schedules need a duration", "zerr.scheduleSlateDuration"],
	["Slate schedules need the Bitmovin account", "zerr.scheduleSlateAccount"],
	[
		"Content fields apply to SLATE_IN only",
		"zerr.scheduleContentFieldsSlateOnly",
	],
	//  PR2: core's alertRuleCreateSchema refinements (authored in
	// packages/core — outside the totality test's three schema files, so
	// these entries exist for TRANSLATION, not for a count pin).
	["Numeric alert rules need a threshold", "zerr.alertThresholdRequired"],
	[
		"Only BITRATE_BELOW and FPS_BELOW take a threshold",
		"zerr.alertThresholdNotAllowed",
	],
	["binary is required", "zerr.binaryRequired"],
	["binary must be base64-encoded SCTE-35 data", "zerr.binaryBase64"],
	["At least one signal is required", "zerr.signalsMin"],
	["inputPath is required", "zerr.inputPathRequired"],
	["At least one input is required", "zerr.inputsMin"],
	["Provide exactly one of inputs or source", "zerr.inputsOrSource"],
	["Provide exactly one of source or input", "zerr.sourceOrInput"],
	["A manual stream key must be at least 8 characters", "zerr.streamKeyMin"],
	[
		"A manual stream key may only contain letters, digits, dot, underscore and dash",
		"zerr.streamKeyCharset",
	],
	["subdomain is required", "zerr.subdomainRequired"],
	["subdomain must be at most 63 characters", "zerr.subdomainMax"],
	[
		"subdomain may only contain lowercase letters, digits and dashes",
		"zerr.subdomainCharset",
	],
	["encodingTemplate is required", "zerr.encodingTemplateRequired"],
	["name is required", "zerr.nameRequired"],
	["targetPoolSize must be at least 1", "zerr.targetPoolSizeMin"],
	["targetPoolSize must be at most 100", "zerr.targetPoolSizeMax"],
	["API token is required", "zerr.apiTokenRequired"],
	["AWS account number is required", "zerr.awsAccountNumberRequired"],
	["Compartment OCID is required", "zerr.compartmentOcidRequired"],
	["Encoder version is required", "zerr.encoderVersionRequired"],
	["Network is required", "zerr.networkRequired"],
	["Network name is required", "zerr.networkNameRequired"],
	["Resource group id is required", "zerr.resourceGroupIdRequired"],
	["Security group id is required", "zerr.securityGroupIdRequired"],
	["Subnet OCID is required", "zerr.subnetOcidRequired"],
	["Subnet id is required", "zerr.subnetIdRequired"],
	["Subnet name is required", "zerr.subnetNameRequired"],
	["Subscription id is required", "zerr.subscriptionIdRequired"],
	["Tenancy OCID is required", "zerr.tenancyOcidRequired"],
	["Tenant id is required", "zerr.tenantIdRequired"],
	["16-byte content key as 32 hex chars", "zerr.credKeyHex"],
	["Access key id is required", "zerr.credAccessKeyIdRequired"],
	["Account key is required", "zerr.credAccountKeyRequired"],
	["Account name is required", "zerr.credAccountNameRequired"],
	["Bucket name is required", "zerr.credBucketNameRequired"],
	["HMAC access key is required", "zerr.credHmacAccessKeyRequired"],
	["HMAC secret is required", "zerr.credHmacSecretRequired"],
	["Host is required", "zerr.credHostRequired"],
	["Label is required", "zerr.credLabelRequired"],
	["Login is required", "zerr.credLoginRequired"],
	[
		"Must be a service-account key JSON (client_email, private_key)",
		"zerr.credServiceAccountJson",
	],
	[
		"Must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)",
		"zerr.credIamRoleArn",
	],
	["Must be valid JSON", "zerr.credValidJson"],
	["Namespace is required", "zerr.credNamespaceRequired"],
	["NexGuard license is required", "zerr.credNexguardLicenseRequired"],
	["Password is required", "zerr.credPasswordRequired"],
	[
		"Provide at least one of password / decryptionKey",
		"zerr.credPasswordOrDecryptionKey",
	],
	[
		"Provide both the Digest username and password, or neither — a half pair is rejected by Bitmovin at provisioning",
		"zerr.credMslDigestBothOrNeither",
	],
	// 2026-09-02: the AKAMAI_MSL credential's delivery edge base URL — seven
	// authored refusals, one per defect `parseCredentialEdgeBaseUrl` names.
	["Edge base URL must be at most 512 characters", "zerr.credMslEdgeTooLong"],
	[
		"Edge base URL must be an absolute https URL (https://host/path)",
		"zerr.credMslEdgeInvalid",
	],
	[
		"Edge base URL must use https — viewers load the stream over TLS only",
		"zerr.credMslEdgeScheme",
	],
	[
		"Edge base URL must not embed credentials (user:pass@host) — every viewer receives this link",
		"zerr.credMslEdgeUserinfo",
	],
	[
		"Edge base URL must not carry a query or fragment — supply the event root, not a signed playback URL",
		"zerr.credMslEdgeQuery",
	],
	[
		"Edge base URL must not end with a slash — the app appends the manifest name itself",
		"zerr.credMslEdgeTrailingSlash",
	],
	[
		"Edge base URL must name a public host — localhost and private or link-local addresses cannot be reached by viewers",
		"zerr.credMslEdgePrivateHost",
	],
	["Region is required", "zerr.credRegionRequired"],
	["Secret access key is required", "zerr.credSecretAccessKeyRequired"],
	["Username is required", "zerr.credUsernameRequired"],
	//  — the Akamai MSL credential's two fields.
	["Stream ID must be a positive integer", "zerr.credMslStreamId"],
	["Event name is required", "zerr.credMslEventName"],
	[
		"accessKey and secretKey must be provided together",
		"zerr.accessSecretTogether",
	],
	[
		"Provide EITHER serviceAccountCredentials OR serviceAccountEmail/privateKey/projectId — not both",
		"zerr.gcsEitherOr",
	],
	[
		"Provide serviceAccountCredentials, or ALL of serviceAccountEmail, privateKey and projectId",
		"zerr.gcsAllOfTriple",
	],
	[
		"Required unless serviceAccountCredentials is provided",
		"zerr.requiredUnlessJson",
	],
]);

/** The one dynamic authored sentence (numbers embedded at addIssue time). */
export const CUSTOM_DATA_TOO_LARGE =
	/^customData is too large \((\d+) chars serialized; max (\d+)\)$/;

/** The subset of a zod v4 issue this module reads — structural, so both
    `z.core.$ZodIssue` and the loosened copies plan-import produces fit. */
export type ZodIssueLike = {
	code?: string;
	message: string;
	minimum?: number | bigint;
	maximum?: number | bigint;
	origin?: string;
	expected?: string;
};

export function zodIssueMessage(issue: ZodIssueLike, t: Translator): string {
	const raw = issue.message;
	const authored = SENTENCE_TO_KEY.get(raw);
	if (authored) {
		return t(authored);
	}
	const dynamic = raw.match(CUSTOM_DATA_TOO_LARGE);
	if (dynamic) {
		return t("zerr.customDataTooLarge", {
			size: dynamic[1] as string,
			max: dynamic[2] as string,
		});
	}
	// The code map applies ONLY to zod's OWN default sentences (recognised by
	// their fixed prefixes) — an AUTHORED message riding the same issue code
	// (e.g. an inline .uuid("id must be a UUID")) must reach the raw fallback
	// untouched, not be flattened to a generic. Caught by an existing panel
	// test the first wiring broke (exactly one of 2066 — review of PR #174, S3).
	const isZodDefault =
		raw.startsWith("Too small: ") ||
		raw.startsWith("Too big: ") ||
		raw.startsWith("Invalid input: ") ||
		raw.startsWith("Invalid ");
	if (!isZodDefault) {
		return raw;
	}
	switch (issue.code) {
		case "invalid_type": {
			// zod v4 issues carry no `received` FIELD — it lives only in the
			// default text tail ("…, received undefined"), which is the part
			// that says "you forgot this field" (review of PR #174, S4).
			const received = raw.match(/, received (\w+)$/)?.[1];
			return t("zerr.zInvalidType", {
				expected: issue.expected ?? "?",
				received: received ?? "?",
			});
		}
		case "too_small": {
			const min = issue.minimum ?? "?";
			if (issue.origin === "string") {
				// min(1) on a string is the ubiquitous "this field is required".
				return String(min) === "1"
					? t("zerr.zRequired")
					: t("zerr.zTooSmallChars", { minimum: String(min) });
			}
			if (issue.origin === "array") {
				// "expected array to have >=1 items" — a COUNT, not a numeric
				// bound (review of PR #174, I1: the number wording lost "items").
				// One/Other split per the catalogue precedent (review N1: EN
				// "at least 1 items" was the plural-only artefact).
				return String(min) === "1"
					? t("zerr.zTooSmallItemsOne")
					: t("zerr.zTooSmallItems", { minimum: String(min) });
			}
			return t("zerr.zTooSmallNumber", { minimum: String(min) });
		}
		case "too_big": {
			const max = issue.maximum ?? "?";
			if (issue.origin === "array") {
				return String(max) === "1"
					? t("zerr.zTooBigItemsOne")
					: t("zerr.zTooBigItems", { maximum: String(max) });
			}
			return issue.origin === "string"
				? t("zerr.zTooBigChars", { maximum: String(max) })
				: t("zerr.zTooBigNumber", { maximum: String(max) });
		}
		case "invalid_format":
			// zod's format defaults are specific ("Invalid UUID", "Invalid email
			// address") — keep that specificity for en by translating only the
			// generic frame in ja; en falls through raw and stays byte-identical.
			return t("zerr.zInvalidFormat", { detail: raw });
		default:
			// VISIBLE fallback — an unknown sentence renders as-is.
			return raw;
	}
}
