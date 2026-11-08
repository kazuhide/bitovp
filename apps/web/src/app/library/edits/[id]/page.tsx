import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { EditorRouter } from "./editor-router";

export const generateMetadata = localizedTitle("editing.title");
export default async function EditingPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	if (!isClipEditingAvailable()) notFound();
	const { id } = await params;
	return <EditorRouter id={id} />;
}
