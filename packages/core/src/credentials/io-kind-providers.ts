import type { CredentialProviderId } from "./schemas";

/**
 * Which credential providers a plan IO `kind` may resolve to.
 *
 * One kind can mean several providers — `GENERIC_S3` is the S3-compatible wire
 * protocol with V4 signing (C10), which Akamai Object Storage, OCI Object
 * Storage and a plain GenericS3 endpoint all speak — so the value is a set, and
 * the credential is what decides between them.
 *
 * This exists because the import wizard's credential collector had its own
 * inline version that returned `AWS_S3` for everything except AZURE and SFTP
 * (audit AA972-IMPORT-001): a GenericS3, GCS, NetStorage or MSL plan sent the
 * operator to an AWS picker, so the credential they picked was either
 * unassignable or wrong in a way that only surfaced at the vendor. The mapping
 * is here rather than in the wizard so that the executor's guards and the
 * picker cannot disagree about what a kind means — `exec-io.ts` enforces the
 * same table at execution time, and a worker test pins the two together.
 */
export const PROVIDERS_FOR_IO_KIND: Readonly<
	Record<string, readonly CredentialProviderId[]>
> = {
	S3: ["AWS_S3"],
	AZURE: ["AZURE_BLOB"],
	SFTP: ["SFTP"],
	GENERIC_S3: ["AKAMAI_OBJECT_STORAGE", "OCI_OBJECT_STORAGE", "GENERIC_S3"],
	GCS: ["GCS_HMAC"],
	GCS_SERVICE_ACCOUNT: ["GCS_SERVICE_ACCOUNT"],
	AKAMAI_NETSTORAGE: ["AKAMAI_NETSTORAGE"],
	AKAMAI_MSL: ["AKAMAI_MSL"],
	LIVE_MEDIA_INGEST: ["LIVE_MEDIA_INGEST"],
	/** Public host, no credential — present so the kind is CLASSIFIED, not missing. */
	HTTPS: [],
};

/**
 * The providers a kind may use, or `undefined` for a kind this table has never
 * heard of.
 *
 * Deliberately NOT defaulting to `AWS_S3`: that default is the defect this
 * table replaces. An unknown kind should be visibly unclassified so a caller
 * can say "I don't know", not confidently send someone to the wrong picker.
 */
export function providersForIoKind(
	kind: unknown,
): readonly CredentialProviderId[] | undefined {
	return typeof kind === "string" ? PROVIDERS_FOR_IO_KIND[kind] : undefined;
}
