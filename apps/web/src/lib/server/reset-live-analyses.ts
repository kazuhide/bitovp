import {
	aisaCreateNotDispatched,
	aisaLiveFinalization,
	aisaLiveNeverStarted,
	isAisaManagedLivePlan,
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

/** Called under the channel locks before removing the only Analysis or finalization handle. */
export async function assertResetLiveAnalyses(tx: AppTransactionClient) {
	// Provider readback may update a run while its channel projection stays unchanged.
	await tx.$queryRaw`SELECT id FROM "LiveChannelRun" ORDER BY "liveChannelId", seq DESC FOR UPDATE`;
	const channels = await tx.liveChannel.findMany({
		where: {
			origin: { not: "AISA_IMPORTED" },
			OR: [
				{ plan: { path: ["start", "aiSceneAnalysisLive"], not: DB_NULL } },
				{
					runs: {
						some: {
							OR: [
								{ aisaAnalysisId: { not: null } },
								{ aisaStatus: { not: null } },
								{ aisaSnapshot: { not: DB_NULL } },
							],
						},
					},
				},
			],
		},
		select: {
			id: true,
			status: true,
			origin: true,
			plan: true,
			bitmovinEncodingId: true,
			encoderStoppedConfirmedFor: true,
			stepLog: true,
			runs: analysisBindingSelect,
		},
	});
	for (const channel of channels) {
		const runs = channel.runs;

		if (
			!runs.length &&
			isAisaManagedLivePlan(channel.plan) &&
			!aisaRunCanBeRemoved(channel, null)
		)
			throw new AisaFinalizationNotConfirmed();
		for (const [index, run] of runs.entries()) {
			if (!isAisaLiveChannelView(channel, run)) continue;
			if (!aisaRunCanBeRemoved(index === 0 ? channel : run, run))
				throw new AisaFinalizationNotConfirmed();
		}
	}
}
