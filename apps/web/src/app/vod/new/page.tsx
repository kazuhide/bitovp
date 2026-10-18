import { localizedTitle } from "@/lib/i18n/metadata";
import { CopyVodJob } from "./copy-job";
import { VodWizard } from "./wizard";

export const generateMetadata = localizedTitle("pageTitles.newVodJob");

/**
 * `?preset=<name>` loads a SAMPLE preset; `?userPreset=<id>` loads a saved
 * user preset — both through the wizard's same import path.
 */
export default async function NewVodJobPage({
	searchParams,
}: {
	searchParams: Promise<{
		preset?: string | string[];
		userPreset?: string | string[];
		deliveryPreset?: string | string[];
		editPreset?: string | string[];
		from?: string | string[];
	}>;
}) {
	const { preset, userPreset, deliveryPreset, editPreset, from } =
		await searchParams;
	if (from !== undefined)
		return (
			<CopyVodJob
				key={JSON.stringify(from)}
				source={from}
				conflictingSource={[
					preset,
					userPreset,
					deliveryPreset,
					editPreset,
				].some((value) => value !== undefined)}
			/>
		);
	return (
		<VodWizard
			presetName={typeof preset === "string" ? preset : undefined}
			userPresetId={typeof userPreset === "string" ? userPreset : undefined}
			deliveryPresetId={
				typeof deliveryPreset === "string" ? deliveryPreset : undefined
			}
			editPresetId={typeof editPreset === "string" ? editPreset : undefined}
		/>
	);
}
