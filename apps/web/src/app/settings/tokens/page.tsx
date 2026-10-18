import { localizedTitle } from "@/lib/i18n/metadata";
import { TokensClient } from "./tokens-client";

export const generateMetadata = localizedTitle("pageTitles.apiTokens");

export default function TokensPage() {
	return <TokensClient />;
}
