import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { BitmovinClient } from "./bitmovin-client";

export const generateMetadata = localizedTitle("pageTitles.bitmovinAccounts");

export default function BitmovinAccountsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<BitmovinClient />
		</>
	);
}
