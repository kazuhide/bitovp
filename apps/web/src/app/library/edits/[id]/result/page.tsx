import { notFound } from "next/navigation";
import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { PortraitResult } from "./portrait-result";

export const generateMetadata = localizedTitle(
	"editing.autoPortrait.resultTitle",
);
export default async function PortraitResultPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	if (!isClipEditingAvailable()) notFound();
	const { id } = await params;
	return <PortraitResult id={id} />;
}
