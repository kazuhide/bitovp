import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import { ingestConnectedFresh } from "@bitovp/core";
import type { NextResponse } from "next/server";
import { customerErrorDetails } from "@/lib/customer-error";
import { bitmovinClientForAccount } from "./bitmovin";
import type { ServerContext } from "./context";
import { jsonError } from "./http";

/**
 * Resolves a managed live channel into the Bitmovin encoding its RUNTIME
 * actions (ESAM media points, content insertion, DNS mappings) address.
 *
 * The Bitmovin encodingId comes from the channel ROW (`bitmovinEncodingId`,
 * written by the live-channel worker when it creates the encoding) — the same
 * source the /actions stop/restart branches read; the step log is the fallback
 * only for resource ids the row does not denormalize, and this one it does.
 *
 * `requireRunning` gates the runtime surface: an ESAM cue or a content
 * insertion is meaningless unless the encoder is live, so a non-RUNNING
 * channel 409s here rather than producing an upstream 4xx.
 */
export async function resolveLiveEncoding(options: {
	ctx: ServerContext;
	channelId: string;
	bitmovinAccountId: string;
	requireRunning: boolean;
	/* Content insertion requires connected ingest: an accepted request during ingest waiting can render nothing. Keep this opt-in because ESAM and SCTE signaling follow the encoder rather than the output media timeline. */
	requireIngestConnected?: boolean;
	/** Verb used in the 409 message, e.g. "ESAM media points". */
	subject: string;
}): Promise<
	| { ok: true; api: BitmovinApi; encodingId: string }
	| { ok: false; response: NextResponse }
> {
	const { ctx, channelId, bitmovinAccountId, requireRunning, subject } =
		options;
	const channel = await ctx.prisma.liveChannel.findUnique({
		where: { id: channelId },
		select: {
			status: true,
			bitmovinEncodingId: true,
			bitmovinAccountId: true,
			lastHeartbeat: true,
			//  PR2b: run-first, channel fallback.
			runs: {
				orderBy: { seq: "desc" },
				take: 1,
				select: { lastHeartbeat: true },
			},
		},
	});
	if (!channel) {
		return { ok: false, response: jsonError(404, "Not found") };
	}
	// The account is an explicit request parameter (every route in this surface
	// takes one) — refuse a mismatch instead of driving another org's API key at
	// this channel's encoding, which would 404 upstream and audit under the
	// wrong account.
	// FAIL CLOSED on a null account (review catch B1): the column is
	// `String?` with onDelete: SetNull and the account-delete route has no
	// referential guard, so deleting an account nulls it on every channel that
	// referenced it. Treating null as "matches anything" would let ANY account's
	// decrypted key be driven at this channel's encoding, audited under the
	// caller's id. The worker resolves the same case from plan.bitmovin.accountId
	// (never from caller input); a route cannot, so it refuses.
	if (channel.bitmovinAccountId === null) {
		return {
			ok: false,
			response: jsonError(
				409,
				"Channel has no Bitmovin account attached (was the account deleted?) — re-attach one before using runtime actions",
				customerErrorDetails("LIVE_RUNTIME_ACCOUNT_MISSING"),
			),
		};
	}
	if (channel.bitmovinAccountId !== bitmovinAccountId) {
		return {
			ok: false,
			response: jsonError(
				400,
				"bitmovinAccountId does not match this channel's Bitmovin account",
				customerErrorDetails("LIVE_RUNTIME_ACCOUNT_MISMATCH"),
			),
		};
	}
	if (requireRunning && channel.status !== "RUNNING") {
		return {
			ok: false,
			response: jsonError(
				409,
				`${subject} need a RUNNING channel (status: ${channel.status})`,
				customerErrorDetails("LIVE_RUNTIME_REQUIRES_RUNNING", {
					status: channel.status,
				}),
			),
		};
	}
	if (
		options.requireIngestConnected &&
		!ingestConnectedFresh(
			// review-243 R1 (one rule): this 409 rail is a gate too — a run's
			// null must not borrow the previous airing's proof.
			// adds the time axis: a REVIVED run keeps its pre-error sample on
			// the SAME row, so presence alone let a stopped-then-resumed
			// encoder accept an insert against no input; fresh-or-nothing.
			channel.runs?.[0] ? channel.runs[0].lastHeartbeat : channel.lastHeartbeat,
			Date.now(),
		)
	) {
		return {
			ok: false,
			response: jsonError(
				409,
				`${subject} need a CONNECTED ingest — the encoder is up but no input is bound, so the insert would be accepted and render nothing`,
				customerErrorDetails("LIVE_RUNTIME_INGEST_NOT_CONNECTED"),
			),
		};
	}
	if (!channel.bitmovinEncodingId) {
		return {
			ok: false,
			response: jsonError(
				409,
				"Channel has no Bitmovin encoding yet",
				customerErrorDetails("LIVE_RUNTIME_ENCODING_UNAVAILABLE"),
			),
		};
	}
	const api = await bitmovinClientForAccount(ctx, bitmovinAccountId);
	if (!api) {
		return {
			ok: false,
			response: jsonError(
				404,
				"Bitmovin account not found",
				customerErrorDetails("LIVE_RUNTIME_ACCOUNT_UNAVAILABLE"),
			),
		};
	}
	return { ok: true, api, encodingId: channel.bitmovinEncodingId };
}
