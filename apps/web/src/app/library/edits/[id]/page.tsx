import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { EditorClient } from "./editor-client";
import { EditorRouter } from "./editor-router";

export const generateMetadata = localizedTitle("editing.title");
export default async function EditingPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!(await isClipEditingAvailable()))
		return <EditorClient id={id} historyOnly />;
	return <EditorRouter id={id} />;
}
