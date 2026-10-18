import { localizedTitle } from "@/lib/i18n/metadata";
import { FeedersClient } from "./feeders-client";

export const generateMetadata = localizedTitle("pageTitles.pseudoLiveFeeds");

export default function FeedersPage() {
	return <FeedersClient />;
}
