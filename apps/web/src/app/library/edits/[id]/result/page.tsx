import { notFound } from "next/navigation";
import { z } from "zod";
import { localizedTitle } from "@/lib/i18n/metadata";
import { isClipEditingAvailable } from "@/lib/server/library-editing-feature";
import { PortraitResult } from "./portrait-result";
import { StoredClipResult } from "./stored-clip-result";

export const generateMetadata = localizedTitle(
	"editing.autoPortrait.resultTitle",
);
export default async function PortraitResultPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams?: Promise<{ exportId?: string | string[] }>;
}) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	if (query?.exportId !== undefined) {
		const exportId = z.uuid().safeParse(query.exportId);
		if (!exportId.success) notFound();
		return (
			<StoredClipResult
				id={id}
				exportId={exportId.data}
				clipEditingAvailable={await isClipEditingAvailable()}
			/>
		);
	}
	return (
		<PortraitResult
			id={id}
			clipEditingAvailable={await isClipEditingAvailable()}
		/>
	);
}
