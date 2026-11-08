import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLiveAccessAllowed } from "@/lib/server/aisa-live-access";
import { getServerContext } from "@/lib/server/context";

export const generateMetadata = localizedTitle("aisaLive.title");

export default async function AisaAnalysisPage({
	params,
	searchParams,
}: {
	params: Promise<{ analysisId: string }>;
	searchParams: Promise<{ bitmovinAccountId?: string | string[] }>;
}) {
	const ctx = await getServerContext();
	if (!aisaLiveAccessAllowed(ctx.tenant)) notFound();
	const { analysisId } = await params;
	const { bitmovinAccountId } = await searchParams;
	if (
		!z.uuid().safeParse(analysisId).success ||
		typeof bitmovinAccountId !== "string" ||
		!z.uuid().safeParse(bitmovinAccountId).success
	)
		notFound();
	const run = await ctx.prisma.liveChannelRun.findFirst({
		where: { aisaAnalysisId: analysisId, liveChannel: { bitmovinAccountId } },
		select: { id: true, liveChannelId: true },
	});
	if (!run) notFound();
	redirect(`/live/${run.liveChannelId}?runId=${run.id}`);
}
