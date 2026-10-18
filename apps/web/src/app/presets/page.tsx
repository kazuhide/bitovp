import { DELIVERY_SPECS } from "@bitovp/core";
import { SAMPLE_PRESET_FAMILIES, SAMPLE_PRESETS } from "@bitovp/core/presets";
import { localizedTitle } from "@/lib/i18n/metadata";
import { TemplatesClient } from "../templates/templates-client";
import { DeliveryGallery } from "./delivery-gallery";
import { MyPresets } from "./my-presets";
import { PresetGallery } from "./preset-gallery";
import { PresetHubNavigation } from "./preset-hub-navigation";

export const generateMetadata = localizedTitle("pageTitles.presets");

/**
 * Server component: only the sample preset METADATA crosses to the client — the
 * 56 embedded plan JSONs stay server-side (the wizard fetches the chosen one via
 * /api/sample-presets/[name]). The user's own saved presets load client-side
 * (MyPresets → /api/presets).
 */
export default async function PresetsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const requestedTab = (await searchParams).tab;
	const tab =
		requestedTab === "delivery" || requestedTab === "presets"
			? "delivery"
			: requestedTab === "samples"
				? "samples"
				: "saved";
	return (
		<div className="space-y-6">
			<PresetHubNavigation tab={tab} />
			{tab === "saved" ? (
				<TemplatesClient />
			) : tab === "delivery" ? (
				<div className="space-y-8">
					<MyPresets />
					{/* Delivery specs . Only metadata and the two small
					    specification plans cross the client boundary. */}
					<DeliveryGallery specs={[...DELIVERY_SPECS]} />
				</div>
			) : (
				<PresetGallery
					families={SAMPLE_PRESET_FAMILIES}
					presets={SAMPLE_PRESETS}
				/>
			)}
		</div>
	);
}
