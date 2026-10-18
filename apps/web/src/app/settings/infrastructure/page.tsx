import { localizedTitle } from "@/lib/i18n/metadata";
import { InfrastructureClient } from "./infrastructure-client";

export const generateMetadata = localizedTitle("pageTitles.infrastructure");

export default function InfrastructurePage() {
	return <InfrastructureClient />;
}
