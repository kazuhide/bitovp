export type { AzureBrowserOptions } from "./azure";
export { createAzureBrowser } from "./azure";
export type { DigestedTransfer } from "./digest";
export {
	assertCompleteTransfer,
	digestStream,
	pipeWithDigest,
	ShortReadError,
} from "./digest";
export type { BrowserCredential } from "./factory";
// `akamaiRegionFromHost` moved to @bitovp/core (credentials/addressing) so the
// playback URL builder shares it — import it from there.
export { createBrowserForCredential } from "./factory";
export { createGcsBrowser } from "./gcs";
export {
	assertSafeProbePrefix,
	MIN_PROBE_PREFIX_LENGTH,
	type ObjectStorageReaper,
	probeReaperForCredential,
	SENTINEL,
	UnsafeProbePrefixError,
} from "./reaper";
export type { S3BrowserOptions } from "./s3";
export { createS3Browser } from "./s3";
export type {
	SearchObjectsInput,
	SearchObjectsResult,
	SearchScan,
} from "./search";
export {
	matchesObjectName,
	SEARCH_MAX_MATCHES,
	SEARCH_MAX_PAGES,
	searchObjects,
} from "./search";
export type {
	BucketCorsRule,
	GetObjectInput,
	ListObjectsInput,
	ListObjectsResult,
	ObjectIdentity,
	ObjectStorageBrowser,
	ObjectVersion,
	StorageObject,
} from "./types";
export {
	clampLimit,
	describeStorageError,
	MAX_PAGE_SIZE,
	ObjectVersionMismatchError,
	storageErrorText,
	UnsupportedBrowseError,
	VersionExpectationUnsupportedError,
} from "./types";
