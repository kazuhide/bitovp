import { localizedTitle } from "@/lib/i18n/metadata";
import { ChannelsClient } from "./channels-client";

export const generateMetadata = localizedTitle("pageTitles.liveChannels");

export default function LiveChannelsPage() {
	return <ChannelsClient />;
}
