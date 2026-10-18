import { localizedTitle } from "@/lib/i18n/metadata";
import { FeederDetail } from "./feeder-detail";

export const generateMetadata = localizedTitle("pageTitles.feederSession");

export default async function FeederSessionDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <FeederDetail id={id} />;
}
