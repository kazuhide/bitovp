import { notFound, redirect } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLiveAccessAllowed } from "@/lib/server/aisa-live-access";
import { getServerContext } from "@/lib/server/context";

export const generateMetadata = localizedTitle("aisaLive.title");

export default async function AisaAnalysesPage() {
	const ctx = await getServerContext();
	if (!aisaLiveAccessAllowed(ctx.tenant)) notFound();
	redirect("/live");
}
