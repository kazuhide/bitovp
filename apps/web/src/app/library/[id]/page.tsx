import { localizedTitle } from "@/lib/i18n/metadata";
import { readLibrarySceneSelection } from "@/lib/library-scenes";
import { readPlayerClientConfig } from "@/lib/server/player-config";
import { ContentDetailClient } from "./content-detail";
export const generateMetadata = localizedTitle("library.title");
export default async function ContentDetailPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;
	return (
		<ContentDetailClient
			id={id}
			player={await readPlayerClientConfig()}
			initialScene={readLibrarySceneSelection(await searchParams)}
		/>
	);
}
