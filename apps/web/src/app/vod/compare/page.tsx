import { Suspense } from "react";
import { localizedTitle } from "@/lib/i18n/metadata";
import { readPlayerClientConfig } from "@/lib/server/player-config";
import { OutputCompareClient } from "./output-compare-client";

export const generateMetadata = localizedTitle("outputCompare.title");

export default async function CompareOutputsPage() {
	const player = await readPlayerClientConfig();
	return (
		<Suspense fallback={null}>
			<OutputCompareClient player={player} />
		</Suspense>
	);
}
