import { localizedTitle } from "@/lib/i18n/metadata";
import { ErrorDefinitionsClient } from "./error-definitions-client";

export const generateMetadata = localizedTitle("pageTitles.errorDefinitions");

export default async function ErrorDefinitionsPage({
	searchParams,
}: {
	searchParams: Promise<{ bitmovinAccountId?: string | string[] }>;
}) {
	const { bitmovinAccountId } = await searchParams;
	return (
		<ErrorDefinitionsClient
			key={
				Array.isArray(bitmovinAccountId)
					? "invalid-account"
					: (bitmovinAccountId ?? "")
			}
			initialAccountId={
				Array.isArray(bitmovinAccountId) ? "" : bitmovinAccountId
			}
		/>
	);
}
