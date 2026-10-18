import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { BrandingClient } from "./branding-client";
export const generateMetadata = localizedTitle("branding.title");
export default function BrandingPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<BrandingClient />
		</>
	);
}
