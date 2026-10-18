import { localizedTitle } from "@/lib/i18n/metadata";
import { LiveWizard } from "./live-wizard";

export const generateMetadata = localizedTitle("pageTitles.newLiveChannel");

/** ?from=<channelId> duplicates an existing channel's plan into the form. */
export default async function NewLiveChannelPage({
	searchParams,
}: {
	searchParams: Promise<{ from?: string | string[] }>;
}) {
	const { from } = await searchParams;
	return (
		<LiveWizard
			key={JSON.stringify(from)}
			duplicateFrom={Array.isArray(from) ? "" : from}
		/>
	);
}
