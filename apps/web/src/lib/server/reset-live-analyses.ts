import {
	AISA_LIVE_STEP_KINDS,
	aisaCreateNotDispatched,
	aisaLiveFinalization,
	aisaLiveNeverStarted,
} from "@bitovp/core";
import {
	type AppTransactionClient,
	DB_NULL,
	type LiveChannel,
	type LiveChannelRun,
	type Prisma,
} from "@bitovp/db";
import { isAisaLiveChannelView } from "./live-channel-aisa-view";

export const AISA_FINALIZATION_REQUIRED_MESSAGE =
	"Analysis finalization must be confirmed before deleting this channel";
export class AisaFinalizationNotConfirmed extends Error {
	constructor() {
		super(AISA_FINALIZATION_REQUIRED_MESSAGE);
	}
}
type Channel = Pick<
	LiveChannel,
	"status" | "bitmovinEncodingId" | "encoderStoppedConfirmedFor" | "stepLog"
>;
export function aisaRunCanBeRemoved(
	channel: Channel,
	run: Pick<LiveChannelRun, keyof typeof analysisRunFields> | null,
) {
	if (!run)
		return (
			["CREATED", "ERROR"].includes(channel.status) &&
			!channel.bitmovinEncodingId &&
			aisaCreateNotDispatched(channel.stepLog)
		);
	if (
		run.status === "ERROR" &&
		channel.status === "ERROR" &&
		!run.cancelRequested &&
		!run.aisaAnalysisId &&
		!run.bitmovinEncodingId &&
		!channel.bitmovinEncodingId &&
		aisaCreateNotDispatched(run.stepLog) &&
		aisaCreateNotDispatched(channel.stepLog)
	)
		return true;
	return (
		(run.bitmovinEncodingId === channel.bitmovinEncodingId &&
			["COMPLETE", "FAILED"].includes(aisaLiveFinalization(run))) ||
		aisaLiveNeverStarted(run, channel)
	);
}

const analysisRunFields = {
	id: true,
	status: true,
	error: true,
	cancelRequested: true,
	bitmovinEncodingId: true,
	encoderStoppedConfirmedFor: true,
	stepLog: true,
	aisaAnalysisId: true,
	aisaStatus: true,
	aisaFinalization: true,
	aisaSnapshot: true,
	providerStatus: true,
} satisfies Prisma.LiveChannelRunSelect;
export const analysisBindingSelect = {
	orderBy: { seq: "desc" },
	select: analysisRunFields,
} satisfies Prisma.LiveChannel$runsArgs;

export const stopAnalysisBindingSelect = {
	where: { action: "STOP", stopAnalysisSendId: { not: null } },
	select: { liveChannelRunId: true, stopAnalysisSendId: true },
} satisfies Prisma.LiveChannel$effectClaimsArgs;

/** A provider STOP journal can outlive its run or either cached Analysis projection. */
export function hasUnfinalizedStopAnalysis(
	channel: Channel,
	runs: readonly Pick<LiveChannelRun, keyof typeof analysisRunFields>[],
	claims: readonly {
		liveChannelRunId: string;
		stopAnalysisSendId: string | null;
	}[],
) {
	return claims.some((claim) => {
		const run = runs.find((r) => r.id === claim.liveChannelRunId);
		return (
			!run ||
			run.aisaAnalysisId !== claim.stopAnalysisSendId ||
			!aisaRunCanBeRemoved(run.id === runs[0]?.id ? channel : run, run)
		);
	});
}

/** Called under the channel locks before removing the only Analysis or finalization handle. */
export async function assertResetLiveAnalyses(tx: AppTransactionClient) {
	// Provider readback may update a run while its channel projection stays unchanged.
	await tx.$queryRaw`SELECT id FROM "LiveChannelRun" ORDER BY "liveChannelId", seq DESC FOR UPDATE`;
	if ((await resetLiveAnalysisBlockers(tx)).length)
		throw new AisaFinalizationNotConfirmed();
}

export async function resetLiveAnalysisBlockers(
	tx: Pick<AppTransactionClient, "liveChannel">,
) {
	const logBindings = AISA_LIVE_STEP_KINDS.map((kind) => ({
		stepLog: { array_contains: [{ kind }] },
	}));
	const channels = await tx.liveChannel.findMany({
		where: {
			OR: [
				{ effectClaims: { some: stopAnalysisBindingSelect.where } },
				{
					origin: { not: "AISA_IMPORTED" },
					OR: [
						...logBindings,
						{ plan: { path: ["start", "aiSceneAnalysisLive"], not: DB_NULL } },
						{
							runs: {
								some: {
									OR: [
										...logBindings,
										{ aisaAnalysisId: { not: null } },
										{ aisaStatus: { not: null } },
										{ aisaSnapshot: { not: DB_NULL } },
									],
								},
							},
						},
					],
				},
			],
		},
		select: {
			id: true,
			name: true,
			status: true,
			origin: true,
			plan: true,
			bitmovinEncodingId: true,
			encoderStoppedConfirmedFor: true,
			stepLog: true,
			runs: analysisBindingSelect,
			effectClaims: stopAnalysisBindingSelect,
		},
	});
	return channels
		.filter((channel) => {
			if (
				hasUnfinalizedStopAnalysis(channel, channel.runs, channel.effectClaims)
			)
				return true;
			if (channel.origin === "AISA_IMPORTED") return false;
			if (!channel.runs.length)
				return (
					isAisaLiveChannelView(channel, null) &&
					!aisaRunCanBeRemoved(channel, null)
				);
			return channel.runs.some((run, index) => {
				const projection = index === 0 ? channel : { ...channel, stepLog: [] };
				return (
					isAisaLiveChannelView(projection, run) &&
					!aisaRunCanBeRemoved(index === 0 ? channel : run, run)
				);
			});
		})
		.map(({ id, name, status }) => ({ id, name, status }));
}
