import { ApiError } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";

export type { MessageKey };

/**
 * What to SHOW an operator when a storage request fails.
 *
 * The API classifies the failure (`{ code, status }` in `details`, C20-safe —
 * never the vendor's own message) and this turns it into something actionable
 * and translatable.
 *
 * TWO axes, and the second one was missing at first (review-282 finding 2).
 *
 * STATUS alone says "refused", not why. The reason this started was a real
 * bucket-scope denial: an Akamai/Linode key can be limited to particular
 * buckets while `ListBuckets` is ACCOUNT-level and ignores that scoping, so the
 * list shows three buckets and the key opens one. But a 403 is also what you
 * get when the CREDENTIAL ITSELF is rejected — a mistyped secret
 * (`SignatureDoesNotMatch`), a wrong or disabled key (`InvalidAccessKeyId`,
 * `AuthenticationFailed`, pinned at 403 by `packages/storage/src/s3.test.ts`),
 * a clock more than 15 minutes out (`RequestTimeTooSkewed`), a suspended
 * account. Telling THAT operator to "pick another bucket" is worse than saying
 * nothing: the credential form is write-only, so they cannot re-read the secret
 * they mistyped, and they would click every bucket, watch all of them get
 * marked, and conclude the key is scoped to nothing.
 *
 * So the CODE decides which sentence, and the bucket-scope one is a disjunction
 * rather than a single confident cause — it can also be a missing
 * `s3:ListBucket` on a key that reads objects from that very bucket happily.
 *
 * Returns a message KEY when we can explain the failure, and the raw text
 * otherwise — the fallback keeps every unclassified error visible rather than
 * swallowing it behind a generic sentence.
 */
export type StorageErrorDisplay =
	| { kind: "key"; key: MessageKey }
	| { kind: "text"; text: string };

/**
 * 403 codes that mean THE CREDENTIAL, not this bucket.
 *
 * Names as the three SDKs emit them: AWS/S3-compatible use the S3 error codes,
 * Azure's `RestError` puts `AuthenticationFailed` on `code`. GCS degrades to
 * the class name `"ApiError"`, which is why membership here is a positive list
 * and everything unrecognised falls to the bucket-scope disjunction — that
 * sentence is a disjunction precisely so it stays true when we cannot tell.
 */
const CREDENTIAL_REJECTED = new Set([
	"SignatureDoesNotMatch",
	"InvalidAccessKeyId",
	"InvalidSecurity",
	"AuthenticationFailed",
	"RequestTimeTooSkewed",
	"AccountProblem",
	"ExpiredToken",
	"TokenRefreshRequired",
]);

function classified(error: unknown): { code?: string; status?: number } {
	if (!(error instanceof ApiError)) return {};
	const details = error.details as
		| { code?: unknown; status?: unknown }
		| undefined;
	return {
		code: typeof details?.code === "string" ? details.code : undefined,
		status: typeof details?.status === "number" ? details.status : undefined,
	};
}

/*
 * There was an `isAccessDenied(error)` here — "status === 403", nothing more.
 * It had no production caller after the two-axis split, and its ONE plausible
 * call site was the bucket marker, where using it is exactly the defect
 * review-282 found (a mistyped secret marking every bucket). A tested predicate
 * whose only natural use is the bug is a trap for the next reader, so it is
 * gone rather than kept for symmetry. `isBucketDenied` is the question the app
 * actually asks.
 */

/* A bucket access marker must distinguish refusal of this bucket from invalid credentials. A mistyped secret must not label every bucket as inaccessible. */
export function isBucketDenied(error: unknown): boolean {
	const { code, status } = classified(error);
	return (
		status === 403 && !(code !== undefined && CREDENTIAL_REJECTED.has(code))
	);
}

export function storageErrorDisplay(
	error: unknown,
	fallback: MessageKey,
): StorageErrorDisplay {
	const { code, status } = classified(error);
	if (code === "STORAGE_BROWSE_UNSUPPORTED") {
		return { kind: "key", key: "storage.browseUnsupported" };
	}
	if (status === 403) {
		return {
			kind: "key",
			key:
				code !== undefined && CREDENTIAL_REJECTED.has(code)
					? "storage.credentialRejected"
					: "storage.bucketAccessDenied",
		};
	}
	if (error instanceof ApiError) {
		return { kind: "text", text: error.message };
	}
	return { kind: "key", key: fallback };
}

/**
 * The same failure, asked about the BUCKET LIST rather than one bucket.
 *
 * `storageErrorDisplay` cannot be reused here and I wrote that down in a
 * comment before shipping the opposite: its 403 sentence says "pick another
 * bucket, or use a credential with access to this one" and mentions buckets
 * "appearing here", and on this path the list itself was refused — there is
 * nothing to pick from and nothing appearing. review-282 rendered the picker
 * and printed the hint to prove it.
 *
 * `bucketListDenied` existed, was translated, and was rendered by NOTHING — an
 * orphan holding the true sentence while the shipped hint held the false one.
 * The same shape is recorded twice already in `i18n.test.ts` (`live.
 * mslNotEditableYet`, `wizard.presets`), which is why this function exists
 * instead of a third orphan.
 *
 * Both callers append the manual-entry instruction themselves — the reason the
 * operator is being told any of this is that they must now type the name.
 */
export function storageListErrorDisplay(
	error: unknown,
	fallback: MessageKey,
): StorageErrorDisplay {
	const { code, status } = classified(error);
	if (code === "STORAGE_BROWSE_UNSUPPORTED") {
		return { kind: "key", key: "storage.browseUnsupported" };
	}
	if (status === 403) {
		return {
			kind: "key",
			key:
				code !== undefined && CREDENTIAL_REJECTED.has(code)
					? "storage.credentialRejected"
					: "storage.bucketListDenied",
		};
	}
	// A capability refusal arrives as a 400 whose message says what to do
	//  — that text is the actionable half and must survive.
	if (error instanceof ApiError) {
		return { kind: "text", text: error.message };
	}
	return { kind: "key", key: fallback };
}
