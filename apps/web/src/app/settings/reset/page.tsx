import { localizedTitle } from "@/lib/i18n/metadata";
import { ResetClient } from "./reset-client";

export const generateMetadata = localizedTitle("pageTitles.reset");

export default function ResetSettingsPage() {
	return <ResetClient />;
}
