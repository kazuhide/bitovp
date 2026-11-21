import { localizedTitle } from "@/lib/i18n/metadata";
import { OperationAnalytics } from "./operation-analytics";

export const generateMetadata = localizedTitle("operationAnalytics.title");

export default function OperationAnalyticsPage() {
	return <OperationAnalytics />;
}
