"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";

export function EncodingErrorDefinitionsLink({
	bitmovinAccountId,
}: {
	bitmovinAccountId: string | null | undefined;
}) {
	const { t } = useT();
	if (!bitmovinAccountId) return null;
	return (
		<Link
			href={`/settings/error-definitions?bitmovinAccountId=${encodeURIComponent(bitmovinAccountId)}`}
			className="inline-flex min-h-9 items-center rounded text-xs text-zinc-400 underline underline-offset-4 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500"
		>
			{t("errorDefinitions.lookup")}
		</Link>
	);
}
