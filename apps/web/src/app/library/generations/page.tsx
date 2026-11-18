import { localizedTitle } from "@/lib/i18n/metadata";
import { readGenerationHistoryFilters } from "@/lib/library-generation-history";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { GenerationHistory } from "./generation-history";

export const generateMetadata = localizedTitle("library.title");

export default async function GenerationHistoryPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	return (
		<GenerationHistory
			initialFilters={readGenerationHistoryFilters(await searchParams)}
			clipEditingAvailable={await isClipEditingAvailable()}
		/>
	);
}
