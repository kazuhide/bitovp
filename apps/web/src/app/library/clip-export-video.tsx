"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/context";
import type { EditingRenderView } from "@/lib/library-editing";
import { bindPassiveRequestUrl } from "@/lib/passive-request";

export function boundExportLinks(
	artifact: NonNullable<EditingRenderView["artifact"]>,
	organizationId: string | null | undefined,
) {
	if (!organizationId) return null;
	try {
		const base = `/api/library/artifacts/${artifact.id}`;
		const media = bindPassiveRequestUrl(`${base}/media`, organizationId);
		const download = bindPassiveRequestUrl(`${base}/download`, organizationId);
		return artifact.url === media && artifact.downloadUrl === download
			? { media, download }
			: null;
	} catch {
		return null;
	}
}

export function ClipExportVideo({
	src,
	title,
	inline = false,
}: {
	src: string;
	title: string;
	inline?: boolean;
}) {
	const { t } = useT();
	const [failed, setFailed] = useState(false);
	return (
		<div className="min-w-0 space-y-2">
			<video
				controls
				muted
				playsInline
				preload={inline ? "none" : "metadata"}
				src={src}
				aria-label={title}
				className={
					inline
						? "block aspect-video w-full rounded-md bg-black object-contain"
						: "mx-auto block max-h-[65vh] max-w-full rounded-md bg-black object-contain"
				}
				onError={() => setFailed(true)}
			/>
			{failed && (
				<p role="alert" className="text-amber-300 text-sm">
					{t("editing.autoPortrait.videoError")}
				</p>
			)}
		</div>
	);
}
