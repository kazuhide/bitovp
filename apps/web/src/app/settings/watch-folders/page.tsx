import { localizedTitle } from "@/lib/i18n/metadata";
import { WatchFoldersClient } from "./watch-folders-client";

export const generateMetadata = localizedTitle("pageTitles.watchFolders");

export default function WatchFoldersPage() {
	return <WatchFoldersClient />;
}
