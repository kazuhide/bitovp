import {
	FEEDER_PROCESS_RECLAIMED_WHERE,
	FEEDER_PUBLISHER_CLAIM_RELEASED_WHERE,
	feederProcessMayBeAlive,
	feederPublisherClaimHeld,
	isFeederActiveStatus,
	redactSecrets,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { ROLE_HEADER } from "@/lib/auth/roles";
import { customerErrorDetails } from "@/lib/customer-error";
import { isInternalFeederError } from "@/lib/feeder-error-audience";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { invalidIdResponse, jsonError, routeError } from "@/lib/server/http";

type RouteParams = { params: Promise<{ id: string }> };

/** Last N boundaries returned to the administrator diagnostics disclosure. */
const RECENT_BOUNDARIES = 20;

/**
 * Customer detail is an explicit, task-oriented projection. Process identity,
 * host ownership, logs and loop-boundary telemetry are intentionally absent;
 * an ADMIN/owner may request those separately with `?diagnostics=1`.
 *
 * `target` is returned through redactSecrets so an RTMP stream key remains a
 * worker-only value while the customer can still inspect the input endpoint.
 */
export async function GET(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const diagnostics =
			new URL(req.url).searchParams.get("diagnostics") === "1";
		if (diagnostics) {
			// The proxy overwrites both headers before forwarding. Password/none
			// modes have one owner; users/token modes must prove an ADMIN role. Keep
			// this route-local guard even though ordinary detail reads are VIEWER-safe.
			const actor = req.headers.get(ACTOR_HEADER);
			const roleResolvedPrincipal =
				actor?.startsWith("user:") === true ||
				(actor?.startsWith("token:") === true && actor !== "token:unresolved");
			const diagnosticsAllowed =
				actor === "session" ||
				actor === "none" ||
				(roleResolvedPrincipal && req.headers.get(ROLE_HEADER) === "ADMIN");
			if (!diagnosticsAllowed) {
				return jsonError(403, "Administrator access required");
			}

			const ctx = await getServerContext();
			const row = await ctx.prisma.feederSession.findUnique({
				where: { id },
				select: {
					pid: true,
					ownerHost: true,
					processGoneAt: true,
					loopBoundaries: true,
					logTail: true,
					error: true,
				},
			});
			if (!row) {
				return jsonError(404, "Not found");
			}
			const boundaries = Array.isArray(row.loopBoundaries)
				? row.loopBoundaries
				: [];
			return NextResponse.json({
				pid: row.pid,
				ownerHost: row.ownerHost,
				processGoneAt: row.processGoneAt,
				logTail: row.logTail,
				error: row.error,
				loopBoundaryCount: boundaries.length,
				recentLoopBoundaries: boundaries.slice(-RECENT_BOUNDARIES),
			});
		}

		const ctx = await getServerContext();
		const row = await ctx.prisma.feederSession.findUnique({
			where: { id },
			select: {
				id: true,
				liveChannelId: true,
				status: true,
				protocol: true,
				sourceBucket: true,
				sourceKey: true,
				sourceEtag: true,
				sourceVersionId: true,
				sourceGeneration: true,
				sourceSize: true,
				sourceSha256: true,
				loopProfile: true,
				target: true,
				pid: true,
				processGoneAt: true,
				publisherClaimedAt: true,
				publisherReleasedAt: true,
				startedAt: true,
				stoppedAt: true,
				error: true,
				createdAt: true,
				updatedAt: true,
			},
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		const internalFailure =
			typeof row.error === "string" && isInternalFeederError(row.error);
		return NextResponse.json({
			id: row.id,
			liveChannelId: row.liveChannelId,
			status: row.status,
			protocol: row.protocol,
			sourceBucket: row.sourceBucket,
			sourceKey: row.sourceKey,
			// Exact source seal used by the paid verifier. These are immutable
			// object metadata and a digest of the bytes the feeder downloaded; no
			// credential or signed URL is exposed.
			sourceEtag: row.sourceEtag,
			sourceVersionId: row.sourceVersionId,
			sourceGeneration: row.sourceGeneration,
			sourceSize: row.sourceSize?.toString() ?? null,
			sourceSha256: row.sourceSha256,
			// : the normalized loop the feeder actually pushed (frames, fps,
			// seconds, source digest) — the timeline the VMAF aligner reads. Plain
			// numbers and a digest; no path, host or credential.
			loopProfile: row.loopProfile ?? null,
			// Masks streamKey (and any other secret-ish field); url/host/port
			// and the SRT passphraseCredentialId ref stay readable.
			target: redactSecrets(row.target),
			stoppable:
				isFeederActiveStatus(row.status) ||
				feederProcessMayBeAlive(row) ||
				feederPublisherClaimHeld(row),
			startedAt: row.startedAt,
			stoppedAt: row.stoppedAt,
			error: internalFailure ? null : row.error,
			internalFailure,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});
	} catch (err) {
		return routeError(err);
	}
}

/** Sentinel: the atomic terminal-guard matched 0 rows → return 409. */
class SessionNotDeletable extends Error {}

/**
 * Delete a terminal feeder session — LOCAL record only (its target/logTail/
 * loopBoundaries are JSON columns on the row, so they go with it). We never
 * touch the ffmpeg process or any storage; stop the session first if it is
 * still pushing.
 *
 * Terminal-only: only STOPPED and ERROR are deletable. CREATED / DOWNLOADING /
 * PUSHING return 409 (stop it first) — pulling the row while the supervisor is
 * still running ffmpeg would orphan the process and lose its forensics.
 *
 * Terminal is NOT sufficient (audit 2026-08-29 CRITICAL-2). An ERROR row left
 * by a START job that died outside the worker keeps its pid on purpose: the
 * `-stream_loop -1` ffmpeg survives the worker, and that number is the only
 * pointer to it. Deleting such a row erased the last reference to a process
 * still pushing into a live ingest — the exact forensics-loss this comment
 * already refuses for an active row, one status further along. So a row whose
 * pid has never been PROVEN gone is refused too, and the message names the
 * stop action, which is what reaches the worker's kill ladder.
 *
 * The terminal check is enforced ATOMICALLY (a status-guarded deleteMany whose
 * count is asserted), mirroring the atomic-claim convention of the sibling
 * routes; the up-front findUnique only serves the clean 404/409 responses and
 * does NOT gate the delete. Feeder sessions have no dependents, so the
 * transaction is a single guarded delete (kept in $transaction form for a
 * uniform throw-on-0 across all four DELETE routes).
 */
export async function DELETE(req: Request, { params }: RouteParams) {
	const { id } = await params;
	const invalid = invalidIdResponse(id);
	if (invalid) {
		return invalid;
	}
	try {
		const ctx = await getServerContext();
		const row = await ctx.prisma.feederSession.findUnique({
			where: { id },
			select: {
				id: true,
				status: true,
				pid: true,
				processGoneAt: true,
				publisherClaimedAt: true,
				publisherReleasedAt: true,
			},
		});
		if (!row) {
			return jsonError(404, "Not found");
		}
		if (row.status !== "STOPPED" && row.status !== "ERROR") {
			return jsonError(
				409,
				`Session is still ${row.status} — stop it before deleting`,
				customerErrorDetails("FEEDER_STOP_BEFORE_DELETE"),
			);
		}
		if (feederProcessMayBeAlive(row)) {
			return jsonError(
				409,
				"Session still has a publisher process whose exit is unconfirmed — stop the session first, then delete",
				customerErrorDetails("FEEDER_SHUTDOWN_PENDING"),
			);
		}
		/**
		 * Audit 5c3d97ca LC-02: a held PUBLISHER CLAIM is the third thing a
		 * terminal row can still own. The claim is released only on positive
		 * proof that the process is gone, so a terminal row that holds one is a
		 * row whose owning worker has not yet observed its child's exit (the
		 * lost-stop window) — deleting it would erase the channel's occupancy
		 * record while the push is being torn down.
		 */
		if (feederPublisherClaimHeld(row)) {
			return jsonError(
				409,
				"Session still owns this channel's input — retry in a moment, or stop the session before deleting",
				customerErrorDetails("FEEDER_SHUTDOWN_PENDING"),
			);
		}
		await ctx.prisma.$transaction(async (tx) => {
			// The pid guard AND the claim guard are enforced ATOMICALLY alongside
			// the status guard, like every other check on this route: a reclaim
			// or a release that has not happened yet must not lose a race with
			// the delete. Both filters are the SHARED fragments, not hand
			// translations of the predicates — core pins each to its predicate
			// row by row (review MEDIUM-2); `AND` because each carries an `OR`.
			const { count } = await tx.feederSession.deleteMany({
				where: {
					id,
					status: { in: ["STOPPED", "ERROR"] },
					AND: [
						FEEDER_PROCESS_RECLAIMED_WHERE,
						FEEDER_PUBLISHER_CLAIM_RELEASED_WHERE,
					],
				},
			});
			if (count === 0) {
				throw new SessionNotDeletable();
			}
		});
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path: `/api/feeder-sessions/${id}`,
				statusCode: 200,
				response: { id },
			},
			req,
		);
		return NextResponse.json({ id, deleted: true });
	} catch (err) {
		if (err instanceof SessionNotDeletable) {
			return jsonError(
				409,
				"Session changed state and was not deleted — refresh and retry",
				customerErrorDetails("FEEDER_STATE_CHANGED"),
			);
		}
		return routeError(err);
	}
}
