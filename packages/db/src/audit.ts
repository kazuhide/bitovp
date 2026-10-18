import { redactSecrets } from "@bitovp/core";
import type { Prisma } from "../generated/client";
import type { AppPrismaClient } from "./client";

export type AuditEntry = {
	method: string;
	path: string;
	/**
	 * Who caused this, REQUIRED but nullable.
	 *
	 * Optional made this the chokepoint's own bypass: `@bitovp/db` exports
	 * this writer, so any consumer — a script, a package, a new worker
	 * subsystem — could call it with no actor and compile clean, right next
	 * to the required-argument web wrapper in the same import namespace
	 * (security-review-212 compiled exactly that route). Required-but-nullable
	 * makes absence a decision each caller writes down, the same shape
	 * `recordUnrestrictedEgress` already uses; `null` writes no actor key.
	 */
	actor: string | null;
	statusCode?: number;
	durationMs?: number;
	bitmovinAccountId?: string;
	request?: unknown;
	response?: unknown;
	error?: string;
};

/**
 * Persists one Bitmovin API call (REQUIREMENTS §6 auditability). EVERY
 * persisted field passes through redactSecrets — SDK error strings can
 * embed request bodies/URLs. Shared by web route handlers and the
 * orchestrator worker; never throws (an audit failure must not break the
 * call it documents).
 */
export async function writeAuditLog(
	prisma: AppPrismaClient,
	entry: AuditEntry,
): Promise<void> {
	try {
		await prisma.auditLog.create({
			data: {
				...(entry.actor ? { actor: entry.actor } : {}),
				method: entry.method,
				path: entry.path,
				statusCode: entry.statusCode,
				durationMs: entry.durationMs,
				bitmovinAccountId: entry.bitmovinAccountId,
				request:
					entry.request === undefined
						? undefined
						: (redactSecrets(entry.request) as Prisma.InputJsonValue),
				response:
					entry.response === undefined
						? undefined
						: (redactSecrets(entry.response) as Prisma.InputJsonValue),
				error:
					entry.error === undefined ? undefined : redactSecrets(entry.error),
			},
		});
	} catch (err) {
		console.error(
			"[audit] failed to persist audit log:",
			err instanceof Error ? err.message : err,
		);
	}
}
