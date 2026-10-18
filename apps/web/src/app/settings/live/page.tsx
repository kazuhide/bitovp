import { localizedTitle } from "@/lib/i18n/metadata";
import { LiveSettingsClient } from "./live-settings-client";

export const generateMetadata = localizedTitle("pageTitles.live");

export default function LiveSettingsPage() {
	return <LiveSettingsClient />;
}
