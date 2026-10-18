import { localizedTitle } from "@/lib/i18n/metadata";
import { getWebBuildInfo } from "@/lib/server/build-info";
import { BuildInfoPanel } from "./build-info-panel";
import { SettingsAreas } from "./settings-areas";

export const generateMetadata = localizedTitle("pageTitles.settings");

// BITOVP_COMMIT belongs to the serving Web process,
// not the environment that prerendered the page during the image build.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
	const build = getWebBuildInfo();
	return (
		<>
			<SettingsAreas />
			<BuildInfoPanel version={build.version} commit={build.commit} />
		</>
	);
}
