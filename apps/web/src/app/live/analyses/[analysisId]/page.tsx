import { notFound } from "next/navigation";
import { z } from "zod";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";
import { AisaLiveDetail } from "../../aisa-live-detail";

export const generateMetadata = localizedTitle("aisaLive.title");

export default async function AisaAnalysisPage({
	params,
	searchParams,
}: {
	params: Promise<{ analysisId: string }>;
	searchParams: Promise<{ bitmovinAccountId?: string | string[] }>;
}) {
	if (!aisaLivePreviewEnabled()) notFound();
	const { analysisId } = await params;
	const { bitmovinAccountId } = await searchParams;
	if (
		!z.uuid().safeParse(analysisId).success ||
		typeof bitmovinAccountId !== "string" ||
		!z.uuid().safeParse(bitmovinAccountId).success
	)
		notFound();
	return (
		<AisaLiveDetail accountId={bitmovinAccountId} analysisId={analysisId} />
	);
}
