import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { GenerationProgress } from "./generation-progress";
export const generateMetadata = localizedTitle("editing.projects");
export default async function GenerationPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	if (!isClipEditingAvailable()) notFound();
	const { id } = await params;
	return <GenerationProgress id={id} />;
}
