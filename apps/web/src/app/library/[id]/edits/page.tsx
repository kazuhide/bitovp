import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { EditingLibraryClient } from "./editing-library";

export const generateMetadata = localizedTitle("editing.projects");
export default async function EditingLibraryPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return (
		<EditingLibraryClient
			contentId={id}
			clipEditingAvailable={await isClipEditingAvailable()}
		/>
	);
}
