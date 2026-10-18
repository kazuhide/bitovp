import { localizedTitle } from "@/lib/i18n/metadata";
import { SettingsBreadcrumb } from "../settings-breadcrumb";
import { NotificationsClient } from "./notifications-client";

export const generateMetadata = localizedTitle("pageTitles.notifications");

export default function NotificationsPage() {
	return (
		<>
			<SettingsBreadcrumb />
			<NotificationsClient />
		</>
	);
}
