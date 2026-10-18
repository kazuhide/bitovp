import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { PlayerSettingsClient } from "./player-client";

export const generateMetadata = localizedTitle("pageTitles.playerSettings");

export default function PlayerSettingsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<PlayerSettingsClient />
		</>
	);
}
