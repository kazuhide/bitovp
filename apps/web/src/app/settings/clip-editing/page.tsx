import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { ClipEditingClient } from "./clip-editing-client";

export const generateMetadata = localizedTitle("clipDiagnostics.title");
export default function ClipEditingSettingsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<ClipEditingClient />
		</>
	);
}
