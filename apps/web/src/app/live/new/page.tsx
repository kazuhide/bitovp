import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLiveAccessAllowed } from "@/lib/server/aisa-live-access";
import { getServerContext } from "@/lib/server/context";
import { LiveWizard } from "./live-wizard";

export const generateMetadata = localizedTitle("pageTitles.newLiveChannel");

/** ?from=<channelId> duplicates an existing channel's plan into the form. */
export default async function NewLiveChannelPage({
	searchParams,
}: {
	searchParams: Promise<{ from?: string | string[]; mode?: string | string[] }>;
}) {
	const { from, mode } = await searchParams;
	const ctx = await getServerContext();
	const preview = aisaLiveAccessAllowed(ctx.tenant);
	if (mode === "aisa-preview") {
		if (!preview) notFound();
	}
	return (
		<LiveWizard
			key={JSON.stringify(from)}
			duplicateFrom={Array.isArray(from) ? "" : from}
			aisaPreviewEnabled={preview}
			aisaFeatureUserId={
				preview ? (ctx.tenant?.effectiveUserId ?? undefined) : undefined
			}
			initialAisaEnabled={preview && mode === "aisa-preview"}
		/>
	);
}
