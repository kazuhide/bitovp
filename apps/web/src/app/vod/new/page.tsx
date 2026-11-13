import { cookies } from "next/headers";
import { localizedTitle } from "@/lib/i18n/metadata";
import { resolveVodFlow, VOD_FLOW_COOKIE } from "@/lib/vod-flow";
import { CopyVodJob } from "./copy-job";
import { VodWizard } from "./wizard";

export const generateMetadata = localizedTitle("pageTitles.newVodJob");

/**
 * `?preset=<name>` loads a SAMPLE preset; `?userPreset=<id>` loads a saved
 * user preset — both through the wizard's same import path.
 *
 * `?flow=streaming|file` chooses what a job started from nothing is for. Without
 * it, the flow last chosen in this browser applies. A preset, a delivery spec or a
 * copied job brings its own plan, so none of them takes a flow.
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
		flow?: string | string[];
	}>;
}) {
	const { preset, userPreset, deliveryPreset, editPreset, from, flow } =
		await searchParams;
	const loaded = [preset, userPreset, deliveryPreset, editPreset].some(
		(value) => value !== undefined,
	);
	if (from !== undefined)
		return (
			<CopyVodJob
				key={JSON.stringify(from)}
				source={from}
				conflictingSource={loaded}
			/>
		);
	const chosen = loaded
		? undefined
		: resolveVodFlow(
				typeof flow === "string" ? flow : undefined,
				(await cookies()).get(VOD_FLOW_COOKIE)?.value,
			);
	return (
		<VodWizard
			// The two flows start from different states, so changing flow starts over.
			// Everything else keeps the one instance, as before the flows existed.
			key={chosen === "file" ? "file" : "wizard"}
			flow={chosen}
			presetName={typeof preset === "string" ? preset : undefined}
			userPresetId={typeof userPreset === "string" ? userPreset : undefined}
			deliveryPresetId={
				typeof deliveryPreset === "string" ? deliveryPreset : undefined
			}
			editPresetId={typeof editPreset === "string" ? editPreset : undefined}
		/>
	);
}
