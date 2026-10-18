import { localizedTitle } from "@/lib/i18n/metadata";
import { StorageClient } from "./storage-client";

export const generateMetadata = localizedTitle("pageTitles.storage");

export default function StoragePage() {
	return <StorageClient />;
}
