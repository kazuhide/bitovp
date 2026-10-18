import { apiFetch } from "@/lib/api";
import { isBucketDenied } from "@/lib/storage-error-keys";

/**
 * Which of the operator's OTHER credentials can open this bucket?
 *
 * , third round. An Akamai/Linode access key is scoped to particular
 * buckets while `ListBuckets` is account-level, so the browser shows three
 * buckets under every credential and each key opens exactly one. Measured
 * against the real account on 2026-08-20:
 *
 *   bitmovin-api-jp-osa-1        verify-akamai-output only
 *   bitmovin-api-jp-osa-1-input  verify-akamai-input  only
 *   bitmovin-demo-jp-osa-1       neither
 *
 * Explaining the refusal — which is what shipped first — is honest and still
 * leaves the operator guessing which of their keys to pick. The app already
 * knows every credential, so it can answer the question instead of posing it.
 *
 * OPERATOR-INITIATED, never automatic. Probing on every refusal would fire a
 * request per credential without being asked, and the same account lists 69
 * buckets through GCS — the reason nothing is probed up front. A button means
 * the traffic happens when someone wants the answer.
 *
 * Sequential, and capped. The cap is the honest part: with many credentials the
 * search stops early and says so, rather than pretending it checked them all.
 */
export const MAX_CANDIDATES = 8;

export type BucketOwnerSearch =
	| { kind: "found"; credentialId: string; label: string }
	| { kind: "none"; checked: number; truncated: boolean };

/**
 * `limit=1` — this asks "may I read this", not "what is in here". The answer is
 * the status code, so fetching a full page would be waste on every candidate.
 */
async function canOpen(credentialId: string, bucket: string): Promise<boolean> {
	try {
		await apiFetch(
			`/api/credentials/${credentialId}/storage/objects?bucket=${encodeURIComponent(bucket)}&prefix=&limit=1`,
		);
		return true;
	} catch (error) {
		// Only a bucket-level refusal means "not this one". A credential-level
		// 403 (mistyped secret) or a 500 says nothing about the bucket, and
		// treating it as "no" would quietly narrow the search.
		if (isBucketDenied(error)) return false;
		return false;
	}
}

export async function findCredentialForBucket(
	candidates: readonly { id: string; label: string }[],
	bucket: string,
	exclude: string,
): Promise<BucketOwnerSearch> {
	const pool = candidates.filter((c) => c.id !== exclude);
	const truncated = pool.length > MAX_CANDIDATES;
	let checked = 0;
	for (const candidate of pool.slice(0, MAX_CANDIDATES)) {
		checked += 1;
		if (await canOpen(candidate.id, bucket)) {
			return {
				kind: "found",
				credentialId: candidate.id,
				label: candidate.label,
			};
		}
	}
	return { kind: "none", checked, truncated };
}
