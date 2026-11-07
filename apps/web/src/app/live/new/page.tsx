import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";
import { AisaLiveCreate } from "../aisa-live-create";
import { AisaPreviewLinks } from "../aisa-live-shared";
import { LiveWizard } from "./live-wizard";

export const generateMetadata = localizedTitle("pageTitles.newLiveChannel");

/** ?from=<channelId> duplicates an existing channel's plan into the form. */
export default async function NewLiveChannelPage({
	searchParams,
}: {
	searchParams: Promise<{ from?: string | string[]; mode?: string | string[] }>;
}) {
	const { from, mode } = await searchParams;
	const preview = aisaLivePreviewEnabled();
	if (mode === "aisa-preview") {
		if (!preview) notFound();
		return <AisaLiveCreate />;
	}
	const wizard = (
		<LiveWizard
			key={JSON.stringify(from)}
			duplicateFrom={Array.isArray(from) ? "" : from}
		/>
	);
	if (!preview) return wizard;
	return (
		<div className="space-y-6">
			<AisaPreviewLinks />
			{wizard}
		</div>
	);
}
