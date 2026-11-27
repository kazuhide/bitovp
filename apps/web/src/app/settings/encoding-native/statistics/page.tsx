import { localizedTitle } from "@/lib/i18n/metadata";
import { EncodingStatisticsClient } from "./statistics-client";

export const generateMetadata = localizedTitle("encodingStatistics.title");

export default function EncodingStatisticsPage() {
	return <EncodingStatisticsClient />;
}
