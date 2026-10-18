import { localizedTitle } from "@/lib/i18n/metadata";
import { VmafProfilesClient } from "./profiles-client";
export const generateMetadata = localizedTitle("vmafSettings.title");
export default function VmafSettingsPage() {
	return <VmafProfilesClient />;
}
