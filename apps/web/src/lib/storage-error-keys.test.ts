import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
	isBucketDenied,
	storageErrorDisplay,
	storageListErrorDisplay,
} from "@/lib/storage-error-keys";

/**
 * A 403 on object listing means the KEY is not scoped to that bucket.
 *
 * Owner report 2026-08-20, and it is a regression my own fix created (ledger
 * #112 → #144): `ListBuckets` is ACCOUNT-level on Akamai/Linode and AWS, while
 * an access key can be limited to particular buckets. Measured against the real
 * credentials — each of the two Akamai keys lists all three buckets and can
 * open exactly one:
 *
 *   verify-akamai-output  lists 3  reads bitmovin-api-jp-osa-1        (2 × 403)
 *   verify-akamai-input   lists 3  reads bitmovin-api-jp-osa-1-input  (2 × 403)
 *
 * So before the fix the operator typed a bucket they had access to; after it,
 * they see three and two of them answer "Storage request failed: AccessDenied
 * (upstream 403)" — accurate, English-only, and silent about the cause.
 */
describe("what an operator is told when storage refuses", () => {
	const denied = new ApiError(
		502,
		"Storage request failed: AccessDenied (upstream 403)",
		{ code: "AccessDenied", status: 403 },
	);

	it("recognises a 403 from the classified details, not from the message text", () => {
		expect(isBucketDenied(denied)).toBe(true);
		// Message-sniffing would be the tempting shortcut and would break on the
		// first driver that words it differently — Azure says AuthorizationFailure.
		const azure = new ApiError(
			502,
			"Storage request failed: AuthorizationFailure (upstream 403)",
			{ code: "AuthorizationFailure", status: 403 },
		);
		expect(isBucketDenied(azure)).toBe(true);
	});

	it("explains the bucket-scope cause instead of echoing the code", () => {
		const shown = storageErrorDisplay(denied, "storage.listFailed");
		expect(shown).toEqual({ kind: "key", key: "storage.bucketAccessDenied" });
	});

	it("does NOT claim bucket scope for other failures", () => {
		// The whole value is that this message is specific. A 404, a 500 or a
		// network error explained as "your key lacks access" sends the operator
		// to change a credential that was fine.
		for (const status of [400, 404, 429, 500, 502, 503]) {
			const other = new ApiError(
				502,
				`Storage request failed: X (upstream ${status})`,
				{
					code: "X",
					status,
				},
			);
			expect(isBucketDenied(other), String(status)).toBe(false);
			expect(storageErrorDisplay(other, "storage.listFailed")).toEqual({
				kind: "text",
				text: `Storage request failed: X (upstream ${status})`,
			});
		}
	});

	it("keeps an unclassified ApiError's own text rather than swallowing it", () => {
		// An error the API did not classify must stay visible. A generic
		// fallback here would hide every failure mode nobody has met yet.
		const bare = new ApiError(502, "Storage request failed: SlowDown");
		expect(storageErrorDisplay(bare, "storage.listFailed")).toEqual({
			kind: "text",
			text: "Storage request failed: SlowDown",
		});
	});

	it("falls back to the caller's key for a non-ApiError", () => {
		expect(
			storageErrorDisplay(new TypeError("boom"), "storage.listFailed"),
		).toEqual({ kind: "key", key: "storage.listFailed" });
		expect(storageErrorDisplay(undefined, "ui.failedToListObjects")).toEqual({
			kind: "key",
			key: "ui.failedToListObjects",
		});
	});

	/**
	 * review-282 finding 2: the first version of this file varied the STATUS
	 * (400/404/429/500/502/503) and never the CODE — which is exactly where the
	 * guard was blind. A 403 is also what a rejected CREDENTIAL looks like.
	 */
	it("names the CREDENTIAL, not the bucket, when the code says so", () => {
		for (const code of [
			// A mistyped secret. The credential form is write-only, so the
			// operator cannot re-read what they typed — the single most likely
			// way to meet a 403 here.
			"SignatureDoesNotMatch",
			"InvalidAccessKeyId",
			"InvalidSecurity",
			// Azure's wording, pinned at 403 by packages/storage/src/s3.test.ts.
			"AuthenticationFailed",
			// A clock more than 15 minutes out.
			"RequestTimeTooSkewed",
			"AccountProblem",
			"ExpiredToken",
			"TokenRefreshRequired",
		]) {
			const err = new ApiError(
				502,
				`Storage request failed: ${code} (upstream 403)`,
				{
					code,
					status: 403,
				},
			);
			expect(storageErrorDisplay(err, "storage.listFailed"), code).toEqual({
				kind: "key",
				key: "storage.credentialRejected",
			});
			// And it must NOT mark the bucket: doing so for a broken secret
			// would mark every bucket and teach the operator that the key is
			// scoped to nothing.
			expect(isBucketDenied(err), code).toBe(false);
			// The coarse `isAccessDenied` used to be asserted here. It is gone:
			// it had no production caller and its one natural call site was the
			// bug (review-282 m1), so keeping it tested-but-uncalled was a trap.
		}
	});

	it("still blames the bucket for a bucket-shaped 403", () => {
		for (const code of ["AccessDenied", "AuthorizationFailure", "ApiError"]) {
			const err = new ApiError(502, `x (upstream 403)`, { code, status: 403 });
			expect(isBucketDenied(err), code).toBe(true);
			expect(storageErrorDisplay(err, "storage.listFailed"), code).toEqual({
				kind: "key",
				key: "storage.bucketAccessDenied",
			});
		}
	});

	it("treats a 403 with NO code as bucket-shaped — the disjunction stays true", () => {
		// GCS degrades `code` to its class name and some paths carry none at
		// all. The bucket sentence is a disjunction precisely so it is still
		// honest when we cannot tell which cause it is.
		const err = new ApiError(502, "x (upstream 403)", { status: 403 });
		expect(isBucketDenied(err)).toBe(true);
	});

	/**
	 * The LIST-level 403 must not borrow the object-level sentence.
	 *
	 * review-282 rendered the picker and printed the hint: it read "Pick
	 * another, or use a credential with access to this one" over a refused
	 * LIST, where there is nothing to pick from — the exact reuse a comment
	 * nine lines above the call site said was impossible. And
	 * `bucketListDenied`, added and translated for this, was rendered by
	 * nothing.
	 */
	it("tells the operator the LIST was refused, not to pick another bucket", () => {
		const denied403 = new ApiError(502, "x (upstream 403)", {
			code: "AccessDenied",
			status: 403,
		});
		expect(storageListErrorDisplay(denied403, "storage.listFailed")).toEqual({
			kind: "key",
			key: "storage.bucketListDenied",
		});
		// And it must NOT be the object-level sentence, which is what shipped.
		expect(
			storageListErrorDisplay(denied403, "storage.listFailed"),
		).not.toEqual({ kind: "key", key: "storage.bucketAccessDenied" });
	});

	it("still names the credential at list level when the code says so", () => {
		// A mistyped secret refuses the LIST too, and "this credential cannot
		// list buckets" would send them hunting for a permission that is not
		// the problem.
		const err = new ApiError(502, "x (upstream 403)", {
			code: "SignatureDoesNotMatch",
			status: 403,
		});
		expect(storageListErrorDisplay(err, "storage.listFailed")).toEqual({
			kind: "key",
			key: "storage.credentialRejected",
		});
	});

	it("keeps a capability refusal's own text at list level (ledger #112)", () => {
		// The 400 path carries an authored sentence that says what to do — e.g.
		// the GCS service-account key with no project_id. Classifying it away
		// would lose the only actionable half.
		const refusal = new ApiError(
			400,
			"Service-account key has no project_id — enter the bucket name manually",
		);
		expect(storageListErrorDisplay(refusal, "storage.listFailed")).toEqual({
			kind: "text",
			text: "Service-account key has no project_id — enter the bucket name manually",
		});
	});

	it("maps unsupported browsing to locale-owned copy for object and list views", () => {
		const unsupported = new ApiError(400, "raw English capability prose", {
			code: "STORAGE_BROWSE_UNSUPPORTED",
		});
		expect(storageErrorDisplay(unsupported, "storage.listFailed")).toEqual({
			kind: "key",
			key: "storage.browseUnsupported",
		});
		expect(storageListErrorDisplay(unsupported, "storage.listFailed")).toEqual({
			kind: "key",
			key: "storage.browseUnsupported",
		});
	});
});
