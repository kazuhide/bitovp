import { localizedTitle } from "@/lib/i18n/metadata";
import { JobsClient } from "./jobs-client";

export const generateMetadata = localizedTitle("pageTitles.vodJobs");

export default function VodJobsPage() {
	return <JobsClient />;
}
