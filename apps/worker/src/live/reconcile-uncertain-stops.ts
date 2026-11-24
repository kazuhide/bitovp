import {
	aisaLiveFinalization,
	classifyProviderStatusWord,
	isAisaManagedLivePlan,
	type LiveChannelJob,
} from "@bitovp/core";
import {
	canObserveLiveStop,
	liveChannelAccountId,
	liveStopKnownTargets,
	liveStopRunOwnsEncoding,
	type ResolveLiveEffectsAfterConfirmedStopInput,
	resolveLiveEffectsAfterConfirmedStop,
	savedStopReadbacks,
	unreservedStopTargets,
} from "@bitovp/db";
import { HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS } from "../heartbeat-cadence";
import type { LiveChannelDeps } from "../orchestrator/live-processor";

type Dependencies = Pick<
	LiveChannelDeps,
	"prisma" | "now" | "revealBitmovinAccount" | "makeSdk" | "emitEvent"
>;

/** Revisit durable STOP claims after a worker has exhausted its inline readbacks. */
export function createUncertainStopReconciler(
	deps: Dependencies,
	resumeUnsent?: (
		job: LiveChannelJob,
		activeTargets: ReadonlySet<string>,
	) => Promise<unknown>,
) {
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
							liveChannel: { status: { in: ["ERROR", "STOPPING", "STOPPED"] } },
						},
					],
				},
				orderBy: { id: "asc" },
				take: pageSize,
				select: {
					id: true,
					idempotencyKey: true,
					scheduleId: true,
					liveChannelId: true,
					liveChannelRunId: true,
					providerEncodingId: true,
					generation: true,
					state: true,
					failure: true,
					expiresAt: true,
					stopProtocolVersion: true,
					stopOutcomeEvidence: true,
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
							stepLog: true,
							runs: {
								orderBy: { seq: "desc" },
								take: 1,
								select: {
									id: true,
									stepLog: true,
									previousProviderEncodingIds: true,
									archivedRtmpAttempt: true,
									rtmpRetirementEvidence: true,
									status: true,
									error: true,
									providerStatus: true,
									providerTerminalAt: true,
									providerStatusObservedAt: true,
									bitmovinEncodingId: true,
									aisaAnalysisId: true,
									aisaStatus: true,
									aisaSnapshot: true,
									aisaFinalization: true,
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
					((run.aisaAnalysisId || isAisaManagedLivePlan(channel.plan)) &&
						aisaLiveFinalization(run) !== "COMPLETE")
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
					const at = new Date(deps.now());
					if (!canObserveLiveStop(claim, channel, at)) continue;
					const history = await deps.prisma.liveEffectClaim.findMany({
						where: {
							liveChannelRunId: run.id,
							liveChannelId: claim.liveChannelId,
						},
						select: {
							action: true,
							state: true,
							providerEncodingId: true,
							failure: true,
							stopProtocolVersion: true,
							stopSendEncodingIds: true,
							stopOutcomeEvidence: true,
						},
					});
					const completeTargets = liveStopKnownTargets(
						run,
						channel,
						history,
						liveChannelAccountId(channel),
					);
					const targets = completeTargets ?? [claim.providerEncodingId];
					const clean =
						completeTargets !== null &&
						channel.status === "STOPPED" &&
						channel.error === null &&
						run.status === "STOPPED" &&
						run.error === null &&
						run.providerTerminalAt &&
						run.providerStatusObservedAt &&
						classifyProviderStatusWord(run.providerStatus) === "TERMINAL" &&
						targets.length === 1;
					if (!clean) {
						const bitmovinAccountId = liveChannelAccountId(channel);
						if (!bitmovinAccountId) continue;
						const credentials =
							await deps.revealBitmovinAccount(bitmovinAccountId);
						const sdk = deps.makeSdk({
							...credentials,
							bitmovinAccountId,
							monitoringSignal: AbortSignal.timeout(
								HEARTBEAT_SWEEP_PER_CHANNEL_TIMEOUT_MS,
							),
						});
						const prior = new Map(
							savedStopReadbacks(claim, bitmovinAccountId).map((r) => [
								r.id,
								r.status,
							]),
						);
						const encodings: { id: string; status: string }[] = [];
						const unsent =
							resumeUnsent &&
							claim.stopProtocolVersion === 1 &&
							claim.expiresAt <= at
								? unreservedStopTargets(run, channel, history)
								: [];
						const activeTargets = new Set<string>();
						for (const id of targets) {
							const status =
								(id !== claim.providerEncodingId && prior.get(id)) ||
								(await sdk.getEncodingStatus(id).catch(() => null))?.status;
							if (!status) continue;
							if (classifyProviderStatusWord(status) === "TERMINAL")
								encodings.push({ id, status });
							else if (
								unsent.includes(id) &&
								["RUNNING", "QUEUED", "CREATED"].includes(status)
							)
								activeTargets.add(id);
						}
						if (activeTargets.size && resumeUnsent) {
							// Re-enter the original exact intent. beginLiveEffect fences owner
							// takeover; the per-ID journal suppresses every prior reservation.
							await resumeUnsent(
								{
									liveChannelId: claim.liveChannelId,
									action: "stop",
									...(claim.scheduleId
										? { plannedLiveChannelRunId: run.id }
										: {}),
									effect: {
										action: "STOP",
										idempotencyKey: claim.idempotencyKey,
										admissionFenceVersion: claim.generation,
										liveChannelRunId: run.id,
										providerEncodingId: claim.providerEncodingId,
										...(claim.scheduleId
											? { scheduleId: claim.scheduleId }
											: {}),
									},
								},
								activeTargets,
							);
							continue;
						}
						const primary = encodings.find(
							(r) => r.id === claim.providerEncodingId,
						);
						if (!primary || encodings.length !== targets.length) continue;
						terminalReadback = {
							generation: claim.generation,
							bitmovinAccountId,
							providerStatus: primary.status,
							encodings,
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
