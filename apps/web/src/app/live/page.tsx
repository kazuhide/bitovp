import { localizedTitle } from "@/lib/i18n/metadata";
import { aisaLivePreviewEnabled } from "@/lib/server/aisa-live-sdk";
import { AisaPreviewLinks } from "./aisa-live-shared";
import { ChannelsClient } from "./channels-client";

export const generateMetadata = localizedTitle("pageTitles.liveChannels");

export default function LiveChannelsPage() {
	return (
		<div className="space-y-6">
			{aisaLivePreviewEnabled() ? <AisaPreviewLinks /> : null}
			<ChannelsClient />
		</div>
	);
}
