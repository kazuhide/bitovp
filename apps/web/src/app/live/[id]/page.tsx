import { localizedTitle } from "@/lib/i18n/metadata";
import { readPlayerClientConfig } from "@/lib/server/player-config";
import { ChannelDetail } from "./channel-detail";

export const generateMetadata = localizedTitle("pageTitles.liveChannel");

export default async function LiveChannelDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const player = await readPlayerClientConfig();
	return <ChannelDetail id={id} player={player} />;
}
