import { localizedTitle } from "@/lib/i18n/metadata";
import { ApiCoverageClient } from "./coverage-client";

export const generateMetadata = localizedTitle("pageTitles.apiCoverage");

export default function ApiCoveragePage() {
	return <ApiCoverageClient />;
}
