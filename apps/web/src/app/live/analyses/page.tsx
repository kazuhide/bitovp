import { notFound, redirect } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";

export const generateMetadata = localizedTitle("aisaLive.title");

export default function AisaAnalysesPage() {
	if (!aisaLivePreviewEnabled()) notFound();
	redirect("/live");
}
