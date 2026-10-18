import type { PlanIssue } from "@bitovp/core";
import { writeAuditLog } from "./audit";
import type { AppPrismaClient } from "./client";

/**
 * Makes the C22 fail-open state DURABLE . An unrestricted-egress
 * warning does not block the job, so without a record the fact that vault
 * material is about to leave for an unvetted host would appear nowhere an
 * operator looks. Filed to the C7 AuditLog (queryable, restart-surviving).
 *
 * Moved here from apps/web : the watch-folder sweep is a
 * SECOND submitter process and a copied loop would drift — the same reason
 * submitEncodingJob was extracted. Never throws: writeAuditLog swallows its
 * own failures by design, and a job must not fail because its warning could
 * not be filed.
 */
export async function recordUnrestrictedEgress(
	prisma: AppPrismaClient,
	issues: PlanIssue[],
	subject: {
		path: string;
		bitmovinAccountId?: string;
		/**
		 * Who caused this egress decision, REQUIRED.
		 *
		 * This writer has no Request to read the proxy's header from — it is
		 * shared with the worker's watch-folder sweep, which has no HTTP caller
		 * at all. Optional would have made it the third silent population after
		 * `auditedBitmovinCall` and `delete*JobLocally` (security-review-212);
		 * required means each caller states its identity, and "no user did
		 * this, a sweep did" is written down rather than inferred from a null.
		 *
		 * `null` is a legal value and means "this caller genuinely cannot know"
		 * — it writes no actor key at all, the same as the request-bearing
		 * wrapper does. Required-but-nullable keeps absence a decision without
		 * inviting a fabricated identity to satisfy the type.
		 */
		actor: string | null;
	},
): Promise<void> {
	const unrestricted = issues.filter(
		(issue) => issue.code === "PLAN_SECRET_EGRESS_HOST_UNRESTRICTED",
	);
	for (const issue of unrestricted) {
		await writeAuditLog(prisma, {
			method: "POLICY",
			path: subject.path,
			bitmovinAccountId: subject.bitmovinAccountId,
			actor: subject.actor,
			// `request`, not `error`: nothing failed. This is a policy decision
			// worth being able to query later, which needs the field and the
			// host, not a message.
			request: {
				policy: "SECRET_EGRESS_HOST_UNRESTRICTED",
				field: issue.path,
				detail: issue.message,
			},
		});
	}
}
