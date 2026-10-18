import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { FeaturesClient } from "./features-client";

export const generateMetadata = localizedTitle("pageTitles.features");

export default function FeaturesSettingsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<FeaturesClient />
		</>
	);
}
