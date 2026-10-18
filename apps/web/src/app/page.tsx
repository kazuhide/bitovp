import { localizedTitle } from "@/lib/i18n/metadata";
import { DashboardHome } from "./dashboard-home";

export const generateMetadata = localizedTitle("pageTitles.dashboard");

/**
 * The heading and subtitle live in `DashboardHome` rather than here, because this
 * is a server component and `useT` is a client hook (the client component that
 * already has a translator owns the visible copy, like every other screen).
 */
export default function DashboardPage() {
	return <DashboardHome />;
}
