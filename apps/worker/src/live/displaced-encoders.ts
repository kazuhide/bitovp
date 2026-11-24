import { classifyProviderStatusWord } from "@bitovp/core";
import {
	liveChannelAccountId,
	mergeRtmpRetirementEvidence,
	type RtmpRetirementReceipt,
	unconfirmedRtmpEncoders,
} from "@bitovp/db";
import type { SdkOps } from "../orchestrator/sdk-ops";

export type RtmpRunSnapshot = {
	stepLog?: unknown;
	previousProviderEncodingIds?: readonly string[];
	archivedRtmpAttempt?: number;
	rtmpRetirementEvidence?: unknown;
};
export type RtmpChannelSnapshot = {
	stepLog?: unknown;
	bitmovinAccountId?: string | null;
	plan?: unknown;
};
export type DisplacedReadbacks = {
	accountId: string | null;
	receipts: RtmpRetirementReceipt[];
};

/** Heartbeats and cancellation recovery observe prior targets. Only their STOP owner can send. */
export async function readDisplacedEncoders(
	run: RtmpRunSnapshot,
	channel: RtmpChannelSnapshot,
	accountId: string | null,
	sdk: Pick<SdkOps, "getEncodingStatus">,
	now: () => string,
	signal?: AbortSignal,
): Promise<DisplacedReadbacks | null> {
	const pending = unconfirmedRtmpEncoders(
		{ ...run, stepLog: run.stepLog },
		{ stepLog: channel.stepLog },
		accountId,
	);
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
	const pending = unconfirmedRtmpEncoders(
		{ ...run, stepLog: run.stepLog, rtmpRetirementEvidence: merged },
		{ stepLog: channel.stepLog },
		accountId,
	);
	if (!pending || pending.length) return null;
	return proof.receipts.length ? { rtmpRetirementEvidence: merged } : {};
}
