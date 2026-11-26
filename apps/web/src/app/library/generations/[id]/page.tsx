import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { GenerationProgress } from "./generation-progress";
export const generateMetadata = localizedTitle("editing.projects");
export default async function GenerationPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams?: Promise<{ view?: string | string[] }>;
}) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	return (
		<GenerationProgress
			id={id}
			clipEditingAvailable={await isClipEditingAvailable()}
			showJobDetails={query?.view === "details"}
		/>
	);
}
