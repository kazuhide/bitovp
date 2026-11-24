import {
	classifyProviderStatusWord,
	isAisaManagedLivePlan,
} from "@bitovp/core";
import {
	liveChannelAccountId,
	liveStopRunOwnsEncoding,
	matchesRecordedStopFailure,
	type ResolveLiveEffectsAfterConfirmedStopInput,
	resolveLiveEffectsAfterConfirmedStop,
} from "@bitovp/db";
import { HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS } from "../heartbeat-cadence";
import type { LiveChannelDeps } from "../orchestrator/live-processor";

type Dependencies = Pick<
	LiveChannelDeps,
	"prisma" | "now" | "revealBitmovinAccount" | "makeSdk" | "emitEvent"
>;

/** Revisit durable STOP claims after a worker has exhausted its inline readbacks. */
export function createUncertainStopReconciler(deps: Dependencies) {
	const pageSize = 4;
	let after: string | undefined;
	let scanning = false;
	return async function reconcile(): Promise<number> {
		if (scanning) return 0;
		scanning = true;
		try {
			const claims = await deps.prisma.liveEffectClaim.findMany({
				where: {
					action: "STOP",
					...(after && { id: { gt: after } }),
					OR: [
						{
							state: "AMBIGUOUS",
							liveChannel: { status: { in: ["ERROR", "STOPPED", "STOPPING"] } },
						},
						{
							state: "DISPATCHING",
							expiresAt: { lte: new Date(deps.now()) },
							liveChannel: {
								OR: [
									{ status: "STOPPED", error: null },
									{ status: "STOPPING" },
								],
							},
						},
					],
				},
				orderBy: { id: "asc" },
				take: pageSize,
				select: {
					id: true,
					idempotencyKey: true,
					liveChannelId: true,
					liveChannelRunId: true,
					providerEncodingId: true,
					generation: true,
					state: true,
					failure: true,
					liveChannel: {
						select: {
							origin: true,
							name: true,
							status: true,
							error: true,
							bitmovinAccountId: true,
							bitmovinEncodingId: true,
							liveEffectFenceVersion: true,
							plan: true,
							runs: {
								orderBy: { seq: "desc" },
								take: 1,
								select: {
									id: true,
									stepLog: true,
									bitmovinEncodingId: true,
									aisaAnalysisId: true,
								},
							},
						},
					},
				},
			});
			after = claims.length === pageSize ? claims.at(-1)?.id : undefined;
			let resolved = 0;
			for (const claim of claims) {
				const channel = claim.liveChannel;
				const run = channel.runs[0];
				if (
					channel.liveEffectFenceVersion !== claim.generation ||
					channel.bitmovinEncodingId !== claim.providerEncodingId ||
					run?.id !== claim.liveChannelRunId ||
					!liveStopRunOwnsEncoding(run, claim.providerEncodingId) ||
					channel.origin !== "MANAGED" ||
					run.aisaAnalysisId ||
					isAisaManagedLivePlan(channel.plan)
				)
					continue;
				const identity = {
					liveChannelId: claim.liveChannelId,
					liveChannelRunId: claim.liveChannelRunId,
					providerEncodingId: claim.providerEncodingId,
					stopClaimId: claim.id,
					stopIdempotencyKey: claim.idempotencyKey,
				};
				try {
					let terminalReadback: ResolveLiveEffectsAfterConfirmedStopInput["terminalReadback"];
					if (channel.status !== "STOPPED" || channel.error !== null) {
						const bitmovinAccountId = liveChannelAccountId(channel);
						if (
							!bitmovinAccountId ||
							(channel.status !== "STOPPING" &&
								(claim.state !== "AMBIGUOUS" ||
									!matchesRecordedStopFailure(
										channel.status,
										channel.error,
										claim.failure,
										claim.providerEncodingId,
									)))
						)
							continue;
						const credentials =
							await deps.revealBitmovinAccount(bitmovinAccountId);
						const sdk = deps.makeSdk({
							...credentials,
							bitmovinAccountId,
							monitoringSignal: AbortSignal.timeout(
								HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
							),
						});
						const { status } = await sdk.getEncodingStatus(
							claim.providerEncodingId,
						);
						if (classifyProviderStatusWord(status) !== "TERMINAL") continue;
						terminalReadback = {
							generation: claim.generation,
							bitmovinAccountId,
							providerStatus: status,
						};
					}
					const outcome = await resolveLiveEffectsAfterConfirmedStop(
						deps.prisma,
						{
							...identity,
							at: new Date(deps.now()),
							...(terminalReadback
								? { terminalReadback }
								: { interruptedAckGeneration: claim.generation }),
						},
					);
					if (outcome.kind === "RESOLVED") resolved++;
				} catch {
					// One unavailable account, readback or transaction must not starve the next claim.
					console.warn(
						`[live] STOP reconciliation deferred for claim ${claim.id}`,
					);
				}
			}
			return resolved;
		} finally {
			scanning = false;
		}
	};
}
