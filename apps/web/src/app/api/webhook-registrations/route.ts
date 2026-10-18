import { webhookUrlMatchesBase } from "@bitovp/core";
import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server/context";
import { routeError } from "@/lib/server/http";
import { currentIngressBaseUrl } from "@/lib/server/ingress";

/**
 * Per-encoding webhook registrations (WP-G G-2) — the rows the worker's
 * registrar keeps for every live job / run, projected for Settings →
 * Webhooks: which encoding, which kind, whether the registered URL still
 * sits under the CURRENT public ingress, and when Bitmovin last delivered
 * to it. Read-only and bounded (the working set is small: four rows per
 * live encoding, tombstones pruned after seven days); the one action —
 * "re-register now" — is its sibling `./reconcile`.
 *
 * No secrets can appear here: the row stores the URL (what Bitmovin holds)
 * and a token HASH; the HMAC key is derived, never stored.
 */
const MAX_ROWS = 500;

const RETIRE_NOTES = [
	"terminal",
	"orphan",
	"ingressChanged",
	"keyRotated",
	"idle",
	"intervalChanged",
	"perEncodingOnly",
];
const SAFE_NOTES = new Set([
	"PER_ENCODING",
	"LEGACY_ACCOUNT",
	"PENDING_VERSION",
	"POLL_ONLY",
	"heartbeat: creating",
	"heartbeat: registered",
	"heartbeat: retired",
	"heartbeat: budget",
	"heartbeat: slots",
	"heartbeat: ambiguous",
	"heartbeat: provider",
	"heartbeat: unresolved create cleanup",
	"pending",
	"ingressUnavailable",
	"provider: registration failed",
	...RETIRE_NOTES,
	...RETIRE_NOTES.map((reason) => `delete failed (${reason})`),
]);

/** Legacy notes may contain SDK request bodies with receiver tokens/HMAC keys.
 * Allow only known local diagnostics; never try to redact arbitrary exception text.
 */
function safeRegistrationNote(note: string | null): string | null {
	if (note === null || SAFE_NOTES.has(note)) return note;
	const interval = /^interval ([1-9]\d{0,8})s$/.exec(note);
	if (interval?.[0] === note) return `interval ${Number(interval[1])}s`;
	return "details withheld";
}

/** `.../api/webhooks/bitmovin/<scope>/<token>` → `.../<scope>/<token>` literal. */
function maskReceiverToken(url: string): string {
	return url.replace(/\/([a-z]+)\/[A-Za-z0-9_-]{22}$/, "/$1/<token>");
}

export async function GET() {
	try {
		const ctx = await getServerContext();
		const currentBase = await currentIngressBaseUrl(ctx.prisma);
		const rows = await ctx.prisma.webhookRegistration.findMany({
			orderBy: [{ updatedAt: "desc" }, { kind: "asc" }],
			take: MAX_ROWS,
			select: {
				id: true,
				scope: true,
				encodingId: true,
				kind: true,
				status: true,
				url: true,
				note: true,
				attempts: true,
				nextAttemptAt: true,
				registeredAt: true,
				deletedAt: true,
				lastDeliveryAt: true,
				updatedAt: true,
				encodingJobId: true,
				liveChannelRunId: true,
				encodingJob: { select: { name: true, status: true } },
				liveChannelRun: {
					select: {
						seq: true,
						status: true,
						liveChannel: { select: { id: true, name: true } },
					},
				},
			},
		});
		return NextResponse.json({
			currentBase,
			rows: rows.map((row) => ({
				id: row.id,
				scope: row.scope,
				encodingId: row.encodingId,
				kind: row.kind,
				status: row.status,
				// The token IS the receiver's address (rev413): readers see the base
				// and the scope, never the token itself.
				url: row.url === null ? null : maskReceiverToken(row.url),
				urlMatchesIngress:
					row.url !== null &&
					currentBase !== null &&
					webhookUrlMatchesBase(row.url, currentBase),
				note: safeRegistrationNote(row.note),
				attempts: row.attempts,
				nextAttemptAt: row.nextAttemptAt,
				registeredAt: row.registeredAt,
				deletedAt: row.deletedAt,
				lastDeliveryAt: row.lastDeliveryAt,
				updatedAt: row.updatedAt,
				subject: row.encodingJob
					? {
							kind: "job" as const,
							id: row.encodingJobId as string,
							name: row.encodingJob.name,
							status: row.encodingJob.status,
						}
					: row.liveChannelRun
						? {
								kind: "run" as const,
								id: row.liveChannelRunId as string,
								name: row.liveChannelRun.liveChannel.name,
								channelId: row.liveChannelRun.liveChannel.id,
								seq: row.liveChannelRun.seq,
								status: row.liveChannelRun.status,
							}
						: null,
			})),
		});
	} catch (err) {
		return routeError(err);
	}
}
