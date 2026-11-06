import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { VmafProfilesClient } from "../vmaf/profiles-client";
import { FeaturesClient } from "./features-client";

export const generateMetadata = localizedTitle("settingsCatalog.quality");

export default function FeaturesSettingsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<div className="space-y-8">
				<FeaturesClient />
				<VmafProfilesClient embedded />
			</div>
		</>
	);
}
