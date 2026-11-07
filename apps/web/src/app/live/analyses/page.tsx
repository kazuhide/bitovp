import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";
import { AisaLiveList } from "../aisa-live-list";

export const generateMetadata = localizedTitle("aisaLive.title");

export default function AisaAnalysesPage() {
	if (!aisaLivePreviewEnabled()) notFound();
	return <AisaLiveList />;
}
