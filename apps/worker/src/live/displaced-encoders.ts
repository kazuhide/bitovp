import { classifyProviderStatusWord } from "@bitovp/core";
import {
	liveChannelAccountId,
	mergeRtmpRetirementEvidence,
	pendingSecondaryStopTargets,
	type RtmpRetirementReceipt,
	unconfirmedRtmpEncoders,
} from "@bitovp/db";
import type { SdkOps } from "../orchestrator/sdk-ops";

export type RtmpRunSnapshot = {
	bitmovinEncodingId?: string | null;
	stepLog?: unknown;
	previousProviderEncodingIds?: readonly string[];
	archivedRtmpAttempt?: number;
	rtmpRetirementEvidence?: unknown;
};
export type RtmpChannelSnapshot = {
	bitmovinEncodingId?: string | null;
	error?: string | null;
	stepLog?: unknown;
	bitmovinAccountId?: string | null;
	plan?: unknown;
};
export type DisplacedReadbacks = {
	accountId: string | null;
	receipts: RtmpRetirementReceipt[];
};

type AiringTargets = {
	primary: string;
	history: Parameters<typeof pendingSecondaryStopTargets>[2];
};

function pendingTargets(
	run: RtmpRunSnapshot,
	channel: RtmpChannelSnapshot,
	account: string | null,
	airing?: AiringTargets,
) {
	// Unselected optional columns in lifecycle callers are not evidence of
	// another encoder. The terminal projection reloads both full logs under lock.
	if (airing)
		return pendingSecondaryStopTargets(
			{
				...run,
				stepLog: run.stepLog === undefined ? [] : run.stepLog,
				bitmovinEncodingId: run.bitmovinEncodingId ?? null,
			},
			{
				...channel,
				stepLog: channel.stepLog === undefined ? [] : channel.stepLog,
				bitmovinEncodingId: channel.bitmovinEncodingId ?? null,
			},
			airing.history,
			account,
			airing.primary,
		);
	return unconfirmedRtmpEncoders(
		{ ...run, stepLog: run.stepLog },
		{ stepLog: channel.stepLog },
		account,
	);
}

/** Heartbeats and cancellation recovery observe prior targets. Only their STOP owner can send. */
export async function readDisplacedEncoders(
	run: RtmpRunSnapshot,
	channel: RtmpChannelSnapshot,
	accountId: string | null,
	sdk: Pick<SdkOps, "getEncodingStatus">,
	now: () => string,
	signal?: AbortSignal,
	airing?: AiringTargets,
): Promise<DisplacedReadbacks | null> {
	const pending = pendingTargets(run, channel, accountId, airing);
	if (
		!pending ||
		(pending.length &&
			(!accountId || liveChannelAccountId(channel) !== accountId))
	)
		return null;
	const receipts: RtmpRetirementReceipt[] = [];
	for (const id of pending) {
		if (!accountId) return null;
		signal?.throwIfAborted();
		try {
			const { status } = await sdk.getEncodingStatus(id);
			signal?.throwIfAborted();
			if (classifyProviderStatusWord(status) !== "TERMINAL") return null;
			receipts.push({
				accountId,
				encodingId: id,
				providerStatus: status,
				observedAt: now(),
				disposition: "TERMINAL",
			});
		} catch {
			signal?.throwIfAborted();
			return null;
		}
	}
	return { accountId, receipts };
}

/** Called with the exact run and its channel locked, immediately before terminal projection. */
export function displacedRetirementWrite(
	run: RtmpRunSnapshot,
	channel: RtmpChannelSnapshot,
	proof: DisplacedReadbacks,
	airing?: AiringTargets,
) {
	const accountId = liveChannelAccountId(channel);
	if (
		(run.previousProviderEncodingIds?.length || proof.receipts.length) &&
		(!accountId || accountId !== proof.accountId)
	)
		return null;
	const merged = mergeRtmpRetirementEvidence(
		run.rtmpRetirementEvidence,
		proof.receipts,
	);
	const pending = pendingTargets(
		{ ...run, rtmpRetirementEvidence: merged },
		channel,
		accountId,
		airing,
	);
	if (!pending || pending.length) return null;
	return proof.receipts.length ? { rtmpRetirementEvidence: merged } : {};
}
