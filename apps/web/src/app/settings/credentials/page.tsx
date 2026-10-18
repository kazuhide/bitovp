import { localizedTitle } from "@/lib/i18n/metadata";
import { CredentialsClient } from "./credentials-client";

export const generateMetadata = localizedTitle("pageTitles.storageCredentials");

export default function CredentialsPage() {
	return <CredentialsClient />;
}
