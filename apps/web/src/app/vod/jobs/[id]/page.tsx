import { localizedTitle } from "@/lib/i18n/metadata";
import { readPlayerClientConfig } from "@/lib/server/player-config";
import { JobDetail } from "./job-detail";

export const generateMetadata = localizedTitle("pageTitles.vodJob");

export default async function VodJobDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	//  : the player config rides SERVER props so it is
	// present from the first render — no open-source-then-Bitmovin flip.
	const player = await readPlayerClientConfig();
	return <JobDetail id={id} player={player} />;
}
