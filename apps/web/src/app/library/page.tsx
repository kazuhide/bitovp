import { localizedTitle } from "@/lib/i18n/metadata";
import { LibraryClient } from "./library-client";
import { readLibraryBrowseState } from "./library-view-preference";

export const generateMetadata = localizedTitle("library.title");
export default async function LibraryPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	return (
		<LibraryClient initialQuery={readLibraryBrowseState(await searchParams)} />
	);
}
