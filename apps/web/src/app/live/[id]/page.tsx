import { notFound } from "next/navigation";
import { z } from "zod";
import { aisaResultSchema } from "@/lib/aisa-live/contracts";
import { localizedTitle } from "@/lib/i18n/metadata";
import { getServerContext } from "@/lib/server/context";
import { readPlayerClientConfig } from "@/lib/server/player-config";
import type { AisaSelectedRun } from "./aisa-run-selection";
import { ChannelDetail } from "./channel-detail";

export const generateMetadata = localizedTitle("pageTitles.liveChannel");

export default async function LiveChannelDetailPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams?: Promise<{ runId?: string | string[] }>;
}) {
	const { id } = await params;
	const { runId } = (await searchParams) ?? {};
	let initialAisaRun: AisaSelectedRun | undefined;
	if (runId !== undefined) {
		if (
			!z.uuid().safeParse(id).success ||
			typeof runId !== "string" ||
			!z.uuid().safeParse(runId).success
		)
			notFound();
		const ctx = await getServerContext();
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { id: runId, liveChannelId: id },
			select: {
				id: true,
				liveChannelId: true,
				seq: true,
				aisaAnalysisId: true,
				bitmovinEncodingId: true,
				aisaStatus: true,
				aisaSnapshot: true,
			},
		});
		if (
			!run ||
			run.id.toLowerCase() !== runId.toLowerCase() ||
			run.liveChannelId.toLowerCase() !== id.toLowerCase() ||
			!run.aisaAnalysisId ||
			!run.bitmovinEncodingId
		)
			notFound();
		const parsedSnapshot = aisaResultSchema.safeParse(run.aisaSnapshot);
		initialAisaRun = {
			id: run.id,
			liveChannelId: run.liveChannelId,
			seq: run.seq,
			aisaAnalysisId: run.aisaAnalysisId,
			bitmovinEncodingId: run.bitmovinEncodingId,
			aisaStatus: run.aisaStatus,
			aisaSnapshot:
				parsedSnapshot.success &&
				parsedSnapshot.data.analysisId === run.aisaAnalysisId &&
				parsedSnapshot.data.encodingId === run.bitmovinEncodingId
					? parsedSnapshot.data
					: null,
		};
	}
	const player = await readPlayerClientConfig();
	return (
		<ChannelDetail id={id} player={player} initialAisaRun={initialAisaRun} />
	);
}
